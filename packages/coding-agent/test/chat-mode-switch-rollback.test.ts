/**
 * Contract: a live chat-mode switch is all-or-nothing. When the tool change or
 * the system-prompt rebuild fails, the session keeps its previous mode, tools,
 * and prompt, emits no `chat_mode_changed`, journals nothing, and the same
 * request succeeds once the failure clears.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CHAT_MODE_ENTRY_TYPE } from "@oh-my-pi/pi-coding-agent/chat/chat-mode";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("AgentSession.setChatMode rollback", () => {
	let sharedDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chat-rollback-shared-"));
		authStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chat-rollback-"));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		removeSyncWithRetries(tempDir);
	});

	async function createSession(): Promise<{ session: AgentSession; changes: AgentSessionEvent[] }> {
		const created = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry,
			settings: Settings.isolated({}),
			skills: [],
			rules: [],
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
		});
		session = created.session;
		const changes: AgentSessionEvent[] = [];
		session.subscribe(event => {
			if (event.type === "chat_mode_changed") changes.push(event);
		});
		return { session, changes };
	}

	function chatEntries(target: AgentSession): number {
		return target.sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === CHAT_MODE_ENTRY_TYPE).length;
	}

	it("keeps coding mode, tools, and prompt when entering chat mode fails, and a retry enters it", async () => {
		const { session: target, changes } = await createSession();
		const tools = target.getEnabledToolNames();
		const prompt = target.systemPrompt;
		expect(tools.length).toBeGreaterThan(0);

		const refresh = target.refreshBaseSystemPrompt.bind(target);
		let failures = 1;
		target.refreshBaseSystemPrompt = commitIf => {
			if (failures-- > 0) return Promise.reject(new Error("prompt rebuild failed"));
			return refresh(commitIf);
		};

		await expect(target.setChatMode({ mode: "erp" })).rejects.toThrow("prompt rebuild failed");
		expect(target.chatMode).toBeUndefined();
		expect(target.getEnabledToolNames()).toEqual(tools);
		expect(target.systemPrompt).toEqual(prompt);
		expect(changes).toEqual([]);
		expect(chatEntries(target)).toBe(0);

		expect(await target.setChatMode({ mode: "erp" })).toEqual({ mode: "erp", include: [] });
		expect(target.getActiveToolNames()).toEqual([]);
		expect(target.systemPrompt).not.toEqual(prompt);
		expect(changes).toEqual([{ type: "chat_mode_changed", mode: "erp", include: "" }]);
	}, 60_000);

	it("stays in chat mode when restoring the coding tools fails, and a retry restores them", async () => {
		const { session: target, changes } = await createSession();
		const tools = target.getEnabledToolNames();
		await target.setChatMode({ mode: "erp" });
		const chatPrompt = target.systemPrompt;

		const present = target.setActiveToolPresentation.bind(target);
		let failures = 1;
		target.setActiveToolPresentation = (...args) => {
			if (failures-- > 0) return Promise.reject(new Error("tool restore failed"));
			return present(...args);
		};

		await expect(target.setChatMode({ mode: "off" })).rejects.toThrow("tool restore failed");
		expect(target.chatMode).toEqual({ mode: "erp", include: [] });
		expect(target.getActiveToolNames()).toEqual([]);
		expect(target.systemPrompt).toEqual(chatPrompt);
		expect(changes.map(event => event.type === "chat_mode_changed" && event.mode)).toEqual(["erp"]);

		expect(await target.setChatMode({ mode: "off" })).toBeUndefined();
		expect(target.getEnabledToolNames()).toEqual(tools);
		expect(changes.map(event => event.type === "chat_mode_changed" && event.mode)).toEqual(["erp", "off"]);
	}, 60_000);
});
