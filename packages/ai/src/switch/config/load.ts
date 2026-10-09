import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sha256, valueHash } from "../crypto";
import { SwitchError } from "../error";
import type { Issue } from "../wire";
import { type DecodeContext } from "./context";
import { decodePlan, decodeSwitchDocument } from "./document";
import { ConfigFields } from "./fields";
import { decodeProvider } from "./providers";
import type { SecretRef, SwitchConfig } from "./types";
import { validateSwitchConfig, type ValidationContext } from "./validate";

interface CapturedFile {
	bytes: Buffer;
	digest: string;
	mode: number;
	stat: Pick<Stats, "dev" | "ino" | "mtimeMs" | "size" | "mode">;
}
export interface LoadedSwitchConfig {
	config: SwitchConfig;
	warnings: Issue[];
	/** Secret values stay generation-local, never serialized into admin read models. */
	secrets: ReadonlyMap<SecretRef, string>;
}

function fingerprint(row: CapturedFile["stat"]): string {
	return `${row.dev}:${row.ino}:${row.mtimeMs}:${row.size}:${row.mode}`;
}

async function file(pathname: string, files: Map<string, CapturedFile>): Promise<CapturedFile> {
	const previous = files.get(pathname);
	if (previous) return previous;
	const before = await fs.stat(pathname);
	const bytes = await fs.readFile(pathname);
	const after = await fs.stat(pathname);
	if (fingerprint(before) !== fingerprint(after) || after.size !== bytes.byteLength) throw new SourceChanged();
	const captured = { bytes, digest: sha256(bytes), mode: after.mode, stat: after };
	files.set(pathname, captured);
	return captured;
}

class SourceChanged extends Error {}

function parseToml(source: string, bytes: Buffer): Record<string, unknown> {
	try {
		const parsed: unknown = Bun.TOML.parse(bytes.toString("utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		throw new Error("The document must be a table");
	} catch (error) {
		throw new SwitchError(422, "validation", "TOML parsing failed", {
			issues: [{ code: "E-TOML", path: source, message: String(error) }],
		});
	}
}

async function providerSources(configDir: string): Promise<string[]> {
	const directory = path.join(configDir, "providers.d");
	let names: string[];
	try {
		names = await fs.readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return names
		.filter(name => name.endsWith(".toml"))
		.sort()
		.map(name => path.join(directory, name));
}

function duplicate(fields: ConfigFields, list: readonly string[], location: string, code: string): void {
	const seen = new Set<string>();
	for (const [index, id] of list.entries()) {
		if (seen.has(id)) fields.issue(`${location}[${index}]`, `Duplicate identifier ${id}`, code);
		seen.add(id);
	}
}

async function resolveSecrets(
	context: DecodeContext,
	files: Map<string, CapturedFile>,
): Promise<Map<SecretRef, string>> {
	const resolved = new Map<SecretRef, string>();
	for (const { reference, location } of context.secrets) {
		if (reference.kind === "sealed") continue;
		if (reference.kind === "inline") {
			resolved.set(reference, reference.value);
			continue;
		}
		if (reference.kind === "env") {
			const secret = process.env[reference.name];
			if (secret === undefined)
				context.fields.issue(location, "Secret environment variable is unset", "E-SECRET-MISSING");
			else resolved.set(reference, secret);
			continue;
		}
		try {
			const captured = await file(reference.path, files);
			if ((captured.mode & 0o077) !== 0)
				context.warnings.push({
					code: "W-SECRET-MODE",
					path: location,
					message: "Secret file is readable by group or world",
				});
			resolved.set(reference, captured.bytes.toString("utf8").trim());
		} catch (error) {
			if (error instanceof SourceChanged) throw error;
			context.fields.issue(location, "Secret file could not be read", "E-SECRET-MISSING");
		}
	}
	return resolved;
}

export async function loadSwitchConfig(
	configDir: string,
	validation: Omit<ValidationContext, "configDir">,
): Promise<LoadedSwitchConfig> {
	const root = path.resolve(configDir);
	for (let pass = 0; pass < 3; pass++) {
		const files = new Map<string, CapturedFile>();
		try {
			const providerPaths = await providerSources(root);
			const mainPath = path.join(root, "switch.toml");
			let main: CapturedFile;
			try {
				main = await file(mainPath, files);
			} catch (error) {
				if (error instanceof SourceChanged) throw error;
				throw new SwitchError(422, "validation", "switch.toml is required", {
					issues: [{ code: "E-TOML", path: mainPath, message: "Required configuration file could not be read" }],
				});
			}
			const fields = new ConfigFields();
			const warnings: Issue[] = [];
			const context: DecodeContext = { fields, warnings, configDir: root, source: mainPath, secrets: [] };
			const parsed = parseToml(mainPath, main.bytes);
			const value = decodeSwitchDocument(context, parsed);
			for (const pathname of providerPaths) {
				const captured = await file(pathname, files);
				context.source = pathname;
				const part = parseToml(pathname, captured.bytes);
				fields.object(part, pathname, ["provider", "plan"]);
				for (const [section, decoder] of [
					["provider", "provider"],
					["plan", "plan"],
				] as const) {
					const rows = fields.array(part[section], `${pathname}.${section}`, true);
					if (decoder === "provider")
						value.providers.push(
							...rows.map((row, index) => decodeProvider(context, row, `${pathname}.provider[${index}]`)),
						);
					else
						value.plans.push(...rows.map((row, index) => decodePlan(context, row, `${pathname}.plan[${index}]`)));
				}
			}
			duplicate(
				fields,
				value.providers.map(provider => provider.id),
				"provider",
				"E-DUP-PROVIDER",
			);
			duplicate(
				fields,
				value.plans.map(plan => plan.id),
				"plan",
				"E-DUP-PLAN",
			);
			duplicate(
				fields,
				value.models.map(model => model.id),
				"model",
				"E-DUP-MODEL",
			);
			duplicate(
				fields,
				value.endpoints.map(endpoint => endpoint.id),
				"endpoint",
				"E-DUP-ENDPOINT",
			);
			duplicate(
				fields,
				value.endpoints.map(
					endpoint => `${endpoint.bind.hostname.toLowerCase()}:${endpoint.bind.port}:${endpoint.route}`,
				),
				"endpoint",
				"E-DUP-ENDPOINT",
			);
			duplicate(fields, value.admin?.tokens.map(token => token.name) ?? [], "admin.token", "E-DUP-ADMIN-TOKEN");
			const secrets = await resolveSecrets(context, files);
			for (const provider of value.providers)
				if (provider.glue) {
					try {
						await file(provider.glue, files);
					} catch (error) {
						if (error instanceof SourceChanged) throw error;
						fields.issue(`provider:${provider.id}.glue`, "Glue executable cannot be read", "E-GLUE");
					}
				}
			if (JSON.stringify(providerPaths) !== JSON.stringify(await providerSources(root))) throw new SourceChanged();
			for (const [pathname, captured] of files) {
				let current: Awaited<ReturnType<typeof fs.stat>>;
				try {
					current = await fs.stat(pathname);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SourceChanged();
					throw error;
				}
				if (fingerprint(current) !== fingerprint(captured.stat)) throw new SourceChanged();
			}
			const sources = [...files]
				.map(([pathname, captured]) => ({ path: pathname, sha256: captured.digest }))
				.sort((a, b) => a.path.localeCompare(b.path));
			const digest = valueHash({
				document: value,
				sources,
				environmentSecrets: [...secrets]
					.filter(([reference]) => reference.kind === "env")
					.map(([reference, secret]) => [reference.kind === "env" ? reference.name : "", sha256(secret)]),
			});
			const config: SwitchConfig = { ...value, sources, digest };
			validateSwitchConfig(config, fields, warnings, { ...validation, configDir: root });
			return { config, warnings, secrets };
		} catch (error) {
			if (error instanceof SourceChanged) continue;
			throw error;
		}
	}
	throw new SwitchError(422, "validation", "Configuration source changed during every read pass", {
		issues: [{ code: "E-RELOAD-UNSTABLE", path: root, message: "Three consecutive passes changed mid-read" }],
	});
}
