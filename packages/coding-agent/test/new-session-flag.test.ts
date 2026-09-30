/**
 * `--new-session` (#107): a host can demand a fresh session in the default
 * per-cwd directory even when the user enabled `autoResume`, and protocol
 * modes never auto-resume.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Args, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { CliUsageError } from "@oh-my-pi/pi-coding-agent/cli/usage-error";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { RpcChild } from "./helpers/rpc-child";
import { makeAssistantMessage } from "./session-manager/helpers";

describe("--new-session argument parsing", () => {
	it.each([
		[["--new-session", "--continue"], "--continue"],
		[["--new-session", "-c"], "--continue"],
		[["--new-session", "--resume", "abc"], "--resume/--session"],
		[["--new-session", "--resume"], "--resume/--session"],
		[["--session", "abc", "--new-session"], "--resume/--session"],
		[["--new-session", "--fork", "abc"], "--fork"],
	])("rejects %p", (argv, conflict) => {
		expect(() => parseArgs(argv)).toThrow(CliUsageError);
		expect(() => parseArgs(argv)).toThrow(`--new-session cannot be combined with ${conflict}`);
	});

	it("combines with --session-dir", () => {
		const parsed = parseArgs(["--new-session", "--session-dir", "/tmp/threads"]);
		expect(parsed.newSession).toBe(true);
		expect(parsed.sessionDir).toBe("/tmp/threads");
	});
});

/** Seed one answered session in the default session directory for `cwd`. */
async function seedPriorSession(cwd: string, agentDir: string): Promise<string> {
	const manager = SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir));
	manager.appendMessage({ role: "user", content: "earlier question", timestamp: Date.now() });
	manager.appendMessage(makeAssistantMessage());
	await manager.close();
	const file = manager.getSessionFile();
	if (!file || !fs.existsSync(file)) throw new Error("seed session was not persisted");
	return file;
}

function launchArgs(overrides: Partial<Args>): Args {
	return { messages: [], fileArgs: [], unknownFlags: new Map(), unrecognizedFlags: [], invalidFlagValues: [], ...overrides };
}

describe("autoResume versus --new-session and protocol modes", () => {
	let tempDir: TempDir;
	let agentDir: string;
	let project: string;
	let priorFile: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		tempDir = await TempDir.create("@new-session-flag-");
		agentDir = path.join(tempDir.path(), "agent");
		project = path.join(tempDir.path(), "project");
		fs.mkdirSync(project, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "config.yml"), "autoResume: true\n");
		setAgentDir(agentDir);
		priorFile = await seedPriorSession(project, agentDir);
	});

	afterEach(async () => {
		if (originalAgentDir) setAgentDir(originalAgentDir);
		else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await tempDir.remove();
	});

	it("interactive launch without flags still resumes the prior session", async () => {
		const parsed = launchArgs({});
		const manager = await createSessionManager(parsed, project, Settings.isolated({ autoResume: true }));
		expect(manager?.getSessionFile()).toBe(priorFile);
		expect(parsed.continue).toBe(true);
		await manager?.close();
	});

	it.each([
		["--new-session", launchArgs({ newSession: true })],
		["--mode rpc", launchArgs({ mode: "rpc" })],
		["--mode rpc-ui", launchArgs({ mode: "rpc-ui" })],
		["--mode acp", launchArgs({ mode: "acp" })],
	])("%s leaves autoResume unapplied", async (_label, parsed) => {
		const manager = await createSessionManager(parsed, project, Settings.isolated({ autoResume: true }));
		// No manager means the SDK creates a fresh session in the default directory.
		expect(manager).toBeUndefined();
		expect(parsed.continue).toBeUndefined();
	});

	it("flagless RPC launch and --new-session start an empty session beside the prior one", async () => {
		for (const extra of [[], ["--new-session"]]) {
			const child = await RpcChild.spawn({ root: tempDir.path(), args: ["--cwd", project, ...extra] });
			try {
				const ready = await child.waitFor(frame => frame.type === "ready");
				expect(ready.capabilities).toContain("new_session");
				const state = await child.request({ type: "get_state" });
				expect(state.success).toBe(true);
				const data = state.data as { sessionFile: string; messageCount: number };
				expect(data.messageCount).toBe(0);
				expect(data.sessionFile).not.toBe(priorFile);
				expect(path.dirname(data.sessionFile)).toBe(path.dirname(priorFile));
			} finally {
				await child.dispose();
			}
		}
	}, 60_000);

	it("--new-session --session-dir creates the session in that directory", async () => {
		const threadDir = path.join(tempDir.path(), "threads", "t1");
		const child = await RpcChild.spawn({
			root: tempDir.path(),
			args: ["--cwd", project, "--new-session", "--session-dir", threadDir],
		});
		try {
			const state = await child.request({ type: "get_state" });
			const data = state.data as { sessionFile: string; messageCount: number };
			expect(data.messageCount).toBe(0);
			expect(path.dirname(data.sessionFile)).toBe(threadDir);
		} finally {
			await child.dispose();
		}
	}, 30_000);
});
