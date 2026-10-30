import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compaction from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	createRpcCommandHandler,
	RpcInputDispatcher,
	type RpcCommandHandlerContext,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { navigateRpcTree, resumeRpcTree } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-tree";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { assistantMsg } from "./utilities";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
	vi.restoreAllMocks();
});

async function fixture(options: { persisted?: boolean; extension?: ExtensionRunner } = {}) {
	const scratch = path.join(os.homedir(), ".cache", "npi-canary");
	await fs.mkdir(scratch, { recursive: true });
	const root = await fs.mkdtemp(path.join(scratch, "rpc-tree-"));
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
	const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
	cleanup.push(async () => {
		authStorage.close();
	});
	authStorage.keys.setRuntime("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	const manager = options.persisted ? SessionManager.create(root, root) : SessionManager.inMemory();
	const agent = new Agent({
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		modelRegistry,
		extensionRunner: options.extension,
	});
	cleanup.push(() => session.dispose());
	const ctx: Pick<RpcCommandHandlerContext, "session" | "success" | "error"> = {
		session,
		success: (id, command, data) => ({ id, type: "response", command, success: true, data }) as RpcResponse,
		error: (id, command, error, code) => ({ id, type: "response", command, success: false, error, code }),
	};
	const handle = createRpcCommandHandler(ctx as RpcCommandHandlerContext);
	const expected = () => ({
		expectedSessionId: session.sessionId,
		expectedSessionFile: session.sessionFile ?? null,
		expectedLeafId: manager.getLeafId(),
	});
	const user = (text: string) => manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	return { session, agent, manager, expected, user, handle, root };
}

function treeHook(callback: () => Promise<unknown>): ExtensionRunner {
	return {
		hasHandlers: (event: string) => event === "session_before_tree",
		emit: callback,
	} as unknown as ExtensionRunner;
}

describe("native RPC tree navigation", () => {
	test("restores the selected draft and images without creating a file or deleting alternate branches", async () => {
		const f = await fixture({ persisted: true });
		f.user("root");
		const ancestor = f.manager.appendMessage(assistantMsg("ancestor"));
		const images = [
			{ type: "image" as const, data: "QQ==", mimeType: "image/png" },
			{ type: "image" as const, data: "Qg==", mimeType: "image/jpeg" },
		];
		const draft = "compare [Image #1, 1x1] with [Image #2, 2x2]";
		const target = f.manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: draft }, ...images],
			timestamp: Date.now(),
		});
		const oldReply = f.manager.appendMessage(assistantMsg("original reply"));
		const before = f.expected();
		const ids = f.manager.getEntries().map(entry => entry.id);
		const response = await f.handle({ type: "navigate_tree", targetId: target, ...before });
		expect(response).toMatchObject({
			success: true,
			data: {
				outcome: "navigated",
				sessionId: before.expectedSessionId,
				sessionFile: before.expectedSessionFile,
				leafId: ancestor,
				editorText: draft,
				editorImages: images,
			},
		});
		if (!("data" in response)) throw new Error("Missing navigation result");
		expect(response.data).not.toHaveProperty("sessionContext");
		expect(f.manager.getEntries().map(entry => entry.id)).toEqual(ids);
		expect(f.manager.getEntry(oldReply)).toBeDefined();
		const sibling = f.user("alternate draft");
		expect(f.manager.getEntry(sibling)?.parentId).toBe(ancestor);
		await f.manager.flush();
		const persistedIds = parseSessionEntries(await Bun.file(f.session.sessionFile!).text()).flatMap(entry =>
			"id" in entry ? [entry.id] : [],
		);
		expect(persistedIds).toContain(oldReply);
		expect(persistedIds).toContain(sibling);
		expect(f.session.sessionFile).toBe(before.expectedSessionFile!);
	});

	test("reports an unchanged current non-user leaf explicitly", async () => {
		const f = await fixture();
		f.user("root");
		const target = f.manager.appendMessage(assistantMsg("leaf"));
		expect(await navigateRpcTree(f.session, { targetId: target, ...f.expected() })).toMatchObject({
			outcome: "unchanged",
			cancelled: false,
			leafId: target,
		});
	});

	test("rejects stale session IDs, files and leaves as typed errors before mutation", async () => {
		const f = await fixture();
		const target = f.user("root");
		const leaf = f.manager.appendMessage(assistantMsg("leaf"));
		for (const [change, code] of [
			[{ expectedSessionId: "old-session" }, "session_changed"],
			[{ expectedSessionFile: "/different/copy.jsonl" }, "session_changed"],
			[{ expectedLeafId: target }, "leaf_changed"],
		] as const) {
			expect(await f.handle({ type: "navigate_tree", targetId: target, ...f.expected(), ...change })).toMatchObject({
				success: false,
				code,
			});
			expect(f.manager.getLeafId()).toBe(leaf);
			expect(f.manager.getEntry(target)).toMatchObject({
				type: "message",
				message: { role: "user", content: "root" },
			});
		}
		expect(await f.handle({ type: "navigate_tree", targetId: "missing", ...f.expected() })).toMatchObject({
			success: false,
			code: "invalid_target",
		});
	});

	test("distinguishes a copied journal even when its durable session and entry IDs match", async () => {
		const f = await fixture({ persisted: true });
		const target = f.user("root");
		f.manager.appendMessage(assistantMsg("leaf"));
		const before = f.expected();
		await f.manager.flush();
		const copy = path.join(f.root!, "identical-copy.jsonl");
		await fs.copyFile(f.session.sessionFile!, copy);
		await f.manager.setSessionFile(copy);
		expect(f.session.sessionId).toBe(before.expectedSessionId);
		expect(f.manager.getLeafId()).toBe(before.expectedLeafId);
		expect(await f.handle({ type: "navigate_tree", targetId: target, ...before })).toMatchObject({
			success: false,
			code: "session_changed",
		});
	});

	test("refuses an active turn without aborting it", async () => {
		const f = await fixture();
		const target = f.user("root");
		f.manager.appendMessage(assistantMsg("leaf"));
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(f.agent, "continue").mockImplementation(async () => {
			started.resolve();
			await release.promise;
		});
		const abort = vi.spyOn(f.session, "abort");
		f.session.resumeAfterAskReanswer();
		try {
			await started.promise;
			expect(await f.handle({ type: "navigate_tree", targetId: target, ...f.expected() })).toMatchObject({
				success: false,
				code: "session_busy",
			});
			expect(abort).not.toHaveBeenCalled();
		} finally {
			release.resolve();
			await f.session.waitForIdle();
		}
	});

	test("reserves native admission across awaited hooks and refuses concurrent replacement or input", async () => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture({
			extension: treeHook(async () => {
				reached.resolve();
				await release.promise;
				return { cancel: true };
			}),
		});
		const target = f.user("root");
		const leaf = f.manager.appendMessage(assistantMsg("leaf"));
		const navigation = f.handle({ type: "navigate_tree", targetId: target, ...f.expected() });
		try {
			await reached.promise;
			expect(await f.handle({ type: "navigate_tree", targetId: target, ...f.expected() })).toMatchObject({
				success: false,
				code: "session_busy",
			});
			await expect(f.session.newSession()).rejects.toMatchObject({ code: "session_busy" });
			await expect(f.session.prompt("must not start")).rejects.toMatchObject({ code: "session_busy" });
			expect(f.manager.getLeafId()).toBe(leaf);
		} finally {
			release.resolve();
		}
		expect(await navigation).toMatchObject({ success: true, data: { outcome: "cancelled", leafId: leaf } });
		expect(f.session.isSessionTransitioning).toBe(false);
	});

	test("host navigation effects run only after valid native admission and cannot admit competing work", async () => {
		const f = await fixture();
		const target = f.user("root");
		const leaf = f.manager.appendMessage(assistantMsg("leaf"));
		const admitted = vi.fn(async () => {
			expect(f.session.isSessionTransitioning).toBe(true);
			expect(f.manager.getLeafId()).toBe(leaf);
			expect(() => f.session.executeBash("must-not-run")).toThrow("A remote tree navigation is in progress");
		});
		await expect(
			navigateRpcTree(f.session, { targetId: "missing", ...f.expected() }, admitted),
		).rejects.toMatchObject({ code: "invalid_target" });
		await expect(
			navigateRpcTree(f.session, { targetId: target, ...f.expected(), expectedSessionId: "stale" }, admitted),
		).rejects.toMatchObject({ code: "session_changed" });
		expect(await navigateRpcTree(f.session, { targetId: leaf, ...f.expected() }, admitted)).toMatchObject({
			outcome: "unchanged",
		});
		expect(admitted).not.toHaveBeenCalled();
		expect(await navigateRpcTree(f.session, { targetId: target, ...f.expected() }, admitted)).toMatchObject({
			outcome: "navigated",
			editorText: "root",
		});
		expect(admitted).toHaveBeenCalledTimes(1);
	});

	test("abort during admitted host lifecycle effects cancels before summary hooks run", async () => {
		const hook = vi.fn(async () => ({ summary: { summary: "unused" } }));
		const f = await fixture({ extension: treeHook(hook) });
		const target = f.user("root");
		const leaf = f.manager.appendMessage(assistantMsg("leaf"));
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const navigation = navigateRpcTree(
			f.session,
			{ targetId: target, summarize: true, ...f.expected() },
			async () => {
				reached.resolve();
				await release.promise;
			},
		);
		try {
			await reached.promise;
			f.session.abortBranchSummary();
		} finally {
			release.resolve();
		}
		expect(await navigation).toMatchObject({
			outcome: "cancelled",
			cancelled: true,
			aborted: true,
			leafId: leaf,
		});
		expect(hook).not.toHaveBeenCalled();
		expect(f.session.isSessionTransitioning).toBe(false);
	});

	test("rechecks the leaf under admission after an awaited native hook", async () => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture({
			extension: treeHook(async () => {
				reached.resolve();
				await release.promise;
			}),
		});
		const target = f.user("root");
		f.manager.appendMessage(assistantMsg("leaf"));
		const navigation = f.handle({ type: "navigate_tree", targetId: target, ...f.expected() });
		await reached.promise;
		const actualLeaf = f.user("native recorder changed the leaf");
		release.resolve();
		expect(await navigation).toMatchObject({ success: false, code: "leaf_changed" });
		expect(f.manager.getLeafId()).toBe(actualLeaf);
	});

	test("rechecks native identity after an awaited hook rather than navigating a replacement", async () => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture({
			extension: treeHook(async () => {
				reached.resolve();
				await release.promise;
			}),
		});
		const target = f.user("root");
		f.manager.appendMessage(assistantMsg("leaf"));
		const navigation = f.handle({ type: "navigate_tree", targetId: target, ...f.expected() });
		await reached.promise;
		await f.manager.newSession();
		const replacement = f.expected();
		release.resolve();
		expect(await navigation).toMatchObject({ success: false, code: "session_changed" });
		expect(f.expected()).toEqual(replacement);
	});

	test("keeps native summary cancellation and leaves the journal untouched", async () => {
		const f = await fixture({ extension: treeHook(async () => ({ cancel: true })) });
		const target = f.user("root");
		f.manager.appendMessage(assistantMsg("leaf"));
		const before = f.expected();
		const ids = f.manager.getEntries().map(entry => entry.id);
		expect(await navigateRpcTree(f.session, { targetId: target, summarize: true, ...before })).toMatchObject({
			outcome: "cancelled",
			cancelled: true,
			leafId: before.expectedLeafId,
		});
		expect(f.manager.getEntries().map(entry => entry.id)).toEqual(ids);
	});

	test("returns the native summary entry attached to the selected branch", async () => {
		const f = await fixture({ extension: treeHook(async () => ({ summary: { summary: "Native branch summary" } })) });
		f.user("root");
		const target = f.manager.appendMessage(assistantMsg("retained"));
		f.user("abandoned");
		f.manager.appendMessage(assistantMsg("leaf"));
		const result = await navigateRpcTree(f.session, { targetId: target, summarize: true, ...f.expected() });
		expect(result.summaryEntry).toMatchObject({
			type: "branch_summary",
			parentId: target,
			summary: "Native branch summary",
		});
		expect(result.leafId).toBe(result.summaryEntry?.id ?? null);
	});

	test("RPC abort overtakes a native summary without moving the branch", async () => {
		const f = await fixture();
		const target = f.user("root");
		f.manager.appendMessage(assistantMsg("leaf"));
		const before = f.expected();
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(compaction, "generateBranchSummary").mockImplementation(async (_entries, options) => {
			reached.resolve();
			options.signal?.addEventListener("abort", () => release.resolve(), { once: true });
			await release.promise;
			return { aborted: options.signal?.aborted === true };
		});
		const navigation = Promise.withResolvers<object>();
		const aborted = Promise.withResolvers<object>();
		const background: Promise<void>[] = [];
		const dispatcher = new RpcInputDispatcher({
			deps: {
				handleCommand: f.handle,
				output: frame => {
					if ("id" in frame && frame.id === "tree") navigation.resolve(frame);
					if ("id" in frame && frame.id === "abort") aborted.resolve(frame);
				},
				errorResponse: (id, command, error) => ({ id, type: "response", command, success: false, error }),
				trackBackgroundTask: task => {
					background.push(task);
				},
				pendingExtensionRequests: new Map(),
				onHostToolResult: () => {},
				onHostToolUpdate: () => {},
				onHostUriResult: () => {},
				onToolApprovalResponse: () => {},
				onPlanProposalResponse: () => {},
			},
		});
		dispatcher.dispatch({ id: "tree", type: "navigate_tree", targetId: target, summarize: true, ...before });
		await reached.promise;
		dispatcher.dispatch({ id: "abort", type: "abort" });
		try {
			expect(await aborted.promise).toMatchObject({ success: true });
			expect(await navigation.promise).toMatchObject({
				success: true,
				data: { outcome: "cancelled", cancelled: true, aborted: true, leafId: before.expectedLeafId },
			});
		} finally {
			release.resolve();
			await dispatcher.drain();
			await Promise.all(background);
		}
		expect(f.session.isSessionTransitioning).toBe(false);
		expect(await navigateRpcTree(f.session, { targetId: target, ...f.expected() })).toMatchObject({
			outcome: "navigated",
			editorText: "root",
		});
	});

	test("probes ask, commits a sibling answer, and resumes only after explicit acknowledgement", async () => {
		const f = await fixture();
		f.user("deploy");
		const questions = [
			{ id: "target", question: "Where?", options: [{ label: "staging" }, { label: "production" }] },
		];
		const call = f.manager.appendMessage({
			...assistantMsg(""),
			content: [{ type: "toolCall", id: "ask-1", name: "ask", arguments: { questions } }],
			stopReason: "toolUse",
		});
		const oldAnswer = f.manager.appendMessage({
			role: "toolResult",
			toolName: "ask",
			toolCallId: "ask-1",
			content: [{ type: "text", text: "staging" }],
			isError: false,
			timestamp: Date.now(),
		});
		const oldLeaf = f.manager.appendMessage(assistantMsg("old continuation"));
		const continuing = vi.spyOn(f.agent, "continue").mockResolvedValue(undefined);
		const admitted = vi.fn(async () => {});
		const probe = await navigateRpcTree(
			f.session,
			{ targetId: oldAnswer, allowAskReopen: true, ...f.expected() },
			admitted,
		);
		expect(probe).toMatchObject({
			outcome: "ask_reopen",
			leafId: oldLeaf,
			reopenAsk: { toolCallId: "ask-1", questions },
		});
		expect(probe.resumeToken).toBeUndefined();
		expect(admitted).not.toHaveBeenCalled();
		const committed = await navigateRpcTree(f.session, {
			targetId: oldAnswer,
			allowAskReopen: true,
			...f.expected(),
			reanswerAskResult: {
				content: [{ type: "text", text: "production" }],
				details: {
					question: "Where?",
					selectedOptions: ["production"],
					note: "Wait for the deployment window",
					noteOption: "production",
					optionNotes: [{ option: "production", note: "Use the approved rollout" }],
				},
			},
		});
		expect(committed).toMatchObject({ outcome: "navigated", askReanswerCommitted: true });
		expect(committed.resumeToken).toBeString();
		expect(f.session.hasPendingTreeResume()).toBe(true);
		expect(f.manager.getEntry(committed.leafId!)?.parentId).toBe(call);
		expect(f.manager.getEntry(committed.leafId!)).toMatchObject({
			type: "message",
			message: {
				role: "toolResult",
				details: {
					note: "Wait for the deployment window",
					noteOption: "production",
					optionNotes: [{ option: "production", note: "Use the approved rollout" }],
				},
			},
		});
		expect(f.manager.getEntry(oldAnswer)?.parentId).toBe(call);
		expect(f.manager.getEntry(oldLeaf)).toBeDefined();
		expect(continuing).not.toHaveBeenCalled();
		const ack = { resumeToken: committed.resumeToken!, ...f.expected() };
		expect(() => resumeRpcTree(f.session, { ...ack, expectedSessionFile: "/identical/copy.jsonl" })).toThrow();
		expect(resumeRpcTree(f.session, ack)).toEqual({ resumed: true });
		expect(f.session.hasPendingTreeResume()).toBe(false);
		await f.session.waitForIdle();
		expect(continuing).toHaveBeenCalledTimes(1);
		expect(() => resumeRpcTree(f.session, ack)).toThrow();
	});

	test("a committed resume token cannot start a turn in a replacement session", async () => {
		const f = await fixture();
		f.user("deploy");
		f.manager.appendMessage({
			...assistantMsg(""),
			content: [
				{
					type: "toolCall",
					id: "ask-1",
					name: "ask",
					arguments: { questions: [{ id: "target", question: "Where?", options: [{ label: "staging" }] }] },
				},
			],
			stopReason: "toolUse",
		});
		const target = f.manager.appendMessage({
			role: "toolResult",
			toolName: "ask",
			toolCallId: "ask-1",
			content: [{ type: "text", text: "staging" }],
			isError: false,
			timestamp: Date.now(),
		});
		const committed = await navigateRpcTree(f.session, {
			targetId: target,
			allowAskReopen: true,
			...f.expected(),
			reanswerAskResult: { content: [{ type: "text", text: "replacement answer" }] },
		});
		const continuing = vi.spyOn(f.agent, "continue").mockResolvedValue(undefined);
		await f.manager.newSession();
		const replacement = f.expected();
		expect(
			await f.handle({ type: "resume_tree", resumeToken: committed.resumeToken!, ...replacement }),
		).toMatchObject({ success: false, code: "session_changed" });
		expect(f.expected()).toEqual(replacement);
		expect(continuing).not.toHaveBeenCalled();
	});

	test("rejects malformed re-answers before writing a branch", async () => {
		const f = await fixture();
		const target = f.user("root");
		const command = {
			type: "navigate_tree",
			targetId: target,
			...f.expected(),
			allowAskReopen: true,
			reanswerAskResult: { content: [{ type: "text", text: 42 }] },
		} as unknown as RpcCommand;
		expect(await f.handle(command)).toMatchObject({ success: false, code: "invalid_request" });
		expect(f.manager.getLeafId()).toBe(target);
	});
});
