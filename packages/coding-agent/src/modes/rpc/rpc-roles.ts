/**
 * Model roles over RPC: `get_roles`, `set_role`, and `get_state.activeRole`.
 *
 * Roles resolve through the resolver `--model @<role>` uses at launch
 * (`resolveModelRoleValue` over the role's pattern chain), so fallback chains
 * and `:thinking` suffixes behave identically.
 */
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { ModelRoleLookup } from "@oh-my-pi/pi-tui/overlays/model-browser";
import {
	disabledProviderIds,
	getModelMatchPreferences,
	resolveCliModel,
	resolveConfiguredModelPatterns,
	resolveModelRoleValue,
} from "../../config/model-resolver";
import { cfgCycleOrder } from "../../config/model-settings";
import {
	formatModelRoleAlias,
	getKnownRoleIds,
	getRoleInfo,
	MODEL_ROLE_IDS,
	modelRoleNamespace,
} from "../../config/model-roles";
import type { Settings } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";
import { EPHEMERAL_MODEL_CHANGE_ROLE, type ModelChangeEntry } from "../../session/session-entries";

/** The model a role currently resolves to. */
export interface RpcRoleResolution {
	provider: string;
	modelId: string;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/** One entry of the `get_roles` catalog. */
export interface RpcRoleInfo {
	id: string;
	/** Selector form, e.g. `@smol`. */
	alias: string;
	name: string;
	description?: string;
	/** Built-in short tag; absent for custom roles. */
	tag?: string;
	section: "chat" | "kind";
	source: "builtin" | "configured";
	/** Consumer-owned namespace, independent of whether the role is built-in or configured. */
	namespace?: "deck";
	/** Raw `modelRoles` selector; absent when the role is not configured. */
	configured?: string;
	/** Effective pattern chain for `@<id>`, thinking suffixes preserved. */
	patterns: string[];
	/** First pattern that resolves to an available model; absent when none does. */
	resolved?: RpcRoleResolution;
	hidden: boolean;
}

export interface RpcRolesResult {
	roles: RpcRoleInfo[];
	activeRole?: string;
	/** The configured `cycleOrder`: the roles `cycle_role` walks, in order (a role without an available model is skipped). */
	cycleOrder: string[];
}

export interface RpcSetRoleResult {
	role: string;
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
}

export type RpcSetRoleErrorCode = "unknown_role" | "role_unresolved" | "session_busy";

export type RpcSetRoleOutcome =
	| { ok: true; data: RpcSetRoleResult }
	| { ok: false; code: RpcSetRoleErrorCode; message: string };

type RpcRolesSession = Pick<
	AgentSession,
	| "settings"
	| "modelRegistry"
	| "sessionManager"
	| "sessionId"
	| "model"
	| "thinkingLevel"
	| "isStreaming"
	| "isCompacting"
	| "setModel"
	| "setThinkingLevel"
	| "cycleRoleModels"
>;

/** Persisted role aliases visible from an explicit editing scope, excluding runtime/overlay assignments. */
export function scopedRoleLookup(settings: Settings, scope: "global" | "project"): ModelRoleLookup {
	return {
		getModelRole: role =>
			scope === "project"
				? (settings.getProjectModelRole(role) ?? settings.getGlobalModelRole(role))
				: settings.getGlobalModelRole(role),
	};
}

interface ResolvedRole {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/** A role selection, valid while it is still the branch's latest model change. */
interface RoleSelection {
	role: string;
	sessionId: string;
	entryId: string | undefined;
}

/**
 * Resolve `@<role>` the way `--model @<role>` does at launch: the first
 * pattern in the role's chain that matches an available chat model, then any
 * available model (kind roles such as `image`). Launch additionally falls back
 * to unauthenticated catalog models, which a live session cannot switch to, so
 * those count as unresolved here.
 */
function resolveRole(session: RpcRolesSession, role: string, roleLookup?: ModelRoleLookup): ResolvedRole | undefined {
	const selector = formatModelRoleAlias(role);
	const disabled = disabledProviderIds(session.settings);
	const options = {
		settings: session.settings,
		roleLookup,
		matchPreferences: getModelMatchPreferences(session.settings),
	};
	for (const kind of ["chat", "all"] as const) {
		const available = session.modelRegistry.getAvailable(kind).filter(model => !disabled.has(model.provider));
		const resolved = resolveModelRoleValue(selector, available, options);
		if (resolved.model) return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
	}
	return undefined;
}

/** Latest non-ephemeral model change on the current branch; retry fallbacks do not end a role selection. */
function lastSelectingModelChange(session: RpcRolesSession): ModelChangeEntry | undefined {
	const branch = session.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "model_change" && entry.role !== EPHEMERAL_MODEL_CHANGE_ROLE) return entry;
	}
	return undefined;
}

/** Owns the RPC view of model roles and the session's active role. */
export class RpcRoles {
	readonly #session: RpcRolesSession;
	#selection: RoleSelection | undefined;

	/**
	 * @param launchModel The `--model` selector the process launched with (only
	 * when no `--provider` was given). A role selector that produced the
	 * session's current model seeds `activeRole`.
	 */
	constructor(session: RpcRolesSession, launchModel?: string) {
		this.#session = session;
		const launchRole = launchModel ? this.#launchRole(launchModel) : undefined;
		if (launchRole) this.#remember(launchRole);
	}

	list(): RpcRolesResult {
		const { settings } = this.#session;
		const roles = getKnownRoleIds(settings).map((id): RpcRoleInfo => {
			const info = getRoleInfo(id, settings);
			const alias = formatModelRoleAlias(id);
			const configured = settings.getModelRole(id);
			const resolved = resolveRole(this.#session, id);
			const namespace = modelRoleNamespace(id);
			return {
				id,
				alias,
				name: info.name,
				...(info.description !== undefined ? { description: info.description } : {}),
				...(info.tag ? { tag: info.tag } : {}),
				section: info.section,
				source: MODEL_ROLE_IDS.some(builtin => builtin === id) ? "builtin" : "configured",
				...(namespace ? { namespace } : {}),
				...(configured !== undefined ? { configured } : {}),
				patterns: resolveConfiguredModelPatterns([alias], settings),
				...(resolved
					? {
							resolved: {
								provider: resolved.model.provider,
								modelId: resolved.model.id,
								...(resolved.thinkingLevel !== undefined ? { thinkingLevel: resolved.thinkingLevel } : {}),
							},
						}
					: {}),
				hidden: info.hidden ?? false,
			};
		});
		const activeRole = this.activeRole();
		const cycleOrder = this.cycleOrder();
		return activeRole ? { roles, activeRole, cycleOrder } : { roles, cycleOrder };
	}

	/** The role order Ctrl+P walks: the `cycleOrder` setting as the TUI reads it. */
	cycleOrder(): string[] {
		return [...cfgCycleOrder.get(this.#session.settings)];
	}

	/**
	 * Ctrl+P: step through the configured role models in `cycleOrder` order, from the slot the active
	 * model occupies. Returns `null` when fewer than two role models are available. Like Ctrl+P it does
	 * not wait out a running turn: the new model applies from the next request.
	 */
	async cycle(direction: "forward" | "backward"): Promise<RpcSetRoleResult | null> {
		const session = this.#session;
		// Discovery-backed providers can populate after startup; role models resolve against the settled catalog.
		await session.modelRegistry.awaitBackgroundRefresh();
		const result = await session.cycleRoleModels(this.cycleOrder(), direction);
		if (!result) return null;
		this.#remember(result.role);
		return { role: result.role, model: session.model ?? result.model, thinkingLevel: session.thinkingLevel };
	}

	/** Resolve the role as authored at this editing scope, without borrowing a higher layer's assignment. */
	resolveScope(role: string, scope: "global" | "project"): RpcRoleResolution | null {
		const { settings } = this.#session;
		const resolved = resolveRole(this.#session, role, scopedRoleLookup(settings, scope));
		return resolved
			? {
					provider: resolved.model.provider,
					modelId: resolved.model.id,
					...(resolved.thinkingLevel !== undefined ? { thinkingLevel: resolved.thinkingLevel } : {}),
				}
			: null;
	}

	/** Apply a role to the primary session model, like `--model @<role>` at launch. */
	async setRole(role: unknown): Promise<RpcSetRoleOutcome> {
		const session = this.#session;
		if (typeof role !== "string" || !getKnownRoleIds(session.settings).includes(role)) {
			return { ok: false, code: "unknown_role", message: `Unknown model role: ${String(role)}` };
		}
		if (session.isStreaming || session.isCompacting) {
			return {
				ok: false,
				code: "session_busy",
				message: "Cannot change the model role while the session is streaming or compacting",
			};
		}
		let resolved = resolveRole(session, role);
		if (!resolved) {
			// Discovery-backed providers can populate after startup; wait before refusing.
			await session.modelRegistry.awaitBackgroundRefresh();
			resolved = resolveRole(session, role);
		}
		if (!resolved) {
			const patterns = resolveConfiguredModelPatterns([formatModelRoleAlias(role)], session.settings);
			const tried = patterns.length > 0 ? `: ${patterns.join(", ")}` : "";
			return {
				ok: false,
				code: "role_unresolved",
				message: `No available model for role "${role}"${tried}`,
			};
		}

		await session.setModel(resolved.model, role);
		if (resolved.thinkingLevel !== undefined) session.setThinkingLevel(resolved.thinkingLevel);
		this.#remember(role);
		const model = session.model ?? resolved.model;
		return { ok: true, data: { role, model, thinkingLevel: session.thinkingLevel } };
	}

	/**
	 * The role the current model was selected through. A later direct model
	 * change (`set_model`, `cycle_model`, `/model`) records a newer model change
	 * and so clears it. Resumed sessions reuse the role recorded on the model
	 * change, except `default`, which is also what direct selection records.
	 */
	activeRole(): string | undefined {
		const last = lastSelectingModelChange(this.#session);
		const selection = this.#selection;
		if (selection && selection.sessionId === this.#session.sessionId && selection.entryId === last?.id) {
			return selection.role;
		}
		const recorded = last?.role;
		if (!recorded || recorded === "default") return undefined;
		return getKnownRoleIds(this.#session.settings).includes(recorded) ? recorded : undefined;
	}

	#remember(role: string): void {
		this.#selection = {
			role,
			sessionId: this.#session.sessionId,
			entryId: lastSelectingModelChange(this.#session)?.id,
		};
	}

	#launchRole(launchModel: string): string | undefined {
		const session = this.#session;
		const resolved = resolveCliModel({
			cliModel: launchModel,
			modelRegistry: session.modelRegistry,
			settings: session.settings,
			preferences: getModelMatchPreferences(session.settings),
		});
		if (!resolved.configuredRole || !resolved.model || !session.model) return undefined;
		return modelsAreEqual(resolved.model, session.model) ? resolved.configuredRole : undefined;
	}
}
