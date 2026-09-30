/**
 * Lifetime session lease (#106): a session file open in one live process
 * cannot be opened for writing by another, the kernel frees it when the holder
 * dies (SIGKILL included), and read-only consumers never need it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { exportFromFile } from "@oh-my-pi/pi-coding-agent/export/html";
import { createSessionManager, type SessionInUseChoice } from "@oh-my-pi/pi-coding-agent/main";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionInUseError } from "@oh-my-pi/pi-coding-agent/session/session-lease";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { findMostRecentNonEmptySession } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { RpcChild } from "../helpers/rpc-child";
import { makeAssistantMessage } from "../session-manager/helpers";

async function seedSession(cwd: string, dir: string, question: string): Promise<{ file: string; id: string }> {
	const manager = SessionManager.create(cwd, dir);
	manager.appendMessage({ role: "user", content: question, timestamp: Date.now() });
	manager.appendMessage(makeAssistantMessage());
	await manager.close();
	const file = manager.getSessionFile();
	if (!file || !fs.existsSync(file)) throw new Error("seed session was not persisted");
	return { file, id: manager.getSessionId() };
}

/** A separate process holding the lease on `file` through `SessionManager.open`. */
class LeaseHolder {
	readonly process: Bun.Subprocess<"ignore", "pipe", "pipe">;

	private constructor(proc: Bun.Subprocess<"ignore", "pipe", "pipe">) {
		this.process = proc;
	}

	static async start(file: string, agentDir: string): Promise<LeaseHolder> {
		const proc = Bun.spawn(["bun", path.join(import.meta.dir, "fixtures", "hold-session-lease.ts"), file], {
			env: { ...Bun.env, PI_CODING_AGENT_DIR: agentDir },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const decoder = new TextDecoder();
		let output = "";
		for await (const chunk of proc.stdout) {
			output += decoder.decode(chunk, { stream: true });
			if (output.includes("held\n")) return new LeaseHolder(proc);
		}
		throw new Error(`lease holder exited before holding: ${await new Response(proc.stderr).text()}`);
	}

	get pid(): number {
		return this.process.pid;
	}

	async kill(): Promise<void> {
		this.process.kill("SIGKILL");
		await this.process.exited;
	}
}

function resumeArgs(resume: string, sessionDir: string): Args {
	return { resume, sessionDir, messages: [], fileArgs: [], unknownFlags: new Map(), unrecognizedFlags: [], invalidFlagValues: [] };
}

describe("session lifetime lease", () => {
	let tempDir: TempDir;
	let agentDir: string;
	let cwd: string;
	let dir: string;
	let older: { file: string; id: string };
	let leased: { file: string; id: string };
	let holder: LeaseHolder | undefined;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		tempDir = await TempDir.create("@session-lease-");
		agentDir = path.join(tempDir.path(), "agent");
		cwd = path.join(tempDir.path(), "project");
		dir = path.join(tempDir.path(), "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		setAgentDir(agentDir);
		older = await seedSession(cwd, dir, "older question");
		// Distinct mtimes so "most recent" is unambiguous.
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(older.file, past, past);
		leased = await seedSession(cwd, dir, "leased question");
		holder = await LeaseHolder.start(leased.file, agentDir);
	});

	afterEach(async () => {
		await holder?.kill();
		holder = undefined;
		if (originalAgentDir) setAgentDir(originalAgentDir);
		else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await tempDir.remove();
	});

	it("rejects a second opener with the holder pid, then opens once SIGKILL frees it", async () => {
		const rejection = await SessionManager.open(leased.file).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(rejection).toBeInstanceOf(SessionInUseError);
		expect((rejection as SessionInUseError).pid).toBe(holder!.pid);
		expect((rejection as SessionInUseError).since).toBeGreaterThan(0);

		await holder!.kill();
		holder = undefined;

		const reopened = await SessionManager.open(leased.file);
		expect(reopened.getSessionId()).toBe(leased.id);
		await reopened.close();
	}, 30_000);

	it("listing reports inUse.pid for the leased file only", async () => {
		const sessions = await SessionManager.list(cwd, dir);
		const byPath = new Map(sessions.map(session => [session.path, session]));
		expect(byPath.get(leased.file)?.inUse).toEqual({ pid: holder!.pid });
		expect(byPath.get(older.file)?.inUse).toBeUndefined();

		await holder!.kill();
		holder = undefined;
		const afterExit = await SessionManager.list(cwd, dir);
		expect(afterExit.find(session => session.path === leased.file)?.inUse).toBeUndefined();
	}, 30_000);

	it("read-only loaders open the leased file without the lease", async () => {
		const loaded = await loadSessionFile(leased.file);
		expect(loaded.entries.length).toBeGreaterThan(1);

		const readOnly = await SessionManager.openReadOnly(leased.file);
		expect(readOnly.getSessionFile()).toBeUndefined();
		expect(readOnly.getSessionId()).toBe(leased.id);
		expect(readOnly.getEntries().filter(entry => entry.type === "message")).toHaveLength(2);

		const fork = await SessionManager.forkFrom(leased.file, cwd, dir);
		expect(fork.getSessionFile()).not.toBe(leased.file);
		expect(fork.getHeader()?.parentSession).toBe(leased.id);
		await fork.close();

		const exported = await exportFromFile(leased.file, path.join(tempDir.path(), "leased.html"));
		expect(fs.existsSync(exported)).toBe(true);
	}, 30_000);

	it("--continue skips the leased newest session and resumes the next one", async () => {
		const manager = await SessionManager.continueRecent(cwd, dir);
		expect(manager.getSessionFile()).toBe(older.file);
		await manager.close();
	}, 30_000);

	it("managers in one process share the lease", async () => {
		await holder!.kill();
		holder = undefined;
		const first = await SessionManager.open(leased.file);
		const second = await SessionManager.open(leased.file);
		expect(second.getSessionId()).toBe(leased.id);
		await second.close();
		await first.close();
	}, 30_000);

	it("a rejected strict open leaves the file acquirable by another process", async () => {
		// Persisted-task revival opens with throwIfMissing; an empty (truncated)
		// transcript is rejected and no manager is returned.
		const empty = path.join(dir, "empty.jsonl");
		fs.writeFileSync(empty, "");
		await expect(SessionManager.open(empty, undefined, undefined, { throwIfMissing: true })).rejects.toThrow(
			"holds no entries",
		);
		const other = await LeaseHolder.start(empty, agentDir);
		await other.kill();

		const missing = path.join(dir, "missing.jsonl");
		await expect(SessionManager.open(missing, undefined, undefined, { throwIfMissing: true })).rejects.toThrow();
		const second = await LeaseHolder.start(missing, agentDir);
		await second.kill();
	}, 30_000);

	/** Whether a separate process can take the lease on `file` right now. */
	async function anotherProcessCanTake(file: string): Promise<boolean> {
		let probe: LeaseHolder;
		try {
			probe = await LeaseHolder.start(file, agentDir);
		} catch (error) {
			if (String(error).includes("SessionInUseError")) return false;
			throw error;
		}
		await probe.kill();
		return true;
	}

	it("a symlinked alias of a leased file shares its lease", async () => {
		const aliasDir = path.join(tempDir.path(), "aliases");
		fs.mkdirSync(aliasDir);
		const alias = path.join(aliasDir, "alias.jsonl");
		fs.symlinkSync(leased.file, alias);

		const rejection = await SessionManager.open(alias).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(rejection).toBeInstanceOf(SessionInUseError);
		expect((rejection as SessionInUseError).pid).toBe(holder!.pid);
	}, 30_000);

	it("a holder that could not write its record is still reported in use", async () => {
		// The degraded holder state: gate held, no `.lease` record (unwritable or full directory).
		fs.rmSync(path.join(dir, `.${path.basename(leased.file)}.lease`));

		const sessions = await SessionManager.list(cwd, dir);
		expect(sessions.find(session => session.path === leased.file)?.inUse).toEqual({ pid: 0 });
		// Newest-session selection (--continue, open_session) moves on to the free one.
		expect(await findMostRecentNonEmptySession(dir)).toBe(older.file);
	}, 30_000);

	it("a rollback that cannot reacquire its file stops writing and reports the loss", async () => {
		const manager = await SessionManager.open(older.file);
		const failures: Error[] = [];
		manager.onPersistenceError(error => failures.push(error));
		const snapshot = manager.captureState();
		const other = await seedSession(cwd, path.join(tempDir.path(), "other"), "other question");
		await manager.setSessionFile(other.file);
		// The switch released older.file; another process takes it before the rollback.
		const thief = await LeaseHolder.start(older.file, agentDir);
		try {
			const sizeBefore = fs.statSync(older.file).size;
			manager.restoreState(snapshot);
			manager.appendMessage({ role: "user", content: "must not land", timestamp: Date.now() });
			await manager.flush().catch(() => {});
			expect(fs.statSync(older.file).size).toBe(sizeBefore);
			expect(failures.some(error => error instanceof SessionInUseError)).toBe(true);
			await expect(manager.close()).rejects.toBeInstanceOf(SessionInUseError);
		} finally {
			await thief.kill();
		}
	}, 30_000);

	it("switchSession keeps its file leased until a rolled-back switch restores it", async () => {
		const authStorage = await AuthStorage.create(":memory:");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const otherProject = path.join(tempDir.path(), "other-project");
		fs.mkdirSync(otherProject);
		const target = await seedSession(otherProject, path.join(tempDir.path(), "other"), "target question");
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: await SessionManager.open(older.file),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		try {
			const reservedId = session.sessionManager.reserveEntryId();
			let takenDuringSwitch: boolean | undefined;
			const switched = await session.switchSession(target.file, {
				onCwdChange: async () => {
					// The manager already moved to the target file; the original is mid-transition.
					takenDuringSwitch = await anotherProcessCanTake(older.file);
					return false;
				},
			});
			expect(switched).toBe(false);
			expect(takenDuringSwitch).toBe(false);
			expect(session.sessionFile).toBe(older.file);
			expect(await anotherProcessCanTake(older.file)).toBe(false);
			// The restored session still owns and writes its file.
			const sizeBefore = fs.statSync(older.file).size;
			const writtenId = session.sessionManager.appendMessage(
				{ role: "user", content: "after rollback", timestamp: Date.now() },
				reservedId,
			);
			expect(writtenId).toBe(reservedId);
			await session.sessionManager.flush();
			expect(fs.statSync(older.file).size).toBeGreaterThan(sizeBefore);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}, 60_000);

	describe("--resume on a leased session", () => {
		async function resumeWith(choice: SessionInUseChoice | undefined): Promise<SessionManager | undefined> {
			const asked: number[] = [];
			const manager = await createSessionManager(resumeArgs(leased.id, dir), cwd, Settings.isolated(), undefined, {
				onSessionInUse: choice
					? async error => {
							asked.push(error.pid);
							return choice;
						}
					: undefined,
			});
			if (choice) expect(asked).toEqual([holder!.pid]);
			return manager;
		}

		it("fork creates a new file whose parentSession is the leased session", async () => {
			const manager = await resumeWith("fork");
			const file = manager?.getSessionFile();
			expect(file).toBeDefined();
			expect(file).not.toBe(leased.file);
			expect(fs.existsSync(file!)).toBe(true);
			expect(manager?.getHeader()?.parentSession).toBe(leased.id);
			await manager?.close();
		}, 30_000);

		it("read-only loads the transcript without a session file", async () => {
			const manager = await resumeWith("read-only");
			expect(manager?.getSessionFile()).toBeUndefined();
			expect(manager?.getSessionId()).toBe(leased.id);
		}, 30_000);

		it("cancel resolves to no session", async () => {
			expect(await resumeWith("cancel")).toBeUndefined();
		}, 30_000);

		it("without a prompt the SessionInUseError propagates", async () => {
			await expect(resumeWith(undefined)).rejects.toBeInstanceOf(SessionInUseError);
		}, 30_000);
	});

	describe("RPC", () => {
		it("--session <leased> exits non-zero with one startup_error line and no ready frame", async () => {
			const child = await RpcChild.spawn({ root: tempDir.path(), args: ["--session", leased.file] });
			const exitCode = await child.process.exited;
			await child.closed;
			expect(exitCode).not.toBe(0);
			expect(child.frames.some(frame => frame.type === "ready")).toBe(false);
			// The stderr pump may trail the exit by a tick.
			const deadline = Date.now() + 2_000;
			while (!child.stderr.includes("\n") && Date.now() < deadline) await Bun.sleep(10);
			const lines = child.stderr.split("\n").filter(line => line.trim().length > 0);
			expect(lines).toHaveLength(1);
			expect(JSON.parse(lines[0])).toEqual({
				type: "startup_error",
				code: "session_in_use",
				pid: holder!.pid,
				sessionFile: leased.file,
			});
			await child.dispose();
		}, 30_000);

		it("switch_session onto a leased file fails with session_in_use and keeps the current session", async () => {
			const child = await RpcChild.spawn({ root: tempDir.path(), args: ["--session", older.file] });
			try {
				const ready = await child.waitFor(frame => frame.type === "ready");
				expect(ready.capabilities).toContain("session_lease");
				const before = await child.request({ type: "get_state" });
				expect((before.data as { sessionFile: string }).sessionFile).toBe(older.file);

				const response = await child.request({ type: "switch_session", sessionPath: leased.file });
				expect(response.success).toBe(false);
				expect(response.code).toBe("session_in_use");

				const after = await child.request({ type: "get_state" });
				const state = after.data as { sessionFile: string; messageCount: number };
				expect(state.sessionFile).toBe(older.file);
				expect(state.messageCount).toBe(2);
			} finally {
				await child.dispose();
			}
		}, 30_000);
	});
});
