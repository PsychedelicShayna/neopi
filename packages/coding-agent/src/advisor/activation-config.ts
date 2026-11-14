import * as path from "node:path";
import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import type {
	AdvisorActivationIdentity,
	AdvisorActivationSetEntry,
	AdvisorActivationSetScope,
	AdvisorActivationSetSource,
} from "@oh-my-pi/pi-tui/overlays/advisor-activation-sets";
import { getKnownRoleIds, getRoleInfo } from "../config/model-roles";
import { cfgRoleSettings, type RoleSettings } from "../config/role-settings";
import type { Settings, SettingsScope } from "../config/settings";
import { discoverAdvisorConfigs, loadWatchdogConfigFile, saveWatchdogConfigFile } from "./config";
import {
	advisorVisibleToActivationSet,
	cfgAdvisorActivation,
	cfgAdvisorActivationSet,
	cfgAdvisorEnabled,
} from "./settings";

function settingsScope(scope: AdvisorActivationSetScope): SettingsScope {
	return scope === "user" ? "global" : scope === "session" ? "session" : "project";
}
function roleEntries(settings: Settings, scope: AdvisorActivationSetScope): RoleSettings {
	return (settings.readScopeValue(cfgRoleSettings, settingsScope(scope)) as RoleSettings | undefined) ?? {};
}

/** Adapter for the configure overlay; writes only the explicitly chosen settings layer. */
export function createAdvisorActivationSetSource(
	settings: Settings,
	dirs: { cwd: string; agentDir: string; sessionDir?: string },
): AdvisorActivationSetSource {
	return {
		getRoles: () => {
			const roles = new Set([
				...(settings.activeRole ? [settings.activeRole] : []),
				...Object.keys(roleEntries(settings, "session")),
				...Object.keys(roleEntries(settings, "project-omp")),
				...Object.keys(roleEntries(settings, "user")),
				...getKnownRoleIds(settings),
			]);
			return [...roles].map(id => ({ id, label: getRoleInfo(id, settings).name }));
		},
		getActiveRole: () => settings.activeRole,
		getActiveScope: () => {
			const scope = cfgAdvisorActivation.get(settings).scope;
			return scope === "project" ? "project-omp" : scope;
		},
		getOverrideNote: (advisor: AdvisorConfig) => {
			const activation = cfgAdvisorActivation.get(settings);
			if (activation.ids === null) return undefined;
			const visible = advisorVisibleToActivationSet(activation.scope, advisor.sourceScope);
			const selected = visible && advisor.id !== undefined && activation.ids.includes(advisor.id);
			return `Role ${activation.role ?? "(ordinary settings)"} set overrides own ${advisor.enabled === false ? "off" : "on"} flag: ${selected ? "selected" : "not selected"}${visible ? "" : " (out of scope)"}. Edit role set.`;
		},
		load: async (role, scope) => {
			const scopes: AdvisorActivationSetScope[] =
				scope === "session"
					? ["session", "project-omp", "user"]
					: scope === "project-omp"
						? ["project-omp", "user"]
						: ["user"];
			const own = roleEntries(settings, scope)[role]?.[cfgAdvisorActivationSet.id];
			let ids: readonly string[] | null = null;
			let supplyingScope: AdvisorActivationSetScope | undefined;
			let ordinary: readonly string[] | null | undefined;
			for (const layer of scopes) {
				const value = roleEntries(settings, layer)[role]?.[cfgAdvisorActivationSet.id];
				if (value !== undefined) {
					ids = value as readonly string[] | null;
					supplyingScope = layer;
					break;
				}
			}
			for (const layer of scopes) {
				const value = settings.readScopeValue(cfgAdvisorActivationSet, settingsScope(layer));
				if (value !== undefined) {
					ordinary = value as readonly string[] | null;
					break;
				}
			}
			const discovered = await discoverAdvisorConfigs(dirs.cwd, dirs.agentDir, dirs.sessionDir);
			const entries: AdvisorActivationSetEntry[] = [];
			const winners = new Map<string, AdvisorActivationSetEntry>();
			for (const file of discovered.files) {
				const doc = await loadWatchdogConfigFile(file.path);
				const fileIds = new Set<string>();
				for (const [index, advisor] of doc.advisors.entries()) {
					const duplicate = advisor.id !== undefined && fileIds.has(advisor.id);
					if (advisor.id) fileIds.add(advisor.id);
					const entry: AdvisorActivationSetEntry = {
						key: `${file.path}:${index}`,
						advisor,
						index,
						path: file.path,
						scope: file.scope,
						visible: advisorVisibleToActivationSet(scope === "project-omp" ? "project" : scope, file.scope),
						fileEnabled: doc.enabled !== false,
						unavailableReason: duplicate ? "duplicate ID in source file; edit advisor file to repair" : undefined,
					};
					entries.push(entry);
					if (advisor.id && !duplicate && entry.fileEnabled) winners.set(advisor.id, entry);
				}
			}
			for (const entry of entries) {
				const winner = entry.advisor.id ? winners.get(entry.advisor.id) : undefined;
				if (winner && winner !== entry)
					entry.unavailableReason ??= `ID shadowed by ${winner.scope} source ${winner.path}`;
			}
			const file =
				supplyingScope === "session"
					? dirs.sessionDir
						? path.join(dirs.sessionDir, "settings.yml")
						: "Session settings (volatile)"
					: settings.getConfigFile(supplyingScope === "project-omp" ? "project" : "global");
			const activation = cfgAdvisorActivation.get(settings);
			return {
				ids,
				entries,
				globalEnabled: cfgAdvisorEnabled.get(settings),
				inherited: own === undefined && supplyingScope !== undefined,
				source: supplyingScope === undefined ? "per-advisor flags" : file,
				effectiveNote:
					ids === null && ordinary != null
						? "Ordinary advisor.activationSet still overrides flags. It is not copied into this role draft; create a role set to override it."
						: activation.role === role && activation.ids !== null
							? `Currently active set resolves from ${activation.scope}; this editor writes only ${scope}.`
							: undefined,
			};
		},
		save: async (role, scope, selection) => {
			const ids = selection.ids === null ? null : new Set(selection.ids);
			const assigned: AdvisorActivationIdentity[] = [];
			if (ids) {
				const byPath = new Map<string, AdvisorActivationSetEntry[]>();
				for (const entry of selection.legacy) {
					if (
						!entry.visible ||
						entry.unavailableReason ||
						!advisorVisibleToActivationSet(scope === "project-omp" ? "project" : scope, entry.scope)
					)
						throw new Error("Advisor is outside this role set's visible roster");
					const group = byPath.get(entry.path) ?? [];
					group.push(entry);
					byPath.set(entry.path, group);
				}
				for (const [file, entries] of byPath) {
					const doc = await loadWatchdogConfigFile(file);
					for (const entry of entries) {
						const advisor = doc.advisors[entry.index];
						if (!advisor || !Bun.deepEquals(advisor, entry.advisor))
							throw new Error("Advisor changed; reopen the role set before saving");
						const before = structuredClone(advisor);
						advisor.id ??= crypto.randomUUID();
						ids.add(advisor.id);
						assigned.push({ path: file, index: entry.index, id: advisor.id, before });
					}
					await saveWatchdogConfigFile(file, doc, { advisorField: "id" });
				}
			}
			const roles = roleEntries(settings, scope);
			roles[role] = { ...roles[role], [cfgAdvisorActivationSet.id]: ids === null ? null : [...ids] };
			settings.writeScopeValue(cfgRoleSettings, roles, settingsScope(scope));
			if (scope === "session") await settings.saveSessionSettings();
			else await settings.flush();
			return assigned;
		},
	};
}
