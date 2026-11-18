import { type Model, realizesPriorityServiceTier, serviceTierFamily } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../../session/agent-session";

/** A model descriptor with the native `/fast` capability projected for RPC clients. */
export type RpcModel = Model & { supportsFastMode: boolean };

/** Copy a registry model without mixing capability with the session's requested or active tier. */
export function serializeRpcModel(model: Model): RpcModel {
	return {
		...model,
		supportsFastMode: serviceTierFamily(model) !== undefined && realizesPriorityServiceTier("priority", model),
	};
}

export type RpcModelLookupSession = Pick<AgentSession, "getAvailableModels" | "modelRegistry">;

/**
 * The available model with exactly this provider and id. Models missing from
 * the current catalog wait for in-flight background discovery first: on cold
 * start, discovery-backed providers (proxy / ollama / etc.) populate seconds
 * after session ready. Catalog hits skip the wait, so the RPC queue is not
 * stalled behind unrelated discovery.
 */
export async function findRpcModel(session: RpcModelLookupSession, provider: string, modelId: string) {
	const find = () => session.getAvailableModels().find(m => m.provider === provider && m.id === modelId);
	const model = find();
	if (model) return model;
	await session.modelRegistry.awaitBackgroundRefresh();
	return find();
}
