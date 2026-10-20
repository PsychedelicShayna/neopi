import * as prompt from "@oh-my-pi/pi-utils/prompt";
import { TemplateSyntaxError } from "@oh-my-pi/pi-utils/template";
import "../config/prompt-templates";
import { boundedEditDistance } from "../utils/string-distance";
import { analyzePromptReferences, globalPromptHelpers, type PromptReference } from "./analysis";
import { promptAssets } from "./catalog";
import type { PromptAsset, PromptContextKey, PromptDiagnostic } from "./types";

export interface ValidatePromptOptions {
	file?: string;
	fixture?: Record<string, unknown>;
	runtime?: boolean;
	strict?: boolean;
	strictWarnings?: boolean;
}

function nearest(name: string, candidates: Iterable<string>): string[] {
	return [...new Set(candidates)]
		.map(candidate => {
			let prefix = 0;
			while (prefix < name.length && name[prefix] === candidate[prefix]) prefix++;
			return {
				candidate,
				distance: boundedEditDistance(
					name.toLowerCase(),
					candidate.toLowerCase(),
					Math.max(name.length, candidate.length),
				),
				prefix,
			};
		})
		.sort((a, b) => a.distance - b.distance || b.prefix - a.prefix || a.candidate.localeCompare(b.candidate))
		.slice(0, 3)
		.map(item => item.candidate);
}

function lookupKey(
	keys: readonly PromptContextKey[],
	path: string,
): { key?: PromptContextKey; invalid?: string; expected?: string } {
	if (!path || path.startsWith("@")) return {};
	const parts = path.replaceAll("[]", "").split(".");
	let siblings = keys;
	let key: PromptContextKey | undefined;
	for (let i = 0; i < parts.length; i++) {
		key = siblings.find(candidate => candidate.path === parts[i]);
		if (!key)
			return {
				invalid: parts.slice(0, i + 1).join("."),
				expected: siblings.map(candidate => candidate.path).join(" | "),
			};
		if (i < parts.length - 1) {
			const member = parts[i + 1];
			const array = /\[\]|Array</.test(key.type);
			if (member === "length" && (array || key.type === "string")) {
				return i + 1 === parts.length - 1
					? { key: { path: member, type: "number" } }
					: { invalid: path, expected: "number" };
			}
			if (array && /^\d+$/.test(member)) {
				i++;
				if (i === parts.length - 1) return { key };
			}
			if (key.children) siblings = key.children;
			else if (/unknown|any|record|object/i.test(key.type)) return { key };
			else return { invalid: path, expected: key.type };
		}
	}
	return { key };
}

function hasValue(context: Record<string, unknown>, path: string): boolean {
	let value: unknown = context;
	for (const part of path.split(".")) {
		if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return false;
		value = (value as Record<string, unknown>)[part];
	}
	return value !== undefined;
}

/** Validate template source without changing the renderer's permissive runtime contract. */
export function validatePrompt(
	asset: PromptAsset,
	text: string,
	options: ValidatePromptOptions = {},
): PromptDiagnostic[] {
	const diagnostics: PromptDiagnostic[] = [];
	const file = options.file ?? asset.relPath;
	const helpers = new Set([...globalPromptHelpers(), ...(asset.localHelpers ?? [])]);
	function report(
		ref: PromptReference,
		code: string,
		message: string,
		candidates: string[] = [],
		expectedType?: string,
		hint?: string,
	): void {
		diagnostics.push({
			code,
			severity: "error",
			file,
			line: ref.loc.start.line,
			column: ref.loc.start.column,
			endLine: ref.loc.end.line,
			endColumn: ref.loc.end.column,
			expression: ref.expression,
			scope: asset.scope,
			message,
			candidates,
			expectedType,
			hint,
		});
	}
	let references: PromptReference[];
	try {
		references = analyzePromptReferences(text, asset.localHelpers);
		prompt.compile(text);
	} catch (error) {
		const loc = error instanceof TemplateSyntaxError ? error.loc : undefined;
		return [
			{
				code: "compile-error",
				severity: "error",
				file,
				line: loc?.start.line ?? 1,
				column: loc?.start.column ?? 1,
				endLine: loc?.end.line ?? 1,
				endColumn: loc?.end.column ?? 1,
				expression: loc ? text.slice(loc.start.offset, loc.end.offset) : "",
				scope: asset.scope,
				message: error instanceof Error ? error.message : String(error),
				candidates: [],
				hint: "Balance template blocks and expressions before rendering.",
			},
		];
	}
	for (const ref of references) {
		if (ref.kind === "partial") {
			report(ref, "unknown-partial", `Partial '${ref.name}' is not exposed in scope '${asset.scope}'.`);
			continue;
		}
		if (ref.kind === "helper") {
			if (!helpers.has(ref.name))
				report(
					ref,
					"unknown-helper",
					`Unknown helper '${ref.name}'.`,
					nearest(ref.name, helpers),
					undefined,
					"Only registered global helpers and this scope's local helpers are available.",
				);
			continue;
		}
		if (!ref.path || ["@index", "@key", "@first", "@last", "@root"].includes(ref.path)) continue;
		const root = ref.path.split(".")[0].replaceAll("[]", "");
		const key = asset.keys.find(candidate => candidate.path === root);
		if (!key) {
			const otherScopes = [
				...new Set(
					promptAssets
						.filter(
							candidate => candidate.scope !== asset.scope && candidate.keys.some(item => item.path === root),
						)
						.map(candidate => candidate.scope),
				),
			];
			report(
				ref,
				otherScopes.length ? "wrong-scope" : "unknown-variable",
				`Unknown variable '${ref.name}' in scope '${asset.scope}'.`,
				nearest(
					root,
					asset.keys.map(item => item.path),
				),
				undefined,
				otherScopes.length
					? `'${root}' is exposed in ${otherScopes.join(", ")}, not ${asset.scope}.`
					: "Use a variable listed by prompts keys or prompts lexicon; SYSTEM.md remains plain text.",
			);
			continue;
		}
		const nested = lookupKey(asset.keys, ref.path);
		if (nested.invalid)
			report(
				ref,
				"bad-type-path",
				`Path '${ref.name}' is not available on the declared type.`,
				[],
				nested.expected,
				`'${root}' is ${key.type}.`,
			);
	}
	for (const key of asset.keys) {
		if (!key.required || key.resolution !== "runtime-only" || hasValue(options.fixture ?? {}, key.path)) continue;
		diagnostics.push({
			code: "missing-required-runtime",
			severity: options.runtime ? "error" : "note",
			file,
			line: 1,
			column: 1,
			endLine: 1,
			endColumn: 1,
			expression: key.path,
			scope: asset.scope,
			expectedType: key.type,
			candidates: [],
			message: `Required runtime value '${key.path}' was not supplied.`,
			hint: "Supply --fixture with this runtime value; static checking uses a canned fixture.",
		});
	}
	if (!diagnostics.some(item => item.severity === "error")) {
		try {
			prompt.render(text, { ...asset.fixture, ...options.fixture });
		} catch (error) {
			diagnostics.push({
				code: "render-error",
				severity: "error",
				file,
				line: 1,
				column: 1,
				endLine: 1,
				endColumn: 1,
				expression: "",
				scope: asset.scope,
				candidates: [],
				message: error instanceof Error ? error.message : String(error),
				hint: "Check the declared variable types and supply a representative --fixture.",
			});
		}
	}
	if (options.strictWarnings) for (const item of diagnostics) if (item.severity === "warning") item.severity = "error";
	return diagnostics;
}
