/**
 * MCP configuration loader.
 *
 * Uses the capability system to load MCP servers from multiple sources.
 */

import { getMCPConfigPath, logger } from "@oh-my-pi/pi-utils";
import { mcpCapability } from "../capability/mcp";
import type { EffectiveExtensionRoots, SourceMeta } from "../capability/types";
import type { MCPServer } from "../discovery";
import { loadCapability } from "../discovery";
import { readMCPConfigFile } from "./config-writer";
import type { MCPConfigFile, MCPServerConfig } from "./types";

/** Options for loading MCP configs */
export interface LoadMCPConfigsOptions {
	/** Whether to load project-level config (default: true) */
	enableProjectConfig?: boolean;
	/** Whether to filter out Exa MCP servers (default: true) */
	filterExa?: boolean;
	/** Whether to filter out browser MCP servers when the built-in browser capability is enabled (default: false) */
	filterBrowser?: boolean;
	/** Session-local extension roots for post-startup rediscovery (explicit + mode + configured). */
	extensionRoots?: EffectiveExtensionRoots;
	/** Server name globs to admit; empty or absent admits every server. */
	includeServers?: readonly string[];
}

/** Result of loading MCP configs */
export interface LoadMCPConfigsResult {
	/** Loaded server configs */
	configs: Record<string, MCPServerConfig>;
	/** Extracted Exa API keys (if any were filtered) */
	exaApiKeys: string[];
	/** Source metadata for each server */
	sources: Record<string, SourceMeta>;
	/**
	 * `includeServers` entries without glob metacharacters that name no
	 * available server (unconfigured, disabled, or denylisted).
	 */
	unmatchedIncludes?: string[];
}

const MCP_GLOB_METACHARACTERS = /[*?[\]{}\\]/;

/** Whether an `includeServers` entry is a glob pattern rather than a literal server name. */
export function isMCPGlobPattern(entry: string): boolean {
	return MCP_GLOB_METACHARACTERS.test(entry);
}

/** A compiled `mcp.includeServers` allowlist. */
export interface MCPAllowlist {
	/** String entries, in order. */
	readonly patterns: readonly string[];
	/** Non-string entries (malformed settings), rendered for error messages. */
	readonly invalid: readonly string[];
	/** Whether a server with this name may be spawned. */
	admits(serverName: string): boolean;
}

/**
 * Compile allowlist entries. Settings files are not type-checked per entry,
 * so non-string entries are reported as invalid and fail closed: a non-empty
 * list never degrades to unrestricted.
 */
export function compileMCPAllowlist(entries: readonly unknown[] | undefined): MCPAllowlist {
	const list = entries ?? [];
	const patterns = list.filter((entry): entry is string => typeof entry === "string");
	const invalid = list.filter(entry => typeof entry !== "string").map(entry => JSON.stringify(entry) ?? String(entry));
	const globs = patterns.map(pattern => new Bun.Glob(pattern));
	return {
		patterns,
		invalid,
		admits: serverName => list.length === 0 || globs.some(glob => glob.match(serverName)),
	};
}

/**
 * A literal `--mcp` / `mcp.includeServers` entry names no available server.
 * Thrown before any server starts, so a typo cannot leave a run with an
 * allowlist that silently matches nothing.
 */
export class MCPUnknownServerError extends Error {
	readonly serverNames: readonly string[];

	constructor(serverNames: readonly string[]) {
		super(
			`MCP allowlist (--mcp / mcp.includeServers) names no available server: ${serverNames.join(", ")}. ` +
				"The server is not configured, is disabled, or is in disabledServers.",
		);
		this.name = "MCPUnknownServerError";
		this.serverNames = serverNames;
	}
}

/**
 * Convert canonical MCPServer to legacy MCPServerConfig.
 */
function convertToLegacyConfig(server: MCPServer): MCPServerConfig {
	// Determine transport type
	const transport = server.transport ?? (server.command ? "stdio" : server.url ? "http" : "stdio");
	const shared = {
		enabled: server.enabled,
		timeout: server.timeout,
		requestIdFormat: server.requestIdFormat,
		instructions: server.instructions,
		auth: server.auth,
		oauth: server.oauth,
	};

	if (transport === "stdio") {
		const config: MCPServerConfig = {
			...shared,
			type: "stdio" as const,
			command: server.command ?? "",
		};
		if (server.args) config.args = server.args;
		if (server.env) config.env = server.env;
		if (server.envPolicy) config.envPolicy = server.envPolicy;
		if (server.envLiteralKeys) config.envLiteralKeys = server.envLiteralKeys;
		if (server.cwd) config.cwd = server.cwd;
		return config;
	}

	if (transport === "http") {
		const config: MCPServerConfig = {
			...shared,
			type: "http" as const,
			url: server.url ?? "",
		};
		if (server.headers) config.headers = server.headers;
		if (server.headerPolicy) config.headerPolicy = server.headerPolicy;
		return config;
	}

	if (transport === "sse") {
		const config: MCPServerConfig = {
			...shared,
			type: "sse" as const,
			url: server.url ?? "",
		};
		if (server.headers) config.headers = server.headers;
		if (server.headerPolicy) config.headerPolicy = server.headerPolicy;
		return config;
	}

	// Fallback to stdio
	return {
		...shared,
		type: "stdio" as const,
		command: server.command ?? "",
	};
}

/**
 * Load all MCP server configs from standard locations.
 * Uses the capability system for multi-source discovery.
 *
 * @param cwd Working directory (project root)
 * @param options Load options
 */
export async function loadAllMCPConfigs(cwd: string, options?: LoadMCPConfigsOptions): Promise<LoadMCPConfigsResult> {
	const enableProjectConfig = options?.enableProjectConfig ?? true;
	const filterExa = options?.filterExa ?? true;
	const filterBrowser = options?.filterBrowser ?? false;

	// Load user-level disable/force-enable lists. The denylist always wins; the
	// allowlist overrides a non-writable source config's `enabled: false`.
	// A malformed or unreadable user mcp.json must not take down the whole MCP
	// stack (docs/mcp-config.md: the file simply contributes no entries): its
	// servers are already skipped by the mcp-json provider with a warning, so
	// the lists degrade to empty here instead of rejecting every source.
	const userPath = getMCPConfigPath("user", cwd);
	let userConfig: MCPConfigFile;
	try {
		const config: unknown = await readMCPConfigFile(userPath);
		// JSON.parse also accepts bare `null`, numbers, strings, and arrays;
		// only an object carries the server map and the lists read below.
		if (config === null || typeof config !== "object" || Array.isArray(config)) {
			throw new Error("user MCP config must be a JSON object");
		}
		userConfig = config as MCPConfigFile;
	} catch (error) {
		logger.warn("Ignoring unreadable user MCP config for server lists", { path: userPath, error: String(error) });
		userConfig = { mcpServers: {} };
	}
	const disabledServers = new Set(Array.isArray(userConfig.disabledServers) ? userConfig.disabledServers : []);
	const forcedEnabled = new Set(Array.isArray(userConfig.enabledServers) ? userConfig.enabledServers : []);

	// Scope exclusions drop entries entirely BEFORE deduplication: with project
	// config disabled, a project entry must not shadow anything.
	const includeServer = (server: MCPServer & { _source: SourceMeta }): boolean =>
		enableProjectConfig || server._source.level !== "project";

	// Disabled servers are suppressed rather than dropped: they still own their
	// name at key-level dedupe (a disabled project `foo` keeps a same-named,
	// lower-priority user `foo` disabled), but never equivalence-shadow a
	// differently-named enabled server — otherwise the disabled alias would be
	// removed downstream and starve the surviving connection.
	// Allowlist misses are suppressed like disabled servers, for the same
	// dedupe reason: they keep their name but never shadow an admitted server.
	const allowlist = compileMCPAllowlist(options?.includeServers);
	const suppressServer = (server: MCPServer & { _source: SourceMeta }): boolean => {
		if (disabledServers.has(server.name)) return true;
		if (server.enabled === false && !forcedEnabled.has(server.name)) return true;
		if (!allowlist.admits(server.name)) return true;
		return false;
	};

	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		extensionRoots: options?.extensionRoots,
		filter: includeServer,
		suppress: suppressServer,
	});

	// Convert to legacy format and preserve source metadata.
	let configs: Record<string, MCPServerConfig> = {};
	let sources: Record<string, SourceMeta> = {};
	for (const server of result.items) {
		configs[server.name] = convertToLegacyConfig(server);
		sources[server.name] = server._source;
	}

	// Checked before the Exa/browser filters: those servers exist, NeoPi just
	// replaces them natively, so naming one is not a typo.
	const unmatchedIncludes: string[] = [...allowlist.invalid];
	for (const pattern of allowlist.patterns) {
		if (configs[pattern]) continue;
		if (!isMCPGlobPattern(pattern)) {
			unmatchedIncludes.push(pattern);
		} else if (!Object.keys(configs).some(name => new Bun.Glob(pattern).match(name))) {
			logger.warn("MCP allowlist pattern matches no available server", { pattern });
		}
	}

	let exaApiKeys: string[] = [];

	if (filterExa) {
		const exaResult = filterExaMCPServers(configs, sources);
		configs = exaResult.configs;
		sources = exaResult.sources;
		exaApiKeys = exaResult.exaApiKeys;
	}

	if (filterBrowser) {
		const browserResult = filterBrowserMCPServers(configs, sources);
		configs = browserResult.configs;
		sources = browserResult.sources;
	}

	return { configs, exaApiKeys, sources, unmatchedIncludes };
}

/** Pattern to match Exa MCP servers */
const EXA_MCP_URL_PATTERN = /mcp\.exa\.ai/i;
const EXA_API_KEY_PATTERN = /exaApiKey=([^&\s]+)/i;

/**
 * Check if a server config is an Exa MCP server.
 */
export function isExaMCPServer(name: string, config: MCPServerConfig): boolean {
	// Check by server name
	if (name.toLowerCase() === "exa") {
		return true;
	}

	// Check by URL for HTTP/SSE servers
	if (config.type === "http" || config.type === "sse") {
		const httpConfig = config as { url?: string };
		if (httpConfig.url && EXA_MCP_URL_PATTERN.test(httpConfig.url)) {
			return true;
		}
	}

	// Check by args for stdio servers (e.g., mcp-remote to exa)
	if (!config.type || config.type === "stdio") {
		const stdioConfig = config as { args?: string[] };
		if (stdioConfig.args?.some(arg => EXA_MCP_URL_PATTERN.test(arg))) {
			return true;
		}
	}

	return false;
}

/**
 * Extract Exa API key from an MCP server config.
 */
export function extractExaApiKey(config: MCPServerConfig): string | undefined {
	// Check URL for HTTP/SSE servers
	if (config.type === "http" || config.type === "sse") {
		const httpConfig = config as { url?: string };
		if (httpConfig.url) {
			const match = EXA_API_KEY_PATTERN.exec(httpConfig.url);
			if (match) return match[1];
		}
	}

	// Check args for stdio servers
	if (!config.type || config.type === "stdio") {
		const stdioConfig = config as { args?: string[] };
		if (stdioConfig.args) {
			for (const arg of stdioConfig.args) {
				const match = EXA_API_KEY_PATTERN.exec(arg);
				if (match) return match[1];
			}
		}
	}

	// Check env vars
	if ("env" in config && config.env) {
		const envConfig = config as { env: Record<string, string> };
		if (envConfig.env.EXA_API_KEY) {
			return envConfig.env.EXA_API_KEY;
		}
	}

	return undefined;
}

/** Exa MCP tools already covered by the native Exa integration. */
const NATIVE_EXA_MCP_TOOLS: Record<string, true> = { web_search_exa: true };

/**
 * Parse the comma-separated `tools` restriction from an Exa MCP config.
 * Returns `null` when the config does not restrict its tool set.
 */
function getRequestedExaMcpTools(config: MCPServerConfig): string[] | null {
	const raw = (() => {
		if (config.type === "http" || config.type === "sse") {
			const httpConfig = config as { url?: string };
			if (!httpConfig.url) return undefined;
			try {
				return new URL(httpConfig.url).searchParams.get("tools") ?? undefined;
			} catch {
				return undefined;
			}
		}
		if (!config.type || config.type === "stdio") {
			const stdioConfig = config as { args?: string[] };
			const args = stdioConfig.args ?? [];
			for (let i = 0; i < args.length; i++) {
				if (/^--?tools$/i.test(args[i])) return args[i + 1];
				const match = args[i].match(/(?:^|[\s?&])tools=([^&\s]+)/i) ?? args[i].match(/--?tools[=\s]([^\s]+)/i);
				if (match) return match[1];
			}
		}
		return undefined;
	})();
	if (!raw) return null;
	const tools = raw
		.split(",")
		.map(tool => tool.trim())
		.filter(tool => tool.length > 0);
	return tools.length > 0 ? tools : null;
}

/** Result of filtering Exa MCP servers */
export interface ExaFilterResult {
	/** Configs with Exa servers removed */
	configs: Record<string, MCPServerConfig>;
	/** Extracted Exa API keys (if any) */
	exaApiKeys: string[];
	/** Source metadata for remaining servers */
	sources: Record<string, SourceMeta>;
}

/**
 * Filter out Exa MCP servers and extract their API keys.
 * Since we have native Exa integration, we don't need the MCP server —
 * unless the config explicitly requests Exa tools the native integration
 * does not provide (e.g. `web_fetch_exa`, `web_search_advanced_exa`).
 */
export function filterExaMCPServers(
	configs: Record<string, MCPServerConfig>,
	sources: Record<string, SourceMeta>,
): ExaFilterResult {
	const filtered: Record<string, MCPServerConfig> = {};
	const filteredSources: Record<string, SourceMeta> = {};
	const exaApiKeys: string[] = [];

	for (const [name, config] of Object.entries(configs)) {
		if (isExaMCPServer(name, config)) {
			// Extract API key for the native Exa integration even when the MCP
			// server is kept below for its extra tools.
			const apiKey = extractExaApiKey(config);
			if (apiKey) {
				exaApiKeys.push(apiKey);
			}
			const requested = getRequestedExaMcpTools(config);
			const hasExtraTools = requested?.some(tool => !NATIVE_EXA_MCP_TOOLS[tool.toLowerCase()]) ?? false;
			if (!hasExtraTools) {
				continue;
			}
		}
		filtered[name] = config;
		if (sources[name]) {
			filteredSources[name] = sources[name];
		}
	}

	return { configs: filtered, exaApiKeys, sources: filteredSources };
}

/**
 * Validate server config has required fields.
 */
export function validateServerConfig(name: string, config: MCPServerConfig): string[] {
	const errors: string[] = [];

	const serverType = config.type ?? "stdio";

	// Check for conflicting transport fields
	const hasCommand = "command" in config && config.command;
	const hasUrl = "url" in config && (config as { url?: string }).url;
	if (hasCommand && hasUrl) {
		errors.push(
			`Server "${name}": both "command" and "url" are set - server should be either stdio (command) OR http/sse (url), not both`,
		);
	}

	if (serverType === "stdio") {
		const stdioConfig = config as { command?: string };
		if (!stdioConfig.command) {
			errors.push(`Server "${name}": stdio server requires "command" field`);
		}
	} else if (serverType === "http" || serverType === "sse") {
		const httpConfig = config as { url?: string };
		if (!httpConfig.url) {
			errors.push(`Server "${name}": ${serverType} server requires "url" field`);
		}
	} else {
		errors.push(`Server "${name}": unknown server type "${serverType}"`);
	}

	return errors;
}

export interface BrowserMCPPreludeFilterOptions {
	restrictToolNames: boolean;
	browserEnabled: boolean;
	evalRegistered: boolean;
	evalActive: boolean;
}

/** Browser MCP filtering is valid only when the built-in prelude is callable. */
export function shouldFilterBrowserMCPForPrelude(options: BrowserMCPPreludeFilterOptions): boolean {
	return !options.restrictToolNames && options.browserEnabled && options.evalRegistered && options.evalActive;
}

/** Known browser automation MCP server names (lowercase) */
const BROWSER_MCP_NAMES = new Set([
	"puppeteer",
	"playwright",
	"browserbase",
	"browser-tools",
	"browser-use",
	"browser",
]);

/** Patterns matching browser MCP package names in command/args */
const BROWSER_MCP_PKG_PATTERN =
	// Official packages
	// - @modelcontextprotocol/server-puppeteer
	// - @playwright/mcp
	// - @browserbasehq/mcp-server-browserbase
	// - @agentdeskai/browser-tools-mcp
	// - @agent-infra/mcp-server-browser
	// Community packages: puppeteer-mcp-server, playwright-mcp, pptr-mcp, etc.
	/(?:@modelcontextprotocol\/server-puppeteer|@playwright\/mcp|@browserbasehq\/mcp-server-browserbase|@agentdeskai\/browser-tools-mcp|@agent-infra\/mcp-server-browser|puppeteer-mcp|playwright-mcp|pptr-mcp|browser-use-mcp|mcp-browser-use)/i;

/** URL patterns for hosted browser MCP services */
const BROWSER_MCP_URL_PATTERN = /browserbase\.com|browser-use\.com/i;

/**
 * Check if a server config is a browser automation MCP server.
 */
export function isBrowserMCPServer(name: string, config: MCPServerConfig): boolean {
	// Check by server name
	if (BROWSER_MCP_NAMES.has(name.toLowerCase())) {
		return true;
	}

	// Check by URL for HTTP/SSE servers
	if (config.type === "http" || config.type === "sse") {
		const httpConfig = config as { url?: string };
		if (httpConfig.url && BROWSER_MCP_URL_PATTERN.test(httpConfig.url)) {
			return true;
		}
	}

	// Check by command/args for stdio servers
	if (!config.type || config.type === "stdio") {
		const stdioConfig = config as { command?: string; args?: string[] };
		if (stdioConfig.command && BROWSER_MCP_PKG_PATTERN.test(stdioConfig.command)) {
			return true;
		}
		if (stdioConfig.args?.some(arg => BROWSER_MCP_PKG_PATTERN.test(arg))) {
			return true;
		}
	}

	return false;
}

/** Result of filtering browser MCP servers */
export interface BrowserFilterResult {
	/** Configs with browser servers removed */
	configs: Record<string, MCPServerConfig>;
	/** Source metadata for remaining servers */
	sources: Record<string, SourceMeta>;
}

/**
 * Filter out browser automation MCP servers.
 * Since we have a native browser capability, we don't need these MCP servers.
 */
export function filterBrowserMCPServers(
	configs: Record<string, MCPServerConfig>,
	sources: Record<string, SourceMeta>,
): BrowserFilterResult {
	const filtered: Record<string, MCPServerConfig> = {};
	const filteredSources: Record<string, SourceMeta> = {};

	for (const [name, config] of Object.entries(configs)) {
		if (!isBrowserMCPServer(name, config)) {
			filtered[name] = config;
			if (sources[name]) {
				filteredSources[name] = sources[name];
			}
		}
	}

	return { configs: filtered, sources: filteredSources };
}
