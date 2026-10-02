/**
 * Parity sweep driver (#171). Run by control-parity.sh against one live pane
 * whose model is the local fake. Every call goes through the installed
 * `npi ctl` CLI, so the binary under test serves both ends.
 *
 * Gates, each reported as passed/total:
 * - rpc: every RpcCommand type answered by its own arm with success, or with
 *   the one documented refusal listed for it.
 * - side channels: every reply frame type is routed (not `Unknown command`).
 * - control: every control-only command routes to an implementation.
 * - slash: every builtin slash name and alias is listed by the pane's `commands`.
 * - actions: every keybinding id is handled, or refused with a documented exemption.
 *
 * Usage: bun control-parity.ts <npi> <instanceId> <log>
 */
import { appendFileSync } from "node:fs";
import { RPC_COMMAND_TYPES } from "../../src/control/parity";

const [npi, target, log] = process.argv.slice(2);
if (!npi || !target || !log) throw new Error("usage: control-parity.ts <npi> <instanceId> <log>");

type Reply = { success?: boolean; error?: string; code?: string; data?: unknown };

function record(line: string): void {
	appendFileSync(log, `${line}\n`);
}

async function call(type: string, params: Record<string, unknown> = {}): Promise<Reply> {
	const proc = Bun.spawn([npi, "ctl", target, "rpc", type, JSON.stringify(params)], {
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	const start = out.indexOf("{");
	try {
		return JSON.parse(out.slice(start)) as Reply;
	} catch {
		return { success: false, error: `no reply: ${err.trim() || out.trim()}`, code: "no_reply" };
	}
}

async function waitSettled(): Promise<void> {
	await call("wait", { for: "settled", timeoutMs: 60_000 });
}

function unrouted(reply: Reply): boolean {
	return (reply.error ?? "").includes("Unknown command") || reply.code === "no_reply";
}

let failed = false;
function gate(name: string, passed: number, total: number): void {
	const line = `${name} ${passed}/${total}`;
	console.log(line);
	record(`GATE ${line}`);
	if (passed !== total) failed = true;
}

// ---------------------------------------------------------------- rpc
const state = (await call("get_state")).data as { sessionFile?: string; model?: { provider?: string } } | undefined;
if (state?.model?.provider !== "fake") throw new Error("pane is not on the fake provider; refusing to prompt");

/** Documented refusals: the command routed and answered with its specified code or error. */
const refusal: Record<string, RegExp> = {
	set_approval_handler: /approval_owner_only/,
	set_subagent_subscription: /Subagent event bus is unavailable/i,
	get_subagents: /subagent_bus_unavailable/,
	get_subagent_messages: /Subagent event bus is unavailable/i,
	cancel_subagent: /Subagent event bus is unavailable/i,
	steer_subagent: /Subagent event bus is unavailable/i,
	set_ask_dialog: /Ask-dialog negotiation is unavailable on this transport/,
	compact: /Nothing to compact/i,
	handoff: /Nothing to hand off/i,
	login: /provider|unknown|not/i,
	open_session: /session|not found|no such|ENOENT/i,
	create_mixture: /scope must be project or user/,
	select_mixture: /is not registered in this workspace/,
};

const fixtures: Record<string, () => Promise<Record<string, unknown>>> = {
	negotiate_protocol: async () => ({ protocolVersion: 2 }),
	prompt: async () => ({ message: "PING" }),
	steer: async () => ({ message: "steer PING" }),
	remove_queued_message: async () => ({ message: "parity-none", queue: "steering" }),
	promote_queued_message: async () => ({ message: "parity-none" }),
	follow_up: async () => ({ message: "follow-up PING" }),
	abort_and_prompt: async () => ({ message: "again PING" }),
	set_fast_mode: async () => ({ enabled: false }),
	set_ask_dialog: async () => ({ enabled: false }),
	set_chat_mode: async () => ({ mode: "off" }),
	set_mode: async () => ({ mode: "default" }),
	set_todos: async () => ({ phases: [] }),
	set_host_tools: async () => ({ tools: [] }),
	set_host_uri_schemes: async () => ({ schemes: [] }),
	set_subagent_subscription: async () => ({ level: "off" }),
	set_event_filter: async () => ({ events: null }),
	set_approval_handler: async () => ({ handler: "host" }),
	get_subagent_messages: async () => ({ subagentId: "parity-none" }),
	cancel_subagent: async () => ({ subagentId: "parity-none" }),
	steer_subagent: async () => ({ subagentId: "parity-none", message: "parity steer" }),
	set_model: async () => ({ provider: "fake", modelId: "echo-2" }),
	create_mixture: async () => ({ scope: "parity-invalid", definition: {} }),
	select_mixture: async () => ({ name: "parity-no-such-mixture" }),
	set_role: async () => ({ role: "default" }),
	set_thinking_level: async () => ({ level: "off" }),
	set_steering_mode: async () => ({ mode: "one-at-a-time" }),
	set_follow_up_mode: async () => ({ mode: "one-at-a-time" }),
	set_interrupt_mode: async () => ({ mode: "immediate" }),
	set_auto_compaction: async () => ({ enabled: false }),
	set_auto_retry: async () => ({ enabled: false }),
	compact: async () => ({}),
	bash: async () => ({ command: "echo parity-bash" }),
	get_usage: async () => ({ redact: true }),
	export_html: async () => ({ outputPath: `${process.env.PARITY_DIR ?? "/tmp"}/parity-export.html` }),
	switch_session: async () => ({ sessionPath: state?.sessionFile ?? "" }),
	branch: async () => {
		const entries = (await call("get_entries")).data as {
			entries?: { id: string; type: string; message?: { role?: string } }[];
		};
		const user = entries?.entries?.find(entry => entry.type === "message" && entry.message?.role === "user");
		return { entryId: user?.id ?? "" };
	},
	set_session_name: async () => ({ name: "parity" }),
	handoff: async () => ({}),
	get_messages_page: async () => ({ limit: 5 }),
	open_session: async () => ({ sessionDir: `${process.env.PARITY_DIR}/missing-session` }),
	login: async () => ({ providerId: "parity-no-such-provider" }),
	predict_word: async () => ({ text: "", cursor: 0 }),
	predict_word_feedback: async () => ({ text: "", cursor: 0, suggestion: "", accepted: false }),
};

// Replace sessions only after all operations that read the active transcript.
const late = new Set(["branch", "switch_session", "new_session", "open_session", "login"]);
const ordered = [
	...RPC_COMMAND_TYPES.filter(type => !late.has(type)),
	"branch",
	"switch_session",
	"new_session",
	"open_session",
	"login",
];
let rpcPassed = 0;
for (const type of ordered) {
	const params = (await fixtures[type]?.()) ?? {};
	const reply = await call(type, params);
	const expected = refusal[type];
	const ok =
		!unrouted(reply) &&
		(expected
			? reply.success === true || expected.test(`${reply.code ?? ""} ${reply.error ?? ""}`)
			: reply.success === true);
	if (ok) rpcPassed++;
	record(`rpc ${ok ? "ok" : "FAIL"} ${type} ${JSON.stringify(reply).slice(0, 400)}`);
	if (
		type === "prompt" ||
		type === "steer" ||
		type === "follow_up" ||
		type === "abort_and_prompt" ||
		type === "compact" ||
		type === "handoff" ||
		type === "bash"
	) {
		await waitSettled();
	}
}
gate("rpc", rpcPassed, RPC_COMMAND_TYPES.length);

// ---------------------------------------------------------------- side channels
const sideChannels = [
	"host_tool_result",
	"host_tool_update",
	"host_uri_result",
	"tool_approval_response",
	"plan_proposal_response",
	"extension_ui_response",
];
let sidePassed = 0;
for (const type of sideChannels) {
	const reply = await call(type, { id: "parity-none", result: { content: [] }, partialResult: { content: [] } });
	const ok = !unrouted(reply);
	if (ok) sidePassed++;
	record(`side ${ok ? "ok" : "FAIL"} ${type} ${JSON.stringify(reply).slice(0, 200)}`);
}
gate("side_channels", sidePassed, sideChannels.length);

// ---------------------------------------------------------------- control-only
const controlOnly: [string, Record<string, unknown>][] = [
	["get_status", {}],
	["state", {}],
	["subscribe", { events: "none" }],
	["screen", {}],
	["dialogs", {}],
	["draft_get", {}],
	["draft_set", { text: "", if: { draft: -1 } }],
	["draft_insert", { text: "", if: { draft: -1 } }],
	["draft_clear", { if: { draft: -1 } }],
	["dequeue", {}],
	["requests", {}],
	["wait", { for: "settled", timeoutMs: 1000 }],
	["commands", {}],
	["settings_get", { path: "control.approvals" }],
	["keybindings_get", {}],
	["agents", { op: "list" }],
	["switch_model", { selector: "fake/echo" }],
	["cycle_role_model", {}],
	["rewind", { entryId: "parity-none" }],
	["todo_set", { phases: [] }],
	["repl_execute", { code: "1+1", target: "js" }],
	["esc", {}],
	["serve", { tools: [] }],
	["unserve", {}],
	["dialog_answer", { dialogId: "parity-none", answer: 0 }],
	["keys", { keys: [] }],
	["paste", { text: "" }],
	["mouse", { x: 0, y: 0, action: "move" }],
	["input", { text: "PING" }],
	["slash", { text: "/hotkeys" }],
	["action", { actionId: "app.suspend" }],
];
let controlPassed = 0;
for (const [type, params] of controlOnly) {
	const reply = await call(type, params);
	const ok = !unrouted(reply);
	if (ok) controlPassed++;
	record(`control ${ok ? "ok" : "FAIL"} ${type} ${JSON.stringify(reply).slice(0, 200)}`);
	if (type === "input" || type === "slash") {
		await waitSettled();
		await call("esc");
	}
}
gate("control", controlPassed, controlOnly.length);

// ---------------------------------------------------------------- slash
const { BUILTIN_SLASH_COMMANDS_INTERNAL } = await import("../../src/slash-commands/builtin-registry");
const expectedSlash = BUILTIN_SLASH_COMMANDS_INTERNAL.flatMap(spec => [spec.name, ...(spec.aliases ?? [])]);
const listed = (await call("commands")).data as { commands?: { name: string; aliases?: string[] }[] };
const listedNames = new Set((listed?.commands ?? []).flatMap(command => [command.name, ...(command.aliases ?? [])]));
let slashPassed = 0;
for (const name of expectedSlash) {
	const ok = listedNames.has(name);
	if (ok) slashPassed++;
	else record(`slash FAIL /${name} not listed by the pane`);
}
record(
	`slash builtins=${BUILTIN_SLASH_COMMANDS_INTERNAL.length} aliases=${expectedSlash.length - BUILTIN_SLASH_COMMANDS_INTERNAL.length}`,
);
gate("slash", slashPassed, expectedSlash.length);

// ---------------------------------------------------------------- actions
const bindings = (await call("keybindings_get")).data as { bindings?: Record<string, string[]> };
const ids = Object.keys(bindings?.bindings ?? {});
// Actions that end or replace the pane run last, so every other id is exercised against a live pane.
const terminal = /(^app\.(exit|quit|suspend|restart|interrupt|clear)$)|session\.new/;
const actionOrder = [...ids.filter(id => !terminal.test(id)), ...ids.filter(id => terminal.test(id))];
let actionPassed = 0;
for (const id of actionOrder) {
	const reply = await call("action", { actionId: id });
	const ok = !unrouted(reply) && (reply.success === true || /^exempt_/.test(reply.code ?? ""));
	if (ok) actionPassed++;
	record(`action ${ok ? "ok" : "FAIL"} ${id} ${JSON.stringify(reply).slice(0, 200)}`);
	// Close whatever the action opened so the next one starts from the editor.
	if (!terminal.test(id)) await call("esc");
}
gate("actions", actionPassed, ids.length);

process.exit(failed ? 1 : 0);
