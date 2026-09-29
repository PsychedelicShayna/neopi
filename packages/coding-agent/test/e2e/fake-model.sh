# Shared by the control e2e scripts. Source it, then call `start_fake_model DIR`.
# It starts a local OpenAI-compatible fake on a random port and writes
# DIR/models.yml (provider `fake`, models `echo` and `echo-2`) and DIR/config.yml.
# No real model is ever contacted: every pane launched with
# PI_CODING_AGENT_DIR=DIR and --model fake/echo talks to this server.
#
# The fake answers a message containing DRIVE with one streamed `ctl keys` tool
# call per target in FAKE_DRIVE_TARGETS (comma-separated selectors, default %1):
# x into the first, y into the second. Anything else gets the text PONG.

start_fake_model() {
	local dir=$1
	FAKE_PORT=$((18000 + RANDOM % 1000))
	cat >"$dir/fake.mjs" <<'JS'
// Each DRIVE turn types one letter into each target pane: x into the first, y into the second.
const targets = (process.env.FAKE_DRIVE_TARGETS || "%1").split(",");
const server = Bun.serve({
	port: Number(process.env.PORT),
	async fetch(req) {
		const body = await req.json().catch(() => ({}));
		const messages = Array.isArray(body.messages) ? body.messages : [];
		const asked = JSON.stringify(messages.at(-1) ?? "");
		const toolCall = asked.includes("DRIVE");
		console.log("request", req.url, "stream", body.stream, "tool", toolCall);
		const calls = targets.map((target, index) => ({
			index,
			id: `call_ctl_${index}`,
			args: JSON.stringify({ op: "keys", target, text: String.fromCharCode(120 + index) }),
		}));
		const chunks = toolCall
			? [
					...calls.flatMap(call => [
						{ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: call.index, id: call.id, type: "function", function: { name: "ctl", arguments: "" } }] } }] },
						{ choices: [{ index: 0, delta: { tool_calls: [{ index: call.index, function: { arguments: call.args } }] } }] },
					]),
					{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
			: [
					{ choices: [{ index: 0, delta: { role: "assistant", content: "PONG" } }] },
					{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				];
		if (body.stream) {
			const lines =
				chunks.map(chunk => `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", ...chunk })}\n\n`).join("") +
				"data: [DONE]\n\n";
			return new Response(lines, { headers: { "content-type": "text/event-stream" } });
		}
		const message = toolCall
			? { role: "assistant", content: null, tool_calls: calls.map(call => ({ id: call.id, type: "function", function: { name: "ctl", arguments: call.args } })) }
			: { role: "assistant", content: "PONG" };
		return Response.json({ id: "chatcmpl-fake", object: "chat.completion", choices: [{ index: 0, finish_reason: toolCall ? "tool_calls" : "stop", message }] });
	},
});
console.log(`fake listening ${server.port}`);
JS
	PORT=$FAKE_PORT bun "$dir/fake.mjs" >"$dir/fake.log" 2>&1 &
	FAKE_PID=$!
	for _ in $(seq 1 40); do
		curl -sf -o /dev/null -X POST "http://127.0.0.1:$FAKE_PORT/v1/chat/completions" -H 'content-type: application/json' -d '{}' && break
		sleep 0.1
	done
	cat >"$dir/models.yml" <<EOF
providers:
  fake:
    baseUrl: http://127.0.0.1:$FAKE_PORT/v1
    api: openai-completions
    apiKey: test
    models:
      - id: echo
        name: Echo
        api: openai-completions
        reasoning: false
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 200000
        maxTokens: 1000
      - id: echo-2
        name: Echo 2
        api: openai-completions
        reasoning: false
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 200000
        maxTokens: 1000
EOF
	cat >"$dir/config.yml" <<'YAML'
setupVersion: 2
startup:
  setupWizard: false
  quiet: true
YAML
}

# Refuse to continue unless the pane reports the fake provider.
require_fake_provider() {
	local state_file=$1
	if ! grep -q '"provider": "fake"' "$state_file"; then
		echo "FAIL pane is not on the fake provider; refusing to send prompts" >&2
		cat "$state_file" >&2
		return 1
	fi
}
