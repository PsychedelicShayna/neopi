import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { PRODUCT_NAME, sanitizeText } from "@oh-my-pi/pi-utils";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseInternalUrl } from "../../internal-urls/parse";
import { SecurityProtocolHandler } from "../../internal-urls/security-protocol";
import validationRequestPrompt from "../../prompts/security/validate-request.md" with { type: "text" };
import { selectSecurityOAuthAccount } from "../../security/auth";
import {
	type CodexSecurityCloudConfiguration,
	CodexSecurityCloudClient,
	pullCodexSecurityCloudResults,
} from "../../security/cloud";
import type { SecurityDispositionStatus } from "../../security/contracts";
import type { SecurityPreflightInput } from "../../security/coordinator";
import { getSecurityCoordinator, listKnownSecurityOperations } from "../../security/coordinator";
import { importCodexSecurityBundle, importSarifFile } from "../../security/importers";
import type { SecurityTargetRequest } from "../../security/preflight";
import { SecurityStore, writeSecurityFileAtomic } from "../../security/store";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { parseCommandArgs } from "../../utils/command-args";
import {
	argumentValues,
	buildArgumentCompletions,
	buildDirectoryArgumentCompletions,
	completeCurrentArgument,
} from "../builtin-completions";
import type {
	ArgumentValueProvider,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SubcommandDef,
	TuiSlashCommandRuntime,
} from "../types";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./parse";

import { cfgSecurityEnabled } from "../../tools/settings";

interface SecurityPlanCliOptions {
	target: SecurityTargetRequest;
	knowledgeBasePaths: string[];
	outputRoot?: string;
	archiveExisting?: boolean;
	credentialId?: number;
}

const DISPOSITIONS: ReadonlySet<SecurityDispositionStatus> = new Set([
	"open",
	"false_positive",
	"accepted_risk",
	"fixed",
	"wont_fix",
]);

const EXPORT_FORMATS = ["bundle", "sarif", "report"] as const;
const CLOUD_PROVIDER = "openai-codex";
// Only explicit cloud commands populate suggestions. Typing never contacts the provider.
const CLOUD_OPTIONS = new WeakMap<SlashCommandRuntime["session"], Map<number, CodexSecurityCloudConfiguration[]>>();

type OptionSlots = Readonly<Record<string, readonly (ArgumentValueProvider | null)[]>>;

function completionContext(runtime: TuiSlashCommandRuntime | undefined) {
	if (!runtime || !cfgSecurityEnabled.get(runtime.ctx.settings)) return null;
	return { session: runtime.ctx.session, cwd: runtime.ctx.sessionManager.getCwd() };
}

async function withCompletionStore(
	runtime: TuiSlashCommandRuntime | undefined,
	complete: (store: SecurityStore) => Promise<AutocompleteItem[] | null>,
) {
	const context = completionContext(runtime);
	if (!context) return null;
	try {
		return await complete(await SecurityStore.openForCwd(context.cwd, { initialize: false }));
	} catch {
		return null;
	}
}

function scanValues(acceptsUri: boolean): ArgumentValueProvider {
	return (prefix, runtime) =>
		withCompletionStore(runtime, async store => {
			const ids = await store.listIds("scan");
			const values =
				acceptsUri && prefix.toLowerCase().startsWith("security:") ? ids.map(id => `security://scans/${id}`) : ids;
			return argumentValues(...values)(prefix);
		});
}

const scanIdValues = scanValues(false);
const planIdValues: ArgumentValueProvider = (prefix, runtime) =>
	withCompletionStore(runtime, async store => argumentValues(...(await store.listIds("plan")))(prefix));

async function findingValues(store: SecurityStore, scanId: string, prefix: string, uriPrefix = "") {
	if (!/^secscan_[a-z0-9]+$/i.test(scanId)) return null;
	const lower = prefix.toLowerCase();
	return (await store.listFindings(scanId))
		.filter(finding => finding.id.toLowerCase().startsWith(lower))
		.map(finding => ({
			value: `${uriPrefix}${finding.id} `,
			label: finding.id,
			description: `${finding.severity.level}: ${sanitizeText(finding.title)}`,
			submitsCommand: false,
		}));
}

const findingIdValues: ArgumentValueProvider = (prefix, runtime, previous) =>
	withCompletionStore(runtime, store => findingValues(store, previous[0] ?? "", prefix));

function scanResourceValues(findingOnly: boolean): ArgumentValueProvider {
	return (prefix, runtime, previous) => {
		if (!prefix.toLowerCase().startsWith("security:")) return scanIdValues(prefix, runtime, previous);
		return withCompletionStore(runtime, async store => {
			const lower = prefix.toLowerCase();
			const findingsPath = /^security:\/\/scans\/(secscan_[a-z0-9]+)\/findings\/([^/]*)$/i.exec(prefix);
			if (findingsPath) {
				const scanId = findingsPath[1]!;
				return findingValues(store, scanId, findingsPath[2]!, `security://scans/${scanId}/findings/`);
			}
			const ids = await store.listIds("scan");
			if (findingOnly) {
				return ids
					.map(id => `security://scans/${id}/findings/`)
					.filter(uri => uri.toLowerCase().startsWith(lower))
					.map(uri => ({ value: uri, label: uri, submitsCommand: false }));
			}
			const root = "security://scans";
			const paths = [root];
			for (const id of ids) {
				const scan = `${root}/${id}`;
				paths.push(scan);
				if (lower.startsWith(`${scan.toLowerCase()}/`)) {
					for (const child of ["findings", "manifest", "coverage", "provenance"]) paths.push(`${scan}/${child}`);
				}
			}
			return argumentValues(...paths)(prefix);
		});
	};
}

function operationValues(cancellableOnly: boolean): ArgumentValueProvider {
	return async (prefix, runtime) => {
		const context = completionContext(runtime);
		if (!context) return null;
		const operations = new Map<string, string>(
			listKnownSecurityOperations(context.cwd, context.session.sessionId, cancellableOnly).map(snapshot => [
				snapshot.operationId,
				snapshot.phase,
			]),
		);
		if (!cancellableOnly) {
			try {
				const store = await SecurityStore.openForCwd(context.cwd, { initialize: false });
				for (const scanId of await store.listIds("scan")) {
					const scan = await store.getScan(scanId);
					const operationId = scan?.provenance.metadata?.operationId;
					if (scan && typeof operationId === "string" && !operations.has(operationId)) {
						operations.set(operationId, scan.status);
					}
				}
			} catch {
				// Preserve the live coordinator entries if persisted state cannot be read.
			}
		}
		const lower = prefix.toLowerCase();
		return [...operations]
			.filter(([id]) => id.toLowerCase().startsWith(lower))
			.map(([id, phase]) => ({
				value: `${id} `,
				label: id,
				description: phase,
				submitsCommand: !cancellableOnly,
			}));
	};
}

function pathValues(includeFiles: boolean): ArgumentValueProvider {
	return async (prefix, runtime) => {
		if (!runtime || /^["']?~/.test(prefix)) return null;
		const items = await buildDirectoryArgumentCompletions({
			cwd: runtime.ctx.sessionManager.getCwd(),
			includeFiles,
		})(prefix.replace(/^["']|["']$/g, ""));
		return (
			items?.flatMap(item => {
				const value = item.value;
				if (!/[\t "']/.test(value)) return [item];
				const quote = !value.includes('"') ? '"' : !value.includes("'") ? "'" : null;
				if (!quote) return [];
				// Keep the quote open while descending into a directory.
				return [{ ...item, value: `${quote}${value}${value.endsWith("/") ? "" : quote}` }];
			}) ?? null
		);
	};
}

const pathOrFileValues = pathValues(true);
const directoryValues = pathValues(false);

const revisionValues: ArgumentValueProvider = async (prefix, runtime) => {
	if (!runtime) return null;
	const repo = vcs.git(runtime.ctx.sessionManager.getCwd());
	if (!repo) return null;
	const refs = await repo.listBranches(true).catch(() => []);
	return argumentValues("HEAD", ...refs)(prefix);
};

function credentialValues(provider?: string): ArgumentValueProvider {
	return (prefix, runtime) => {
		const context = completionContext(runtime);
		const providerId = provider ?? context?.session.model?.provider;
		if (!context || !providerId) return null;
		const { session } = context;
		const accounts = session.modelRegistry.authStorage.oauth.accounts(providerId, session.sessionId);
		return argumentValues(...accounts.map(account => String(account.credentialId)))(prefix);
	};
}

const PLAN_OPTIONS = {
	"--path": [pathOrFileValues],
	"--exclude": [pathOrFileValues],
	"--working-tree": [],
	"--diff": [revisionValues, revisionValues],
	"--knowledge-base": [pathOrFileValues],
	"--output": [directoryValues],
	"--archive-existing": [],
	"--credential": [credentialValues()],
} satisfies OptionSlots;

const EXPORT_OPTIONS = {
	"--output": [pathOrFileValues],
	"--format": [argumentValues(...EXPORT_FORMATS)],
} satisfies OptionSlots;

const cloudCredential = credentialValues(CLOUD_PROVIDER);
const cloudLookback = argumentValues("all");

function cachedCloudConfigurations(runtime: TuiSlashCommandRuntime | undefined, previous: readonly string[]) {
	const context = completionContext(runtime);
	if (!context) return [];
	const { session } = context;
	const cache = CLOUD_OPTIONS.get(session);
	if (!cache) return [];
	try {
		const selectedIndex = previous.lastIndexOf("--credential");
		const id = selectedIndex === -1 ? undefined : parsePositiveCredential(previous[selectedIndex + 1] ?? "");
		const account = selectSecurityOAuthAccount(
			session.modelRegistry.authStorage,
			CLOUD_PROVIDER,
			id,
			session.sessionId,
		);
		return cache.get(account.credentialId) ?? [];
	} catch {
		return [];
	}
}

function cloudConfigurationValues(key: "id" | "repositoryId" | "environmentId"): ArgumentValueProvider {
	return (prefix, runtime, previous) => {
		const configurations = cachedCloudConfigurations(runtime, previous);
		const ids = configurations.map(configuration => configuration[key]).filter(id => /^[a-z0-9_./:-]+$/i.test(id));
		return argumentValues(...new Set(ids))(prefix);
	};
}

function completeOptions(options: OptionSlots, positional?: ArgumentValueProvider): ArgumentValueProvider {
	const flags = argumentValues(...Object.keys(options));
	return (prefix, runtime, previous) => {
		let hasPositional = false;
		for (let index = 0; index < previous.length; index++) {
			const token = previous[index]!;
			const slots = Object.hasOwn(options, token) ? options[token] : undefined;
			if (!slots) {
				if (!positional || hasPositional || token.startsWith("--")) return null;
				hasPositional = true;
				continue;
			}
			for (const slot of slots) {
				index++;
				if (index === previous.length) return slot?.(prefix, runtime, previous) ?? null;
				if (!previous[index] || previous[index]!.startsWith("--")) return null;
			}
		}
		const choices = flags(prefix);
		if (!positional || hasPositional || prefix.startsWith("-")) return choices;
		const extras = positional(prefix, runtime, previous);
		return extras instanceof Promise
			? extras.then(items => [...(choices ?? []), ...(items ?? [])])
			: [...(choices ?? []), ...(extras ?? [])];
	};
}

/** Bind active-argument completion while retaining the option prefix verbatim. */
function optionTail(provider: ArgumentValueProvider): NonNullable<SubcommandDef["getArgumentCompletions"]> {
	return (prefix, runtime) => completeCurrentArgument(prefix, runtime, provider);
}

const completePlanOptions = completeOptions(PLAN_OPTIONS);
const completeExportOptions = completeOptions(EXPORT_OPTIONS);
const scanIdOrUriValues = scanValues(true);
const completeCloudLookup = completeOptions({ "--credential": [cloudCredential] }, cloudConfigurationValues("id"));
const CLOUD_SUBCOMMANDS: SubcommandDef[] = [
	{
		name: "scans",
		get description() {
			return t("commands.security.cloudScansDescription");
		},
		usage: "[--credential <id>]",
		getArgumentCompletions: optionTail(completeOptions({ "--credential": [cloudCredential] })),
	},
	{
		name: "start",
		get description() {
			return t("commands.security.cloudStartDescription");
		},
		usage: "--repo-id <id> --repo-url <url> --environment <id> [--lookback <days|all>] [--credential <id>]",
		getArgumentCompletions: optionTail(
			completeOptions({
				"--repo-id": [cloudConfigurationValues("repositoryId")],
				"--repo-url": [null],
				"--environment": [cloudConfigurationValues("environmentId")],
				"--lookback": [cloudLookback],
				"--credential": [cloudCredential],
			}),
		),
	},
	{
		name: "status",
		get description() {
			return t("commands.security.cloudStatusDescription");
		},
		usage: "<configuration-id> [--credential <id>]",
		getArgumentCompletions: optionTail(completeCloudLookup),
	},
	{
		name: "pull",
		get description() {
			return t("commands.security.cloudPullDescription");
		},
		usage: "<configuration-id> [--credential <id>]",
		getArgumentCompletions: optionTail(completeCloudLookup),
	},
];

export const SECURITY_SUBCOMMANDS: SubcommandDef[] = [
	{
		name: "plan",
		get description() {
			return t("commands.security.planDescription");
		},
		usage: "[options]",
		getArgumentCompletions: optionTail(completePlanOptions),
	},
	{
		name: "scan",
		get description() {
			return t("commands.security.scanDescription");
		},
		usage: "[plan-id | options]",
		getArgumentCompletions: optionTail(async (active, runtime, previous) => {
			if (previous[0]?.startsWith("secplan_")) return null;
			const flags = await completePlanOptions(active, runtime, previous);
			const ids =
				previous.length === 0 && !active.startsWith("-") ? await planIdValues(active, runtime, previous) : null;
			return [...(ids ?? []), ...(flags ?? [])];
		}),
	},
	{
		name: "status",
		get description() {
			return t("commands.security.statusDescription");
		},
		usage: "[operation-id]",
		arguments: [operationValues(false)],
	},
	{
		name: "cancel",
		get description() {
			return t("commands.security.cancelDescription");
		},
		usage: "<operation-id>",
		arguments: [operationValues(true)],
	},
	{
		name: "scans",
		get description() {
			return t("commands.security.scansDescription");
		},
	},
	{
		name: "cloud",
		get description() {
			return t("commands.security.cloudDescription");
		},
		usage: "[scans|start|status|pull]",
		getArgumentCompletions: (prefix, runtime) =>
			buildArgumentCompletions(CLOUD_SUBCOMMANDS, { optional: true, runtime })(prefix),
	},
	{
		name: "show",
		get description() {
			return t("commands.security.showDescription");
		},
		usage: "<scan-id | security:// URI>",
		arguments: [scanResourceValues(false)],
	},
	{
		name: "import",
		get description() {
			return t("commands.security.importDescription");
		},
		usage: "<path>",
		arguments: [pathOrFileValues],
	},
	{
		name: "export",
		get description() {
			return t("commands.security.exportDescription");
		},
		usage: "<scan-id> --output <path> [--format bundle|sarif|report]",
		getArgumentCompletions: optionTail((active, runtime, previous) =>
			previous.length === 0
				? scanIdOrUriValues(active, runtime, previous)
				: completeExportOptions(active, runtime, previous.slice(1)),
		),
	},
	{
		name: "validate",
		get description() {
			return t("commands.security.validateDescription", { product: PRODUCT_NAME });
		},
		usage: "<finding URI | scan-id finding-id>",
		arguments: [scanResourceValues(true), findingIdValues],
	},
	{
		name: "compare",
		get description() {
			return t("commands.security.compareDescription");
		},
		usage: "<before-scan-id> <after-scan-id>",
		arguments: [scanIdValues, scanIdValues],
	},
	{
		name: "disposition",
		get description() {
			return t("commands.security.dispositionDescription");
		},
		usage: "<scan-id> <finding-id> <status> [rationale]",
		arguments: [scanIdValues, findingIdValues, argumentValues(...DISPOSITIONS), null],
	},
];

function coordinatorFor(runtime: SlashCommandRuntime) {
	return getSecurityCoordinator({
		cwd: runtime.cwd,
		settings: runtime.settings,
		authStorage: runtime.session.modelRegistry.authStorage,
		modelRegistry: runtime.session.modelRegistry,
		activeModel: runtime.session.model,
		sessionId: runtime.session.sessionId,
		agentId: runtime.session.getAgentId(),
		asyncJobManager: runtime.session.asyncJobManager,
	});
}

function requireToken(tokens: readonly string[], index: number, flag: string): string {
	const value = tokens[index];
	if (!value || value.startsWith("--")) throw new Error(t("commands.security.flagNeedsValue", { flag }));
	return value;
}

function parsePositiveCredential(value: string): number {
	const credentialId = Number(value);
	if (!Number.isSafeInteger(credentialId) || credentialId < 1)
		throw new Error(t("commands.security.invalidCredential", { id: value }));
	return credentialId;
}

function parsePlanOptions(rest: string): SecurityPlanCliOptions {
	const tokens = parseCommandArgs(rest);
	const includePaths: string[] = [];
	const excludePaths: string[] = [];
	const knowledgeBasePaths: string[] = [];
	let kind: SecurityTargetRequest["kind"] = "repository";
	let baseRevision: string | undefined;
	let headRevision: string | undefined;
	let outputRoot: string | undefined;
	let archiveExisting = false;
	let credentialId: number | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		switch (token) {
			case "--path":
				includePaths.push(requireToken(tokens, ++index, token));
				// `--path` scopes the target; it never overrides an explicit --diff/--working-tree selection.
				if (kind === "repository") kind = "scoped_path";
				break;
			case "--exclude":
				excludePaths.push(requireToken(tokens, ++index, token));
				break;
			case "--working-tree":
				kind = "working_tree";
				break;
			case "--diff":
				kind = "ref_diff";
				baseRevision = requireToken(tokens, ++index, token);
				headRevision = requireToken(tokens, ++index, token);
				break;
			case "--knowledge-base":
				knowledgeBasePaths.push(requireToken(tokens, ++index, token));
				break;
			case "--output":
				outputRoot = requireToken(tokens, ++index, token);
				break;
			case "--archive-existing":
				archiveExisting = true;
				break;
			case "--credential":
				credentialId = parsePositiveCredential(requireToken(tokens, ++index, token));
				break;
			default:
				throw new Error(t("commands.security.unknownPlanOption", { option: token }));
		}
	}
	const common = { includePaths, excludePaths };
	const target: SecurityTargetRequest =
		kind === "ref_diff"
			? {
					kind,
					baseRevision: baseRevision ?? "",
					headRevision: headRevision ?? "",
					...common,
				}
			: kind === "working_tree"
				? { kind, ...common }
				: kind === "scoped_path"
					? { kind, ...common }
					: { kind: "repository", ...common };
	return { target, knowledgeBasePaths, outputRoot, archiveExisting, credentialId };
}

async function preflight(runtime: SlashCommandRuntime, rest: string) {
	const options = parsePlanOptions(rest);
	const input: SecurityPreflightInput = {
		target: options.target,
		knowledgeBasePaths: options.knowledgeBasePaths,
		outputRoot: options.outputRoot,
		archiveExisting: options.archiveExisting,
		credentialId: options.credentialId,
		model: runtime.session.model,
	};
	return coordinatorFor(runtime).preflight(input);
}

function scanIdFromInput(value: string): string {
	const trimmed = value.trim();
	const match = trimmed.match(/^security:\/\/scans\/([^/]+)/);
	return match?.[1] ?? trimmed;
}

function findingTarget(value: string): { uri: string; scanId: string; findingId: string } {
	const trimmed = value.trim();
	const uriMatch = trimmed.match(/^security:\/\/scans\/([^/]+)\/findings\/([^/]+)$/);
	if (uriMatch) return { uri: trimmed, scanId: uriMatch[1]!, findingId: uriMatch[2]! };
	const [scanId, findingId] = parseCommandArgs(trimmed);
	if (!scanId || !findingId) throw new Error(t("commands.security.validateUsage"));
	return { uri: `security://scans/${scanId}/findings/${findingId}`, scanId, findingId };
}

async function showResource(runtime: SlashCommandRuntime, rest: string): Promise<void> {
	const raw = rest.trim();
	if (!raw) throw new Error(t("commands.security.showUsage"));
	const uri = raw.startsWith("security://") ? raw : `security://scans/${scanIdFromInput(raw)}`;
	const handler = new SecurityProtocolHandler(undefined, () => true);
	const resource = await handler.resolve(parseInternalUrl(uri), { cwd: runtime.cwd });
	await runtime.output(resource.content);
}

async function importResults(runtime: SlashCommandRuntime, rest: string): Promise<void> {
	const [source] = parseCommandArgs(rest);
	if (!source) throw new Error(t("commands.security.importUsage"));
	const store = await SecurityStore.openForCwd(runtime.cwd);
	const absolute = path.resolve(runtime.cwd, source);
	const stats = await fs.stat(absolute);
	const bundle = stats.isDirectory()
		? await importCodexSecurityBundle(absolute, { repositoryRoot: store.repositoryRoot })
		: await importSarifFile(absolute, { repositoryRoot: store.repositoryRoot });
	await store.putBundle(bundle);
	await runtime.output(t("commands.security.imported", { count: bundle.findings.length, id: bundle.scan.id }));
}

async function exportResults(runtime: SlashCommandRuntime, rest: string): Promise<void> {
	const tokens = parseCommandArgs(rest);
	const scanId = tokens[0];
	if (!scanId) throw new Error(t("commands.security.exportUsage"));
	let outputPath: string | undefined;
	let format: (typeof EXPORT_FORMATS)[number] = "bundle";
	for (let index = 1; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token === "--output") outputPath = requireToken(tokens, ++index, token);
		else if (token === "--format") {
			const value = requireToken(tokens, ++index, token);
			const selected = EXPORT_FORMATS.find(candidate => candidate === value);
			if (!selected) throw new Error(t("commands.security.unknownExportFormat", { format: value }));
			format = selected;
		} else throw new Error(t("commands.security.unknownExportOption", { option: token }));
	}
	if (!outputPath) throw new Error(t("commands.security.outputRequired"));
	const store = await SecurityStore.openForCwd(runtime.cwd);
	const bundle = await store.getBundle(scanIdFromInput(scanId));
	if (!bundle) throw new Error(t("commands.security.unknownScan", { id: scanId }));
	let content: string;
	if (format === "sarif") {
		if (!bundle.sarif) throw new Error(t("commands.security.sarifUnavailable", { id: scanId }));
		content = `${JSON.stringify(bundle.sarif, null, 2)}\n`;
	} else if (format === "report") {
		if (bundle.report === undefined) throw new Error(t("commands.security.reportUnavailable", { id: scanId }));
		content = bundle.report;
	} else {
		content = `${JSON.stringify(bundle, null, 2)}\n`;
	}
	const absolute = path.resolve(runtime.cwd, outputPath);
	await writeSecurityFileAtomic(absolute, content, { hardenParent: false });
	await runtime.output(t("commands.security.exported", { id: scanId, path: shortenPath(absolute) }));
}

interface CloudCliOptions {
	credentialId?: number;
	configurationId?: string;
	repositoryId?: string;
	repositoryUrl?: string;
	environmentId?: string;
	lookbackDays?: number | "all";
}

function parseCloudOptions(rest: string, subcommand: string): CloudCliOptions {
	const tokens = parseCommandArgs(rest);
	const options: CloudCliOptions = {};
	let positionalConsumed = false;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		switch (token) {
			case "--credential":
				options.credentialId = parsePositiveCredential(requireToken(tokens, ++index, token));
				break;
			case "--repo-id":
				options.repositoryId = requireToken(tokens, ++index, token);
				break;
			case "--repo-url":
				options.repositoryUrl = requireToken(tokens, ++index, token);
				break;
			case "--environment":
				options.environmentId = requireToken(tokens, ++index, token);
				break;
			case "--lookback": {
				const value = requireToken(tokens, ++index, token);
				if (value === "all") {
					options.lookbackDays = value;
					break;
				}
				const days = Number(value);
				if (!Number.isSafeInteger(days) || days < 1)
					throw new Error(t("commands.security.invalidLookback", { value }));
				options.lookbackDays = days;
				break;
			}
			default:
				if (!token.startsWith("--") && !positionalConsumed && (subcommand === "status" || subcommand === "pull")) {
					options.configurationId = token;
					positionalConsumed = true;
					break;
				}
				throw new Error(t("commands.security.unknownCloudOption", { option: token }));
		}
	}
	return options;
}

function cloudConfigurationsFor(session: SlashCommandRuntime["session"]) {
	let configurations = CLOUD_OPTIONS.get(session);
	if (!configurations) {
		configurations = new Map();
		CLOUD_OPTIONS.set(session, configurations);
	}
	return configurations;
}

async function handleCloudCommand(runtime: SlashCommandRuntime, rest: string): Promise<void> {
	const { verb, rest: optionsText } = parseSubcommand(rest);
	const subcommand = verb || "scans";
	const options = parseCloudOptions(optionsText, subcommand);
	const authStorage = runtime.session.modelRegistry.authStorage;
	const account = selectSecurityOAuthAccount(
		authStorage,
		CLOUD_PROVIDER,
		options.credentialId,
		runtime.session.sessionId,
	);
	const client = new CodexSecurityCloudClient({ authStorage, account });
	switch (subcommand) {
		case "scans": {
			const configurations = await client.listAllConfigurations();
			cloudConfigurationsFor(runtime.session).set(account.credentialId, configurations);
			await runtime.output(
				configurations.length === 0
					? t("commands.security.noCloudScans")
					: configurations
							.map(item =>
								[
									item.id,
									item.state ?? t("commands.security.unknown"),
									item.currentStep ?? t("commands.security.unknown"),
									`repo=${item.repositoryId}`,
									`environment=${item.environmentId}`,
									item.repositoryUrl,
									item.remainingScans === undefined
										? ""
										: t("commands.security.scansRemaining", { count: item.remainingScans }),
								]
									.filter(Boolean)
									.join(" "),
							)
							.join("\n"),
			);
			return;
		}
		case "start": {
			if (!options.repositoryId || !options.repositoryUrl || !options.environmentId) {
				throw new Error(t("commands.security.cloudStartUsage"));
			}
			const configuration = await client.startScan({
				repositoryId: options.repositoryId,
				repositoryUrl: options.repositoryUrl,
				environmentId: options.environmentId,
				lookbackDays: options.lookbackDays,
			});
			const cache = cloudConfigurationsFor(runtime.session);
			const existing = cache.get(account.credentialId) ?? [];
			cache.set(account.credentialId, [configuration, ...existing.filter(item => item.id !== configuration.id)]);
			await runtime.output(
				t("commands.security.cloudStarted", { id: configuration.id, repository: configuration.repositoryUrl }),
			);
			return;
		}
		case "status": {
			if (!options.configurationId) throw new Error(t("commands.security.cloudStatusUsage"));
			await runtime.output(JSON.stringify(await client.getStats(options.configurationId), null, 2));
			return;
		}
		case "pull": {
			if (!options.configurationId) throw new Error(t("commands.security.cloudPullUsage"));
			const store = await SecurityStore.openForCwd(runtime.cwd);
			const bundle = await pullCodexSecurityCloudResults({
				client,
				configurationId: options.configurationId,
				store,
			});
			await runtime.output(
				t("commands.security.cloudImported", { count: bundle.findings.length, id: bundle.scan.id }),
			);
			return;
		}
		default:
			throw new Error(t("commands.security.cloudUsage"));
	}
}

async function updateDisposition(runtime: SlashCommandRuntime, rest: string): Promise<void> {
	const [scanId, findingId, status, ...rationaleParts] = parseCommandArgs(rest);
	if (!scanId || !findingId || !status) {
		throw new Error(t("commands.security.dispositionUsage"));
	}
	if (!DISPOSITIONS.has(status as SecurityDispositionStatus))
		throw new Error(t("commands.security.unknownDisposition", { status }));
	const rationale = rationaleParts.join(" ").trim();
	if (status !== "open" && !rationale) throw new Error(t("commands.security.rationaleRequired", { status }));
	const store = await SecurityStore.openForCwd(runtime.cwd);
	const finding = await store.updateDisposition(scanId, findingId, {
		status: status as SecurityDispositionStatus,
		rationale: rationale || undefined,
		updatedAt: new Date().toISOString(),
		actor: "operator",
	});
	await runtime.output(
		t("commands.security.dispositionChanged", { id: finding.id, status: finding.disposition.status }),
	);
}

export async function handleSecurityCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	if (!cfgSecurityEnabled.get(runtime.settings)) {
		return usage(t("commands.security.disabled"), runtime);
	}
	const { verb, rest } = parseSubcommand(command.args);
	try {
		switch (verb || "scans") {
			case "plan": {
				const plan = await preflight(runtime, rest);
				await runtime.output(t("commands.security.planReady", { id: plan.id, fingerprint: plan.fingerprint }));
				return commandConsumed();
			}
			case "scan": {
				const coordinator = coordinatorFor(runtime);
				const planId = rest.trim().startsWith("secplan_") ? rest.trim() : (await preflight(runtime, rest)).id;
				const operation = await coordinator.start({ planId });
				await runtime.output(
					t("commands.security.scanStarted", { id: operation.scanId, operation: operation.operationId }),
				);
				return commandConsumed();
			}
			case "status": {
				const coordinator = coordinatorFor(runtime);
				const operationId = rest.trim();
				if (operationId) {
					const operation = await coordinator.status(operationId);
					if (!operation) throw new Error(t("commands.security.unknownOperation", { id: operationId }));
					await runtime.output(JSON.stringify(operation, null, 2));
				} else {
					await runtime.output(JSON.stringify(await coordinator.listOperations(), null, 2));
				}
				return commandConsumed();
			}
			case "cancel": {
				const operationId = rest.trim();
				if (!operationId) throw new Error(t("commands.security.cancelUsage"));
				await runtime.output(
					(await coordinatorFor(runtime).cancel(operationId))
						? t("commands.security.cancelRequested", { id: operationId })
						: t("commands.security.cannotCancel", { id: operationId }),
				);
				return commandConsumed();
			}
			case "scans": {
				const scans = await (await SecurityStore.openForCwd(runtime.cwd)).listScans();
				await runtime.output(
					scans.length === 0
						? t("commands.security.noScans")
						: scans
								.map(scan =>
									t("commands.security.scanRow", {
										id: scan.id,
										status: scan.status,
										count: scan.findingCount,
										producer: scan.producer.name,
									}),
								)
								.join("\n"),
				);
				return commandConsumed();
			}
			case "show":
				await showResource(runtime, rest);
				return commandConsumed();
			case "import":
				await importResults(runtime, rest);
				return commandConsumed();
			case "export":
				await exportResults(runtime, rest);
				return commandConsumed();
			case "validate": {
				const target = findingTarget(rest);
				return {
					prompt: renderPromptAsset("security/validate-request.md", validationRequestPrompt, {
						findingUri: target.uri,
						scanId: target.scanId,
						findingId: target.findingId,
					}).trim(),
				};
			}
			case "compare": {
				const [beforeScanId, afterScanId] = parseCommandArgs(rest);
				if (!beforeScanId || !afterScanId) throw new Error(t("commands.security.compareUsage"));
				const report = await (await SecurityStore.openForCwd(runtime.cwd)).compare(beforeScanId, afterScanId);
				await runtime.output(JSON.stringify(report, null, 2));
				return commandConsumed();
			}
			case "cloud":
				await handleCloudCommand(runtime, rest);
				return commandConsumed();
			case "disposition":
				await updateDisposition(runtime, rest);
				return commandConsumed();
			default:
				return usage(t("commands.security.usage"), runtime);
		}
	} catch (error) {
		await runtime.output(t("commands.security.error", { error: errorMessage(error) }));
		return commandConsumed();
	}
}
