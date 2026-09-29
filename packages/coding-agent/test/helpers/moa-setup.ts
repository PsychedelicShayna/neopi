/**
 * Fixtures for Mixture of Agents tests: scripted member models behind a
 * registered custom API, a registry holding them, and a real session.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type AssistantMessage,
	type Context,
	type Model,
	registerCustomApi,
	type SimpleStreamOptions,
	type Usage,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake, type TempDir } from "@oh-my-pi/pi-utils";

export const FAKE_API = "moa-fake";
export const FAKE_PROVIDER = "fake";

export const DRAFT_THEN_EDIT_TOML = `
[[mixtures]]
name = "draft-then-edit"
entry = "writer"

[[mixtures.members]]
id = "writer"
model = "fake/writer"
system_prompt = "Draft a complete answer."
tools = false

[[mixtures.members]]
id = "editor"
model = "fake/editor"
system_prompt = "Tighten the draft. Return only the final text."
tools = false

[[mixtures.edges]]
from = "writer"
to = "editor"
x = { output = true }
`;

/** What a scripted member does for one call. */
export interface MemberReply {
	text?: string;
	thinking?: string;
	/** Settled cost of the attempt, in USD. */
	cost?: number;
	/** End with `error`/`reason: "error"`. */
	error?: { message: string; status?: number };
	/** Wait for the caller's abort signal, then end with `error`/`reason: "aborted"`. */
	waitForAbort?: boolean;
	/** With `waitForAbort`: hold the aborted terminal back until this settles. */
	abortedAfter?: Promise<void>;
	/** Optional usage meters the attempt reports beside tokens and USD. */
	meters?: Pick<Usage, "premiumRequests" | "credits">;
	/** Emit a tool call block before finishing. */
	toolCall?: { name: string; arguments: Record<string, unknown> };
}

export interface MemberCall {
	model: Model;
	context: Context;
	options?: SimpleStreamOptions;
}

function usageFor(cost: number, meters?: MemberReply["meters"]): Usage {
	return {
		...meters,
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 150,
		cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

/** Scripted member models: replies are queued per model id; an empty queue answers with a default text. */
export class FakeMembers {
	readonly calls: MemberCall[] = [];
	readonly #queues = new Map<string, MemberReply[]>();

	constructor() {
		registerCustomApi(FAKE_API, (model, context, options) => this.#stream(model, context, options));
	}

	/** Queue replies for the next calls to `modelId`. */
	script(modelId: string, ...replies: MemberReply[]): void {
		const queue = this.#queues.get(modelId) ?? [];
		queue.push(...replies);
		this.#queues.set(modelId, queue);
	}

	callsTo(modelId: string): MemberCall[] {
		return this.calls.filter(call => call.model.id === modelId);
	}

	#stream(model: Model, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		this.calls.push({ model, context, options });
		const reply = this.#queues.get(model.id)?.shift() ?? { text: `${model.id} reply`, cost: 0.01 };
		const stream = new AssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usageFor(reply.cost ?? 0.01, reply.meters),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		void (async () => {
			await Promise.resolve();
			stream.push({ type: "start", partial: message });
			if (reply.thinking) {
				message.content.push({ type: "thinking", thinking: reply.thinking });
				stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
				stream.push({ type: "thinking_delta", contentIndex: 0, delta: reply.thinking, partial: message });
				stream.push({ type: "thinking_end", contentIndex: 0, content: reply.thinking, partial: message });
			}
			if (reply.text) {
				const index = message.content.length;
				message.content.push({ type: "text", text: reply.text });
				stream.push({ type: "text_start", contentIndex: index, partial: message });
				stream.push({ type: "text_delta", contentIndex: index, delta: reply.text, partial: message });
				stream.push({ type: "text_end", contentIndex: index, content: reply.text, partial: message });
			}
			if (reply.toolCall) {
				const index = message.content.length;
				const toolCall = { type: "toolCall" as const, id: "member-call-1", ...reply.toolCall };
				message.content.push(toolCall);
				stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
				stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
			}
			if (reply.waitForAbort) {
				const signal = options?.signal;
				if (signal && !signal.aborted) {
					await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
				}
				await reply.abortedAfter;
				message.stopReason = "aborted";
				message.errorMessage = "Request was aborted";
				stream.push({ type: "error", reason: "aborted", error: message });
				return;
			}
			if (reply.error) {
				message.stopReason = "error";
				message.errorMessage = reply.error.message;
				message.errorStatus = reply.error.status;
				stream.push({ type: "error", reason: "error", error: message });
				return;
			}
			stream.push({ type: "done", reason: reply.toolCall ? "toolUse" : "stop", message });
		})();
		return stream;
	}
}

function fakeModel(id: string, input: ("text" | "image")[] = ["text"]) {
	return {
		id,
		name: id,
		reasoning: true,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 64_000,
		maxTokens: 4_000,
	};
}

export interface MoaFixture {
	authStorage: AuthStorage;
	registry: ModelRegistry;
	agentDir: string;
	cwd: string;
}

/** A registry with the fake members (`fake/writer`, `fake/editor`, `fake/other`) and a MIXTURES.toml. */
export async function createMoaFixture(tempDir: TempDir, mixturesToml = DRAFT_THEN_EDIT_TOML): Promise<MoaFixture> {
	const agentDir = tempDir.join("agent");
	const cwd = tempDir.join("project");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	await Bun.write(path.join(agentDir, "MIXTURES.toml"), mixturesToml);
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	registry.registerProvider(FAKE_PROVIDER, {
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "fake-key",
		api: FAKE_API,
		models: [fakeModel("writer", ["text", "image"]), fakeModel("editor"), fakeModel("other")],
	});
	return { authStorage, registry, agentDir, cwd };
}

export interface MoaSessionOptions {
	sessionManager?: SessionManager;
	settings?: Settings;
	/** The starting model; `null` lets the session restore one (session file, then the default role). */
	model?: Model | null;
	/** The workspace; defaults to the fixture's project directory. */
	cwd?: string;
}

/** A real session over the fixture's registry, starting on `fake/other` unless `model` says otherwise. */
export async function createMoaSession(fixture: MoaFixture, options: MoaSessionOptions = {}): Promise<AgentSession> {
	const cwd = options.cwd ?? fixture.cwd;
	const { session } = await createAgentSession({
		cwd,
		agentDir: fixture.agentDir,
		sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd),
		authStorage: fixture.authStorage,
		modelRegistry: fixture.registry,
		settings: options.settings ?? Settings.isolated({ "compaction.enabled": false }),
		model: options.model === null ? undefined : (options.model ?? fixture.registry.find(FAKE_PROVIDER, "other")),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		taskDepth: 1,
		// Several MoA sessions share one registry at once; each needs its own id.
		agentId: `MoaTest-${Snowflake.next()}`,
	});
	return session;
}
