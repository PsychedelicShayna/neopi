import { analyzePromptReferences, globalPromptHelpers } from "./analysis";
import { promptAssets } from "./catalog";
import type { PromptAsset, PromptContextKey } from "./types";

export interface PromptLexiconKey extends PromptContextKey {
	usage: "used" | "unused";
	usedBy: string[];
}

export interface PromptLexiconHelper {
	name: string;
	usage: "used" | "unused";
	usedBy: string[];
	scopes?: string[];
}

export interface PromptLexicon {
	helpers: PromptLexiconHelper[];
	scopes: { name: string; keys: PromptLexiconKey[] }[];
	engineNotes: string[];
}

const ENGINE_NOTES = [
	"Templates render with strict: false and noEscape: true. Check validates the exposed context without changing runtime rendering.",
	"SYSTEM.md, APPEND_SYSTEM.md, TITLE_SYSTEM.md and PERSONALITY.md are plain inserted text, not Handlebars templates.",
	"Live identity exposes OS account username and firstName only; it does not expose hostname or home directory.",
	"Runtime-generated strings and agent discovery are separate from built-in prompt template overrides.",
];

/** Compute used/exposed vocabulary from shipped template ASTs and real context contracts. */
export function getPromptLexicon(assets: readonly PromptAsset[] = promptAssets): PromptLexicon {
	const helperUses = new Map<string, Set<string>>();
	const helperScopes = new Map<string, Set<string>>();
	const scopeKeys = new Map<string, Map<string, PromptContextKey>>();
	const keyUses = new Map<string, Map<string, Set<string>>>();
	for (const name of globalPromptHelpers()) helperUses.set(name, new Set());
	for (const asset of assets) {
		let keys = scopeKeys.get(asset.scope);
		if (!keys) scopeKeys.set(asset.scope, (keys = new Map()));
		for (const key of asset.keys) if (!keys.has(key.path)) keys.set(key.path, key);
		let uses = keyUses.get(asset.scope);
		if (!uses) keyUses.set(asset.scope, (uses = new Map()));
		for (const name of asset.localHelpers ?? []) {
			if (!helperUses.has(name)) helperUses.set(name, new Set());
			let scopes = helperScopes.get(name);
			if (!scopes) helperScopes.set(name, (scopes = new Set()));
			scopes.add(asset.scope);
		}
		for (const ref of analyzePromptReferences(asset.bundled, asset.localHelpers)) {
			if (ref.kind === "helper") helperUses.get(ref.name)?.add(asset.id);
			else if (ref.kind === "variable") {
				const root = ref.path.split(".")[0].replaceAll("[]", "");
				if (!root || root.startsWith("@")) continue;
				let usedBy = uses.get(root);
				if (!usedBy) uses.set(root, (usedBy = new Set()));
				usedBy.add(asset.id);
			}
		}
	}
	return {
		helpers: [...helperUses]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, usedBy]) => ({
				name,
				usage: usedBy.size ? "used" : "unused",
				usedBy: [...usedBy].sort(),
				...(helperScopes.has(name) ? { scopes: [...helperScopes.get(name)!].sort() } : {}),
			})),
		scopes: [...scopeKeys]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, keys]) => ({
				name,
				keys: [...keys.values()]
					.sort((a, b) => a.path.localeCompare(b.path))
					.map(key => {
						const usedBy = [...(keyUses.get(name)?.get(key.path) ?? [])].sort();
						return { ...key, usage: usedBy.length ? "used" : "unused", usedBy };
					}),
			})),
		engineNotes: [...ENGINE_NOTES],
	};
}

export function getPromptAssetKeys(asset: PromptAsset): {
	id: string;
	scope: string;
	keys: PromptLexiconKey[];
	helpers: PromptLexiconHelper[];
	engineNotes: string[];
} {
	const lexicon = getPromptLexicon([asset]);
	return {
		id: asset.id,
		scope: asset.scope,
		keys: lexicon.scopes[0]?.keys ?? [],
		helpers: lexicon.helpers,
		engineNotes: lexicon.engineNotes,
	};
}
