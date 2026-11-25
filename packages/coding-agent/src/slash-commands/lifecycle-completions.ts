import * as path from "node:path";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import {
	listAllSessions,
	listSessionsReadOnly,
	sessionDisplayName,
	sessionMatchesResumeArg,
} from "../session/session-listing";
import { loadPinnedSessionIds } from "../session/session-pins";
import { FileSessionStorage } from "../session/session-storage";
import { expandTilde } from "../tools/path-utils";
import { argumentValues, buildDirectoryArgumentCompletions, completeCurrentArgument } from "./builtin-completions";
import { buildModelSelectorCompletions } from "./model-selector-completions";
import type { ArgumentValueProvider, TuiSlashCommandRuntime } from "./types";

const foreignSessionSelectors = ["@claude", "@codex"];

export function sessionArgumentCompletions(
	mode: "resume" | "pin" | "unpin",
): (prefix: string, runtime?: TuiSlashCommandRuntime) => Promise<AutocompleteItem[] | null> {
	return async (prefix, runtime) => {
		const query = prefix.trimStart();
		if (/\s/.test(query)) return null;
		const lower = query.toLowerCase();
		const items: AutocompleteItem[] =
			mode === "resume"
				? foreignSessionSelectors
						.filter(selector => selector.startsWith(lower))
						.map(selector => ({
							value: `${selector} `,
							label: selector,
							preserveInputOnSubmit: !query,
							submitsCommand: true,
						}))
				: [];
		if (!runtime || query.startsWith("@")) return items.length ? items : null;

		const storage = new FileSessionStorage();
		const [local, global, pinned] = await Promise.all([
			listSessionsReadOnly(runtime.ctx.sessionManager.getSessionDir(), storage),
			listAllSessions(storage),
			mode === "unpin" ? loadPinnedSessionIds() : undefined,
		]);
		const seen = new Set<string>();
		for (const sessions of [local, global]) {
			for (const session of sessions) {
				if (!session.id || /\s/.test(session.id) || seen.has(session.id)) continue;
				if (pinned && !pinned.has(session.id)) continue;
				if (!sessionMatchesResumeArg(session, query)) continue;
				seen.add(session.id);
				items.push({
					value: `${session.id} `,
					label: sanitizeText(session.id),
					description: sessionDisplayName(session),
					preserveInputOnSubmit: !query,
					submitsCommand: true,
				});
			}
		}
		return items.length ? items : null;
	};
}

const cleanseFlags = argumentValues("--all", "-a", "--tests", "-t", "--agents", "-n", "--model", "-m");

export function completeCleanseArguments(prefix: string, runtime?: TuiSlashCommandRuntime) {
	return completeCurrentArgument(prefix, runtime, (query, currentRuntime, previous) => {
		let valueFor: "agents" | "model" | undefined;
		for (const token of previous) {
			if (valueFor) valueFor = undefined;
			else if (token === "--agents" || token === "-n") valueFor = "agents";
			else if (token === "--model" || token === "-m") valueFor = "model";
		}
		if (valueFor === "agents") return null;
		if (valueFor === "model") {
			if (!currentRuntime) return null;
			return (
				buildModelSelectorCompletions(currentRuntime)(query)?.map(item => ({ ...item, submitsCommand: false })) ??
				null
			);
		}
		if (query && !query.startsWith("-")) return null;
		const flags = cleanseFlags(query);
		return query === "" && flags ? flags.map(item => ({ ...item, preserveInputOnSubmit: true })) : flags;
	});
}

export const completeMentalModelId: ArgumentValueProvider = async (prefix, runtime) => {
	const state = runtime?.ctx.session.getHindsightSessionState();
	if (!state || state.aliasOf || !state.config.mentalModelsEnabled) return null;
	try {
		const { items } = await state.client.listMentalModels(state.bankId, { detail: "metadata" });
		const lower = prefix.toLowerCase();
		const matches = (items ?? [])
			.filter(item => item.id && !/\s/.test(item.id) && item.id.toLowerCase().startsWith(lower))
			.map(item => ({ value: `${item.id} `, label: sanitizeText(item.id), description: sanitizeText(item.name) }));
		return matches.length ? matches : null;
	} catch {
		return null;
	}
};

export const completeOptionalMentalModelId: ArgumentValueProvider = async (prefix, runtime, previous) => {
	const items = await completeMentalModelId(prefix, runtime, previous);
	return prefix === "" && items ? items.map(item => ({ ...item, preserveInputOnSubmit: true })) : items;
};

export function completeAddDirectory(prefix: string, runtime?: TuiSlashCommandRuntime) {
	const ctx = runtime?.ctx;
	const manager = ctx?.focusedAgentId ? ctx.viewSession.sessionManager : ctx?.sessionManager;
	return buildDirectoryArgumentCompletions({ cwd: manager?.getCwd() })(prefix);
}

export function completeRemoveDirectory(prefix: string, runtime?: TuiSlashCommandRuntime): AutocompleteItem[] | null {
	const ctx = runtime?.ctx;
	const sessionManager = ctx?.focusedAgentId ? ctx.viewSession.sessionManager : ctx?.sessionManager;
	if (!sessionManager) return null;
	const cwd = sessionManager.getCwd();
	const query = expandTilde(prefix.trimStart());
	const lower = (path.isAbsolute(query) ? path.normalize(query) : path.join(cwd, query)).toLowerCase();
	const matches: AutocompleteItem[] = [];
	for (const directory of sessionManager.getAdditionalDirectories()) {
		if (!/[\r\n]/.test(directory) && (!query || directory.toLowerCase().startsWith(lower))) {
			matches.push({ value: directory, label: sanitizeText(directory) });
		}
	}
	return matches.length ? matches : null;
}
