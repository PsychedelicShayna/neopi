import * as path from "node:path";
import { THINKING_EFFORTS, type Effort } from "@oh-my-pi/pi-catalog/effort";
import { MODEL_KINDS } from "@oh-my-pi/pi-catalog/types";
import { getProviderDefinition } from "../../registry/registry";
import { secretReference, type DecodeContext } from "./context";
import type { ConfigFields } from "./fields";
import type { ModelRow, ProviderConfig } from "./types";

const CHAT_PROTOCOLS = ["openai-chat", "openai-responses", "anthropic-messages"] as const;
const KIND_PROTOCOLS = { embedding: "openai-embeddings", rerank: "openrouter-rerank", image: "openai-images", tts: "openai-speech", stt: "openai-transcriptions", video: "openrouter-video" } as const;
const OPTION_NAMES: Readonly<Record<string, readonly string[]>> = {
	anthropic: ["betas", "cache_retention"], "openai-codex": ["prefer_websockets", "text_verbosity"], openrouter: ["variant"], "kimi-code": ["api_format"],
};

function headers(fields: ConfigFields, value: unknown, location: string): Record<string, string> {
	const result = fields.stringTable(value, location);
	for (const [name, header] of Object.entries(result)) {
		try { new Headers({ [name]: header }); }
		catch { fields.issue(`${location}.${name}`, "Invalid HTTP header name or value"); }
	}
	return result;
}

function modelRow(context: DecodeContext, value: unknown, location: string): ModelRow {
	const f = context.fields;
	const row = f.object(value, location, ["id", "upstream_id", "kind", "name", "context_window", "max_output", "reasoning", "efforts", "effort_map", "input", "supports_tools", "cost", "hidden", "aliases"]);
	const id = f.text(row.id, `${location}.id`);
	let efforts: Effort[] | undefined;
	if (row.efforts !== undefined) {
		const list = f.strings(row.efforts, `${location}.efforts`);
		if (!list.length) f.issue(`${location}.efforts`, "An effort ladder cannot be empty", "E-MODEL-INCOMPLETE");
		for (const [index, effort] of list.entries()) f.oneOf(effort, `${location}.efforts[${index}]`, THINKING_EFFORTS);
		efforts = list as Effort[];
	}
	let effortMap: Partial<Record<Effort, string>> | undefined;
	if (row.effort_map !== undefined) {
		f.object(row.effort_map, `${location}.effort_map`, THINKING_EFFORTS);
		effortMap = f.stringTable(row.effort_map, `${location}.effort_map`);
	}
	let input: ("text" | "image")[] | undefined;
	if (row.input !== undefined) {
		const list = f.strings(row.input, `${location}.input`);
		for (const [index, item] of list.entries()) f.oneOf(item, `${location}.input[${index}]`, ["text", "image"]);
		input = list as ("text" | "image")[];
	}
	let cost: ModelRow["cost"];
	if (row.cost !== undefined) {
		const prices = f.object(row.cost, `${location}.cost`, ["input", "output"]);
		f.number(prices.input, `${location}.cost.input`, { min: 0 });
		f.number(prices.output, `${location}.cost.output`, { min: 0 });
		cost = { input: f.num(prices.input, `${location}.cost.input`, 0), output: f.num(prices.output, `${location}.cost.output`, 0) };
	}
	return {
		id, upstreamId: f.text(row.upstream_id, `${location}.upstream_id`, id), kind: f.choice(row.kind, `${location}.kind`, MODEL_KINDS, "chat"),
		...(row.name !== undefined ? { name: f.text(row.name, `${location}.name`) } : {}),
		...(row.context_window !== undefined ? { contextWindow: f.num(row.context_window, `${location}.context_window`, 0, 1, true) } : {}),
		...(row.max_output !== undefined ? { maxOutput: f.num(row.max_output, `${location}.max_output`, 0, 1, true) } : {}),
		...(row.reasoning !== undefined ? { reasoning: f.flag(row.reasoning, `${location}.reasoning`, false) } : {}),
		...(efforts ? { efforts } : {}), ...(effortMap ? { effortMap } : {}), ...(input ? { input } : {}), ...(cost ? { cost } : {}),
		...(row.supports_tools !== undefined ? { supportsTools: f.flag(row.supports_tools, `${location}.supports_tools`, false) } : {}),
		hidden: f.flag(row.hidden, `${location}.hidden`, false), aliases: f.strings(row.aliases, `${location}.aliases`, true), declaredFields: Object.keys(row),
	};
}

export function decodeProvider(context: DecodeContext, value: unknown, location: string): ProviderConfig {
	const f = context.fields;
	const row = f.object(value, location, ["id", "kind", "catalog", "name", "category", "enabled", "protocol", "base_url", "auth", "keys", "pool", "headers", "discovery", "egress", "glue", "glue_ready_ms", "timeouts", "options", "protocols", "model"]);
	const id = f.id(row.id, `${location}.id`);
	const catalogId = f.text(row.catalog, `${location}.catalog`, id);
	const kind = f.choice(row.kind, `${location}.kind`, ["catalog", "http"], getProviderDefinition(catalogId) ? "catalog" : "http");
	if (kind === "catalog" && !getProviderDefinition(catalogId)) f.issue(`${location}.catalog`, "Unknown catalog provider", "E-PROVIDER-REQ");
	const protocol = row.protocol === undefined ? undefined : f.choice(row.protocol, `${location}.protocol`, CHAT_PROTOCOLS, "openai-chat");
	const baseUrl = f.optionalText(row.base_url, `${location}.base_url`);
	let upstream: URL | undefined;
	if (baseUrl !== undefined) {
		try { upstream = new URL(baseUrl); if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.hash) throw new Error(); }
		catch { f.issue(`${location}.base_url`, "Expected an HTTP(S) base URL without user information or a fragment", "E-PROVIDER-REQ"); }
	}
	let auth: ProviderConfig["auth"];
	if (row.auth !== undefined) {
		const configured = f.object(row.auth, `${location}.auth`, ["scheme", "header", "param", "key"]);
		f.oneOf(configured.scheme, `${location}.auth.scheme`, ["bearer", "header", "query", "none"]);
		const scheme = f.choice(configured.scheme, `${location}.auth.scheme`, ["bearer", "header", "query", "none"], "none");
		auth = { scheme, ...(configured.header !== undefined ? { header: f.text(configured.header, `${location}.auth.header`) } : {}), ...(configured.param !== undefined ? { param: f.text(configured.param, `${location}.auth.param`) } : {}), ...(configured.key !== undefined ? { key: secretReference(context, configured.key, `${location}.auth.key`) } : {}) };
		if (scheme === "header") {
			if (!auth.header) f.issue(`${location}.auth.header`, "Header auth requires its header name", "E-PROVIDER-REQ");
			else headers(f, { [auth.header]: "validation" }, `${location}.auth.header`);
		}
		if (scheme === "query" && !auth.param) f.issue(`${location}.auth.param`, "Query auth requires its parameter name", "E-PROVIDER-REQ");
		if (scheme !== "header" && configured.header !== undefined) f.issue(`${location}.auth.header`, "A header name belongs only to header auth", "E-PROVIDER-REQ");
		if (scheme !== "query" && configured.param !== undefined) f.issue(`${location}.auth.param`, "A query parameter belongs only to query auth", "E-PROVIDER-REQ");
	}
	const keys = row.keys === undefined ? undefined : f.array(row.keys, `${location}.keys`).map((key, index) => secretReference(context, key, `${location}.keys[${index}]`));
	if (auth?.key && keys !== undefined) f.issue(`${location}.keys`, "Use auth.key or keys, never both", "E-AUTH-EXCL");
	if (kind === "http") {
		if (!protocol || !baseUrl || !auth) f.issue(location, "HTTP providers require protocol, base_url and auth", "E-PROVIDER-REQ");
		if (auth && auth.scheme !== "none" && !auth.key && !keys?.length) f.issue(`${location}.auth`, "This auth scheme requires a secret or nonempty key pool", "E-SECRET-MISSING");
		if (auth?.scheme === "none" && (auth.key || keys !== undefined)) f.issue(`${location}.auth`, "Keyless auth cannot also configure credentials", "E-AUTH-EXCL");
		if (protocol === "anthropic-messages" && auth?.scheme === "bearer") f.issue(`${location}.auth.scheme`, "Anthropic-compatible auth uses an x-api-key header, not bearer auth", "E-PROVIDER-REQ");
	} else if (auth || keys !== undefined || protocol !== undefined) f.issue(location, "Catalog providers obtain their protocol and credentials from the catalog/auth store", "E-PROVIDER-REQ");
	const pool = f.object(row.pool ?? {}, `${location}.pool`, ["strategy", "cooldown_s"]);
	const timeouts = f.object(row.timeouts ?? {}, `${location}.timeouts`, ["first_event_ms", "idle_ms"]);
	const glueValue = f.optionalText(row.glue, `${location}.glue`);
	const glue = glueValue === undefined ? undefined : path.resolve(context.configDir, glueValue);
	const optionNames = ["headers", ...(kind === "catalog" && Object.hasOwn(OPTION_NAMES, catalogId) ? OPTION_NAMES[catalogId] : [])];
	const rawOptions = row.options ?? {};
	const beforeOptions = f.issues.length;
	const options = f.object(rawOptions, `${location}.options`, glue && typeof rawOptions === "object" && rawOptions !== null ? Object.keys(rawOptions) : optionNames);
	for (const issue of f.issues.slice(beforeOptions)) if (issue.code === "E-UNKNOWN-KEY") { issue.code = "E-OPTION"; issue.message = `Unknown provider option; accepted keys: ${optionNames.join(", ")}`; }
	if (options.headers !== undefined) options.headers = headers(f, options.headers, `${location}.options.headers`);
	if (kind === "catalog") {
		if (catalogId === "anthropic") {
			if (options.betas !== undefined) f.strings(options.betas, `${location}.options.betas`);
			f.oneOf(options.cache_retention, `${location}.options.cache_retention`, ["none", "short", "long"], true);
		} else if (catalogId === "openai-codex") {
			f.boolean(options.prefer_websockets, `${location}.options.prefer_websockets`, true);
			f.oneOf(options.text_verbosity, `${location}.options.text_verbosity`, ["low", "medium", "high"], true);
		} else if (catalogId === "openrouter") f.string(options.variant, `${location}.options.variant`, true);
		else if (catalogId === "kimi-code") f.oneOf(options.api_format, `${location}.options.api_format`, ["openai", "anthropic"], true);
	}
	const protocolsRaw = f.object(row.protocols ?? {}, `${location}.protocols`, Object.keys(KIND_PROTOCOLS));
	const protocols: ProviderConfig["protocols"] = {};
	for (const name of Object.keys(KIND_PROTOCOLS) as (keyof typeof KIND_PROTOCOLS)[]) if (protocolsRaw[name] !== undefined) {
		f.oneOf(protocolsRaw[name], `${location}.protocols.${name}`, [KIND_PROTOCOLS[name]]);
		protocols[name] = KIND_PROTOCOLS[name];
	}
	const egress = row.egress === undefined ? upstream ? [upstream.hostname] : [] : f.strings(row.egress, `${location}.egress`);
	for (const [index, host] of egress.entries()) if (!host || /[\s/@?#]/.test(host)) f.issue(`${location}.egress[${index}]`, "Expected an exact upstream hostname", "E-PROVIDER-REQ");
	return {
		id, kind, ...(kind === "catalog" ? { catalog: catalogId } : {}), name: f.text(row.name, `${location}.name`, id),
		category: f.choice(row.category, `${location}.category`, ["direct", "router", "rehost", "special"], "direct"), enabled: f.flag(row.enabled, `${location}.enabled`, true),
		...(protocol ? { protocol } : {}), ...(baseUrl !== undefined ? { baseUrl } : {}), ...(auth ? { auth } : {}), ...(keys ? { keys } : {}),
		pool: { strategy: f.choice(pool.strategy, `${location}.pool.strategy`, ["ordered", "round-robin", "least-used"], "ordered"), cooldownS: f.num(pool.cooldown_s, `${location}.pool.cooldown_s`, 60) },
		headers: headers(f, row.headers, `${location}.headers`), discovery: f.choice(row.discovery, `${location}.discovery`, ["catalog", "models", "static", "glue"], kind === "catalog" ? "catalog" : "models"),
		egress, ...(glue !== undefined ? { glue } : {}), glueReadyMs: f.num(row.glue_ready_ms, `${location}.glue_ready_ms`, 5000, 0, true),
		timeouts: { ...(timeouts.first_event_ms !== undefined ? { firstEventMs: f.num(timeouts.first_event_ms, `${location}.timeouts.first_event_ms`, 0, 0, true) } : {}), ...(timeouts.idle_ms !== undefined ? { idleMs: f.num(timeouts.idle_ms, `${location}.timeouts.idle_ms`, 0, 0, true) } : {}) },
		options, protocols, models: f.array(row.model, `${location}.model`, true).map((model, index) => modelRow(context, model, `${location}.model[${index}]`)),
	};
}
