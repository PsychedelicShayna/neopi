/**
 * Contract (issue #109): chat mode switches on a live RPC session. The next
 * turn's system prompt, the tool set, `get_state.chatMode`, and the
 * `chat_mode_changed` event follow the switch, and a resumed session comes
 * back in the last mode.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { CURRENT_SESSION_VERSION } from "../src/session/session-entries";
import { type RpcFrame, RpcChild } from "./helpers/rpc-child";

const children: RpcChild[] = [];
const tempDirs: TempDir[] = [];

afterEach(async () => {
	await Promise.all(children.splice(0).map(child => child.dispose()));
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

async function spawn(args: string[] = [], root?: string): Promise<RpcChild> {
	const child = await RpcChild.spawn({ args, root });
	children.push(child);
	await child.waitFor(frame => frame.type === "ready");
	return child;
}

function data(response: RpcFrame): Record<string, unknown> {
	expect(response.success, JSON.stringify(response)).toBe(true);
	return response.data as Record<string, unknown>;
}

async function state(child: RpcChild): Promise<{ chatMode: unknown; systemPrompt: string[]; tools: string[] }> {
	const result = data(await child.request({ type: "get_state" }));
	return {
		chatMode: result.chatMode,
		systemPrompt: result.systemPrompt as string[],
		tools: (result.dumpTools as Array<{ name: string }>).map(tool => tool.name).sort(),
	};
}

/** A persisted session file holding only its header, so `--session` resumes it. */
async function sessionFile(): Promise<{ root: string; file: string }> {
	const dir = await TempDir.create("@rpc-chat-mode-");
	tempDirs.push(dir);
	const file = path.join(dir.path(), "sessions", "chat.jsonl");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "chat-mode-session",
		timestamp: new Date().toISOString(),
		cwd: dir.path(),
	};
	fs.writeFileSync(file, `${JSON.stringify(header)}\n`);
	return { root: dir.path(), file };
}

describe("RPC set_chat_mode", () => {
	it("advertises the capability and lists /chat", async () => {
		const child = await spawn();
		const ready = child.frames.find(frame => frame.type === "ready");
		expect(ready?.capabilities).toContain("set_chat_mode");
		const commands = data(await child.request({ type: "get_available_commands" })).commands as Array<{
			name: string;
			source: string;
		}>;
		expect(commands).toContainEqual(expect.objectContaining({ name: "chat", source: "builtin" }));
	}, 60_000);

	it("rebuilds the system prompt and tool set on every switch", async () => {
		const child = await spawn();
		const coding = await state(child);
		expect(coding.chatMode).toBe("off");
		expect(coding.tools.length).toBeGreaterThan(0);

		const erp = data(await child.request({ type: "set_chat_mode", mode: "erp", include: "date" }));
		expect(erp).toEqual({ mode: "erp", include: "date" });
		await child.waitFor(
			frame => frame.type === "chat_mode_changed" && frame.mode === "erp" && frame.include === "date",
		);
		const inErp = await state(child);
		expect(inErp.chatMode).toBe("erp");
		expect(inErp.systemPrompt).not.toEqual(coding.systemPrompt);
		expect(inErp.tools).toEqual([]);

		// Raw mode with no prompt flags sends no system prompt; includes carry over.
		const raw = data(await child.request({ type: "set_chat_mode", mode: "raw" }));
		expect(raw).toEqual({ mode: "raw", include: "date" });
		expect((await state(child)).systemPrompt).toEqual([]);

		const off = data(await child.request({ type: "set_chat_mode", mode: "off" }));
		expect(off).toEqual({ mode: "off", include: "" });
		const restored = await state(child);
		expect(restored.chatMode).toBe("off");
		expect(restored.systemPrompt).toEqual(coding.systemPrompt);
		expect(restored.tools).toEqual(coding.tools);
	}, 60_000);

	it("toggles through the /chat prompt path between off and the last-used mode", async () => {
		const child = await spawn();
		await child.request({ type: "set_chat_mode", mode: "erp" });
		await child.request({ type: "prompt", message: "/chat" });
		expect((await state(child)).chatMode).toBe("off");
		await child.request({ type: "prompt", message: "/chat" });
		expect((await state(child)).chatMode).toBe("erp");
		await child.request({ type: "prompt", message: "/chat raw --include cwd,date" });
		const changes = child.frames.filter(frame => frame.type === "chat_mode_changed");
		expect(changes.map(frame => frame.mode)).toEqual(["erp", "off", "erp", "raw"]);
		expect(changes.at(-1)).toMatchObject({ mode: "raw", include: "cwd,date" });
	}, 60_000);

	it("rejects invalid modes, includes, and include without a chat mode", async () => {
		const child = await spawn();
		for (const command of [
			{ type: "set_chat_mode", mode: "roleplay" },
			{ type: "set_chat_mode", mode: "chat", include: "tools" },
			{ type: "set_chat_mode", mode: "off", include: "date" },
		]) {
			const response = await child.request(command);
			expect(response.success, JSON.stringify(response)).toBe(false);
		}
		expect((await state(child)).chatMode).toBe("off");
		expect(child.frames.some(frame => frame.type === "chat_mode_changed")).toBe(false);
	}, 60_000);

	it("keeps chat mode unavailable with --system-prompt-template", async () => {
		const { root } = await sessionFile();
		const template = path.join(root, "template.md");
		fs.writeFileSync(template, "custom template\n");
		const child = await spawn(["--system-prompt-template", template]);
		const response = await child.request({ type: "set_chat_mode", mode: "chat" });
		expect(response.success).toBe(false);
		expect(String(response.error)).toContain("--system-prompt-template");
	}, 60_000);

	it("restores the last chat mode when the session is resumed", async () => {
		const { root, file } = await sessionFile();
		const first = await spawn(["--session", file], root);
		data(await first.request({ type: "set_chat_mode", mode: "erp", include: "cwd" }));
		children.splice(children.indexOf(first), 1);
		await first.dispose();

		const resumed = await spawn(["--session", file], root);
		expect((await state(resumed)).chatMode).toBe("erp");
		// The restored include set comes back too: switching mode keeps it.
		expect(data(await resumed.request({ type: "set_chat_mode", mode: "chat" }))).toEqual({
			mode: "chat",
			include: "cwd",
		});
	}, 60_000);
});
