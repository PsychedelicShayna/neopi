/** Local-only provider and gated bash child for interactive-mode.test.ts. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";

const chatRequestSchema = type({
	"messages?": type({ role: "string", "content?": "unknown" }).array(),
	"tools?": type({ "function?": { "name?": "string" } }).array(),
	"stream?": "boolean",
});
type ChatRequest = typeof chatRequestSchema.infer;
type Reply =
	| { text: string }
	| { tool: "bash"; args: { command: string; timeout: number } }
	| { tool: "read"; args: { path: string } };

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const base = { id: "chatcmpl-viewer", created: 0, model: "fake-model" };

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join("");
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function scriptedReply(request: ChatRequest, gates: string): Reply {
	const last = request.messages?.at(-1);
	if (last?.role === "tool") return { text: "The requested tool completed." };
	const text = last?.role === "user" ? messageText(last.content) : "";
	const label = text.includes("run_tool_live")
		? "viewer-live-card"
		: text.includes("run_tool_late")
			? "viewer-late-card"
			: undefined;
	if (label) {
		if (!request.tools?.some(tool => tool.function?.name === "bash")) throw new Error("bash was not offered");
		return {
			tool: "bash",
			args: {
				command: [process.execPath, "viewer-tool.ts", "--tool", path.relative(process.cwd(), gates), label]
					.map(quote)
					.join(" "),
				timeout: 120,
			},
		};
	}
	if (text.includes("run_extension_read")) {
		if (!request.tools?.some(tool => tool.function?.name === "read")) throw new Error("read was not offered");
		return { tool: "read", args: { path: "viewer-extension-input.txt" } };
	}
	if (text.includes("stream_reply")) return { text: "live-first-chunk live-final-chunk" };
	if (text.includes("seed_history")) return { text: "prior-history-reply" };
	throw new Error(`unexpected fixture prompt: ${text}`);
}

function completionChunks(reply: Reply): object[] {
	const delta =
		"text" in reply
			? { role: "assistant", content: reply.text }
			: {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id:
								reply.tool === "read"
									? "call_extension_read"
									: `call_${reply.args.command.includes("viewer-late-card") ? "late" : "live"}`,
							type: "function",
							function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
						},
					],
				};
	return [
		{ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
		{
			...base,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "text" in reply ? "stop" : "tool_calls" }],
		},
		{ ...base, object: "chat.completion.chunk", choices: [], usage },
	];
}

async function waitForRelease(file: string): Promise<void> {
	const deadline = Date.now() + 120_000;
	while (!(await Bun.file(file).exists())) {
		if (Date.now() > deadline) throw new Error(`fixture gate was not released: ${file}`);
		await Bun.sleep(25);
	}
}

function gatedStream(gates: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const chunk = (content: string) => ({
		...base,
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
	});
	return new ReadableStream({
		async start(controller) {
			const send = (event: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			try {
				send(chunk("live-first-chunk"));
				await waitForRelease(path.join(gates, "stream.release"));
				send(chunk(" live-final-chunk"));
				send({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
				send({ ...base, object: "chat.completion.chunk", choices: [], usage });
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
	});
}

async function runTool(gates: string, label: string): Promise<void> {
	await Bun.write(path.join(gates, `${label}.pid`), String(process.pid));
	try {
		await Bun.write(path.join(gates, `${label}.started`), "started");
		process.stdout.write(`${label}-started-output\n`);
		await waitForRelease(path.join(gates, `${label}.release`));
		process.stdout.write(`${label}-finished-output\n`);
	} finally {
		await fs.rm(path.join(gates, `${label}.pid`), { force: true });
	}
}

async function runProvider(agentDir: string, gates: string): Promise<void> {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/models")) {
				return Response.json({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] });
			}
			if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
			const body = chatRequestSchema.assert(await request.json());
			const reply = scriptedReply(body, gates);
			if (!body.stream) throw new Error("viewer fixture requires streaming completions");
			const last = body.messages?.at(-1);
			if (last?.role === "user" && messageText(last.content).includes("stream_reply")) {
				return new Response(gatedStream(gates), { headers: { "content-type": "text/event-stream" } });
			}
			const events = completionChunks(reply).map(chunk => `data: ${JSON.stringify(chunk)}\n\n`);
			return new Response(`${events.join("")}data: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	await Bun.write(
		path.join(agentDir, "models.yml"),
		[
			"providers:",
			"  fake:",
			`    baseUrl: http://127.0.0.1:${server.port}/v1`,
			"    auth: none",
			"    api: openai-completions",
			"    models:",
			"      - id: fake-model",
			"        name: Viewer Fixture Model",
			"        reasoning: false",
			"",
		].join("\n"),
	);
	console.log(`READY ${server.port}`);
	try {
		for await (const _ of Bun.stdin.stream()) {
			// Keep the provider alive only while its test owns stdin.
		}
	} finally {
		server.stop(true);
	}
}

const [mode, directory, label] = process.argv.slice(2);
if (!mode || !directory) throw new Error("expected <agentDir> <gates> or --tool <gates> <label>");
if (mode === "--tool") {
	if (!label) throw new Error("missing tool label");
	await runTool(directory, label);
} else {
	await runProvider(mode, directory);
}
