/**
 * Named runtime model loadouts (`/loadout`).
 *
 * State lives in `<agentDir>/neopi-loadout.json` (legacy `omomp-loadout.json`
 * is read until the first write). Applying a loadout swaps model roles, retry
 * fallback chains, and task-agent model overrides as one volatile overlay via
 * `AgentSession.applyRuntimeModelLoadout`; only an idle session may switch.
 */
import * as nodePath from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { RuntimeModelLoadout } from "../extensibility/extensions/types";
import { isRecord, isStringRecord, JsonStateStore } from "./json-state";

export interface LoadoutState {
	schemaVersion: 1;
	loadouts: Record<string, RuntimeModelLoadout>;
	activeLoadout: string | null;
}

export const emptyLoadoutState = (): LoadoutState => ({ schemaVersion: 1, loadouts: {}, activeLoadout: null });

const isLoadout = (v: unknown): v is RuntimeModelLoadout =>
	isRecord(v) &&
	typeof v.name === "string" &&
	typeof v.mainModel === "string" &&
	isStringRecord(v.modelRoles) &&
	isRecord(v.retryFallbackChains) &&
	Object.values(v.retryFallbackChains).every(x => Array.isArray(x) && x.every(y => typeof y === "string")) &&
	isStringRecord(v.taskAgentModelOverrides);

export function validateLoadoutState(v: unknown): LoadoutState {
	if (
		!isRecord(v) ||
		v.schemaVersion !== 1 ||
		!isRecord(v.loadouts) ||
		!Object.values(v.loadouts).every(isLoadout) ||
		(v.activeLoadout !== null && typeof v.activeLoadout !== "string")
	)
		throw new Error("Invalid schema-v1 neopi-loadout.json");
	return v as unknown as LoadoutState;
}

export const defaultLoadoutStatePath = (): string => nodePath.join(getAgentDir(), "neopi-loadout.json");

export class LoadoutStore extends JsonStateStore<LoadoutState> {
	constructor(path: string | (() => string) = defaultLoadoutStatePath) {
		super(path, "omomp-loadout.json", validateLoadoutState, emptyLoadoutState);
	}
}

export const LOADOUT_STATUS_KEY = "neopi-loadout";

/** Session capabilities a loadout switch needs. */
export interface LoadoutHost {
	isIdle(): boolean;
	applyRuntimeModelLoadout(loadout: RuntimeModelLoadout | undefined): Promise<void>;
	setStatus?(key: string, text: string | undefined): void;
}

export interface LoadoutData {
	items: Array<{ name: string; loadout: RuntimeModelLoadout; active: boolean }>;
	active?: string;
}

export interface LoadoutFeature {
	data(): Promise<LoadoutData>;
	list(): Promise<string>;
	show(name: string): Promise<string>;
	status(): Promise<string>;
	use(name: string, host: LoadoutHost): Promise<string>;
	off(host: LoadoutHost): Promise<string>;
}

export function createLoadoutFeature(store: LoadoutStore = new LoadoutStore()): LoadoutFeature {
	async function data(): Promise<LoadoutData> {
		const state = await store.read();
		return {
			items: Object.entries(state.loadouts)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, loadout]) => ({ name, loadout, active: name === state.activeLoadout })),
			...(state.activeLoadout ? { active: state.activeLoadout } : {}),
		};
	}
	function requireIdle(host: LoadoutHost): void {
		if (!host.isIdle()) throw new Error("Loadouts can only change while the session is idle");
	}
	return {
		data,
		async list() {
			const d = await data();
			return d.items.length
				? d.items.map(x => `${x.active ? "*" : "-"} ${x.name} (${x.loadout.mainModel})`).join("\n")
				: "No loadouts.";
		},
		async show(name) {
			const value = (await store.read()).loadouts[name];
			if (!value) throw new Error(`Unknown loadout: ${name}`);
			return JSON.stringify(value, null, 2);
		},
		async status() {
			const active = (await store.read()).activeLoadout;
			return active ? `Loadout: ${active}` : "Loadout: off";
		},
		async use(name, host) {
			requireIdle(host);
			const state = await store.read();
			const value = state.loadouts[name];
			if (!value) throw new Error(`Unknown loadout: ${name}`);
			const previous = state.activeLoadout;
			await host.applyRuntimeModelLoadout(value);
			try {
				state.activeLoadout = name;
				await store.write(state);
			} catch (error) {
				await host.applyRuntimeModelLoadout(previous ? state.loadouts[previous] : undefined);
				throw error;
			}
			host.setStatus?.(LOADOUT_STATUS_KEY, `loadout: ${name}`);
			return `Loadout '${name}' active.`;
		},
		async off(host) {
			requireIdle(host);
			const state = await store.read();
			const previous = state.activeLoadout;
			await host.applyRuntimeModelLoadout(undefined);
			try {
				state.activeLoadout = null;
				await store.write(state);
			} catch (error) {
				if (previous && state.loadouts[previous]) await host.applyRuntimeModelLoadout(state.loadouts[previous]);
				throw error;
			}
			host.setStatus?.(LOADOUT_STATUS_KEY, undefined);
			return "Loadout off.";
		},
	};
}

let sharedLoadouts: LoadoutFeature | undefined;

export function loadoutFeature(): LoadoutFeature {
	sharedLoadouts ??= createLoadoutFeature();
	return sharedLoadouts;
}
