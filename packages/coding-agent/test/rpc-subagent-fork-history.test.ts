import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { createRpcCommandHandler, type RpcCommandHandlerContext } from "../src/modes/rpc/rpc-mode";
import { RpcSubagentRegistry } from "../src/modes/rpc/rpc-subagents";
import type { RpcCommand, RpcResponse } from "../src/modes/rpc/rpc-types";
import { AgentRegistry } from "../src/registry/agent-registry";
import { getAgentTombstonePath } from "../src/registry/agent-tombstone";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";

let dir: string;
let auth: AuthStorage;
const sessions: AgentSession[] = [];
const buses: RpcSubagentRegistry[] = [];

beforeEach(async () => {
	AgentRegistry.resetGlobalForTests();
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "rpc-fork-roster-"));
	auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
});
afterEach(async () => {
	for (const bus of buses.splice(0)) bus.dispose();
	for (const session of sessions.splice(0).reverse()) await session.dispose();
	auth.close();
	AgentRegistry.resetGlobalForTests();
	await fs.rm(dir, { recursive: true, force: true });
});

async function sessionAt(file?: string): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("bundled model missing");
	if (file)
		await Bun.write(
			file,
			`${JSON.stringify({ type: "session", version: 3, id: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd: dir })}\n`,
		);
	const manager = file
		? await SessionManager.open(file, path.dirname(file))
		: SessionManager.create(dir, path.join(dir, "sessions"));
	const session = new AgentSession({
		agent: new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			getApiKey: () => "test-key",
			streamFn: createMockModel({
				id: model.id,
				provider: model.provider,
				handler: () => ({ content: ["complete"] }),
			}).stream,
		}),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		modelRegistry: new ModelRegistry(auth, path.join(dir, "models.yml")),
	});
	sessions.push(session);
	await session.prompt("fixture task");
	await manager.flush();
	return session;
}

function handler(session: AgentSession) {
	const bus = new RpcSubagentRegistry(new EventBus(), () => {});
	buses.push(bus);
	return createRpcCommandHandler({
		session,
		subagentRegistry: bus,
		success: (id: string | undefined, command: string, data?: unknown) =>
			({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) }) as RpcResponse,
		error: (id: string | undefined, command: string, error: string) => ({
			id,
			type: "response",
			command,
			success: false,
			error,
		}),
	} as unknown as RpcCommandHandlerContext);
}

describe("fork-local persisted subagent history", () => {
	test.each(["idle", "aborted", "parked", "independent"] as const)(
		"keeps a %s source owner while reading the fork's complete child tree",
		async kind => {
			const parent = await sessionAt();
			const sourceRoot = parent.sessionFile!;
			const sourceFile = path.join(sourceRoot.slice(0, -6), "Worker.jsonl");
			const child = await sessionAt(sourceFile);
			const nestedFile = path.join(sourceRoot.slice(0, -6), "Worker", "Child.jsonl");
			const nested = await sessionAt(nestedFile);
			if (kind === "aborted") await Bun.write(getAgentTombstonePath(sourceFile), "");
			const registry = AgentRegistry.global();
			const source = registry.register({
				id: "Worker",
				displayName: "Source-only label",
				kind: "sub",
				parentId: "SourceParent",
				session: kind === "parked" ? null : child,
				sessionFile: sourceFile,
				status: kind === "aborted" ? "aborted" : kind === "parked" ? "parked" : "idle",
				activity: "Source-only activity",
			});
			const sourceChild = registry.register({
				id: "Child",
				displayName: "Child",
				kind: "sub",
				parentId: "Worker",
				session: nested,
				sessionFile: nestedFile,
				status: "idle",
			});
			const generation = source.generation;
			expect(await parent.fork()).toBe(true);
			const destinationRoot = parent.sessionFile!;
			const destinationFile = path.join(destinationRoot.slice(0, -6), "Worker.jsonl");
			const destinationNestedFile = path.join(destinationRoot.slice(0, -6), "Worker", "Child.jsonl");
			if (kind === "independent") {
				const file = Bun.file(destinationFile);
				const lines = (await file.text()).split("\n");
				const headerIndex = lines.findIndex(line => line.startsWith('{"type":"session"'));
				const headerLine = lines[headerIndex];
				if (!headerLine) throw new Error("fork transcript header missing");
				const header = JSON.parse(headerLine) as Record<string, unknown>;
				lines[headerIndex] = JSON.stringify({ ...header, id: crypto.randomUUID() });
				await Bun.write(destinationFile, lines.join("\n"));
			}
			const handle = handler(parent);
			const history = await handle({ type: "get_subagent_history" });
			if (!history.success || history.command !== "get_subagent_history") throw new Error(JSON.stringify(history));
			expect(history.data.subagents).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: "Worker",
						displayName: "Worker",
						sessionFile: destinationFile,
						live: false,
						status: kind === "aborted" ? "aborted" : "parked",
						resolvedModel: "anthropic/claude-sonnet-4-5",
					}),
					expect.objectContaining({
						id: "Child",
						parentId: "Worker",
						sessionFile: destinationNestedFile,
						live: false,
					}),
				]),
			);
			expect(history.data.subagents.find(row => row.id === "Worker")?.description).not.toBe("Source-only activity");
			expect(history.data.subagents.find(row => row.id === "Worker")?.parentId).toBe(parent.getAgentId() ?? "Main");
			expect(history.data.subagents.find(row => row.id === "Worker")?.resolvedModelIdentity).toBeUndefined();
			const byId = await handle({ type: "get_subagent_messages", subagentId: "Worker" });
			const byFile = await handle({ type: "get_subagent_messages", sessionFile: destinationFile });
			expect(byId).toEqual(byFile);
			if (!byId.success || byId.command !== "get_subagent_messages") throw new Error(JSON.stringify(byId));
			expect(byId.data.sessionFile).toBe(destinationFile);
			expect(byId.data.messages.map(message => message.role)).toEqual(["user", "assistant"]);
			expect(
				await handle({ type: "get_subagent_messages", subagentId: "Worker", fromByte: byId.data.nextByte }),
			).toMatchObject({ success: true, data: { nextByte: byId.data.nextByte, messages: [], reset: false } });
			expect(
				await handle({
					type: "set_subagent_model",
					subagentId: "Worker",
					provider: "anthropic",
					modelId: "claude-haiku-4-5",
				} as RpcCommand),
			).toMatchObject({ success: false });
			expect(registry.get("Worker")).toBe(source);
			expect(source).toMatchObject({
				generation,
				sessionFile: sourceFile,
				session: kind === "parked" ? null : child,
			});
			const sourceHandle = createRpcCommandHandler({
				session: { sessionFile: sourceRoot, getAgentId: () => "SourceParent" } as unknown as AgentSession,
				success: (id: string | undefined, command: string, data?: unknown) =>
					({ id, type: "response", command, success: true, data }) as RpcResponse,
				error: (id: string | undefined, command: string, error: string) => ({
					id,
					type: "response",
					command,
					success: false,
					error,
				}),
			} as RpcCommandHandlerContext);
			expect(await sourceHandle({ type: "get_subagent_history" })).toMatchObject({
				success: true,
				data: {
					subagents: expect.arrayContaining([expect.objectContaining({ id: "Worker", sessionFile: sourceFile })]),
				},
			});
			await handle({ type: "get_subagent_history" });
			expect(registry.get("Worker")).toBe(source);
			expect(registry.get("Child")).toBe(sourceChild);
		},
	);
	test("overlays current live facts only for this root's exact transcript", async () => {
		const parent = await sessionAt();
		const file = path.join(parent.sessionFile!.slice(0, -6), "Worker.jsonl");
		const child = await sessionAt(file);
		const ref = AgentRegistry.global().register({
			id: "Worker",
			displayName: "Live Worker",
			kind: "sub",
			parentId: parent.getAgentId() ?? "Main",
			session: child,
			sessionFile: file,
			status: "running",
			activity: "Owned activity",
		});
		const result = await handler(parent)({ type: "get_subagent_history" });
		expect(result).toMatchObject({
			success: true,
			data: {
				subagents: [
					expect.objectContaining({
						id: "Worker",
						displayName: "Live Worker",
						live: true,
						status: "running",
						description: "Owned activity",
						sessionFile: file,
					}),
				],
			},
		});
		expect(AgentRegistry.global().get("Worker")).toBe(ref);
	});
});
