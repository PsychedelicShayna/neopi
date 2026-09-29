#!/usr/bin/env bash
# Three panes on a private tmux socket. Pane 0's model is a local fake that
# answers with a ctl tool call. The tool types into pane 1. capture-pane must
# show that text. /live is attempted and its status line is recorded.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NPI=${NPI:-$ROOT/dist/npi}
LOG=${LOG:-/tmp/control-live.log}
if [[ ! -x $NPI ]] || ! command -v tmux >/dev/null || ! command -v bun >/dev/null; then
	echo "skip: need NPI, tmux, and bun" | tee "$LOG"
	exit 0
fi
DIR=$(mktemp -d)
PORT=$((18000 + RANDOM % 1000))
cat >"$DIR/fake.mjs" <<'JS'
const server = Bun.serve({
	port: Number(process.env.PORT),
	async fetch(req) {
		const body = await req.json().catch(() => ({}));
		const messages = Array.isArray(body.messages) ? body.messages : [];
		const last = messages.at(-1);
		const asked = JSON.stringify(last ?? "");
		const toolCall = asked.includes("DRIVE") || asked.includes("drive the other pane");
		const payload = toolCall
			? {
					id: "chatcmpl-fake",
					object: "chat.completion",
					choices: [{
						index: 0,
						finish_reason: "tool_calls",
						message: {
							role: "assistant",
							content: null,
							tool_calls: [{
								id: "call_ctl",
								type: "function",
								function: {
									name: "ctl",
									arguments: JSON.stringify({ op: "keys", target: "%1", text: "x" }),
								},
							}],
						},
					}],
				}
			: {
					id: "chatcmpl-fake",
					object: "chat.completion",
					choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "PONG" } }],
				};
		return Response.json(payload);
	},
});
console.log(`fake listening ${server.port}`);
JS
PORT=$PORT bun "$DIR/fake.mjs" >"$DIR/fake.log" 2>&1 &
FAKE=$!
trap 'kill $FAKE 2>/dev/null || true; tmux -L ctl-live kill-server 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do
	curl -sf -o /dev/null -X POST "http://127.0.0.1:$PORT/v1/chat/completions" -H 'content-type: application/json' -d '{}' && break
	sleep 0.1
done
cat >"$DIR/models.yml" <<EOF
providers:
  fake:
    baseUrl: http://127.0.0.1:$PORT/v1
    api: openai-completions
    apiKey: test
    models:
      - id: echo
        name: Echo
        api: openai-completions
        reasoning: false
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 8000
        maxTokens: 1000
EOF
cat >"$DIR/config.yml" <<'YAML'
setupVersion: 2
startup:
  setupWizard: false
  quiet: true
YAML
export PI_CODING_AGENT_DIR=$DIR
SOCK=ctl-live
tmux -L "$SOCK" kill-server 2>/dev/null || true
tmux -f /dev/null -L "$SOCK" new-session -d -x 200 -y 50 -s ctl
tmux -L "$SOCK" split-window -h
tmux -L "$SOCK" split-window -v -t ctl:0.0
tmux -L "$SOCK" send-keys -t ctl:0.0 "env PI_CODING_AGENT_DIR=$DIR $NPI --model fake/echo" Enter
tmux -L "$SOCK" send-keys -t ctl:0.1 "env PI_CODING_AGENT_DIR=$DIR $NPI --model fake/echo" Enter
tmux -L "$SOCK" send-keys -t ctl:0.2 "env PI_CODING_AGENT_DIR=$DIR $NPI --model fake/echo" Enter
for _ in $(seq 1 80); do
	if env PI_CODING_AGENT_DIR=$DIR "$NPI" ctl list --json 2>/dev/null | grep -q instanceId; then break; fi
	sleep 0.25
done
state=$(env PI_CODING_AGENT_DIR=$DIR "$NPI" ctl %0 rpc get_state '{}' || true)
echo "$state" | tee "$LOG.pre"
if ! grep -q '"provider": "fake"' "$LOG.pre"; then
	echo "fail: model.provider is not fake; refusing to send a turn" | tee "$LOG"
	exit 1
fi
# Ask pane 0's agent to drive pane 1. The fake model returns a ctl keys call.
env PI_CODING_AGENT_DIR=$DIR "$NPI" ctl %0 send "DRIVE the other pane" || true
env PI_CODING_AGENT_DIR=$DIR "$NPI" ctl %2 slash "/live" || true
sleep 2
{
	echo "=== list ==="
	env PI_CODING_AGENT_DIR=$DIR "$NPI" ctl list || true
	echo "=== pane 0 ==="
	tmux -L "$SOCK" capture-pane -p -t ctl:0.0 || true
	echo "=== pane 1 ==="
	tmux -L "$SOCK" capture-pane -p -t ctl:0.1 || true
	echo "=== pane 2 live ==="
	tmux -L "$SOCK" capture-pane -p -t ctl:0.2 || true
} | tee "$LOG"
echo "wrote $LOG"
