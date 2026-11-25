import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { IrcBus } from "../irc/bus";
import { AgentRegistry } from "../registry/agent-registry";
import { ensurePersistedRoster, sessionFileBelongsToRoot } from "../registry/persisted-agents";
import {
	argumentValues,
	buildDirectoryArgumentCompletions,
	completeArguments,
	completeCurrentArgument,
	mcpServerArgumentValues,
} from "./builtin-completions";
import { normalizeResetProvider, oneLine } from "./helpers/reset-usage";
import { toSessionPinAccounts } from "./helpers/session-pin";
import { getToolArgumentCompletions } from "./tool-arguments";
import type { ArgumentValueProvider, TuiSlashCommandRuntime } from "./types";

function matchingRows(rows: AutocompleteItem[], prefix: string, preserveBare = false): AutocompleteItem[] | null {
	const query = prefix.trimStart().toLowerCase();
	const matches = rows.filter(row => row.value.toLowerCase().startsWith(query));
	if (preserveBare && !query) {
		for (const row of matches) row.preserveInputOnSubmit = true;
	}
	return matches.length ? matches : null;
}

export const activeToolValues: ArgumentValueProvider = (prefix, runtime) =>
	runtime ? argumentValues(...runtime.ctx.session.getActiveToolNames())(prefix) : null;

export const oauthProviderValues: ArgumentValueProvider = prefix =>
	matchingRows(
		getOAuthProviders().map(provider => ({
			value: `${provider.id} `,
			label: provider.id,
			description: oneLine(provider.name),
		})),
		prefix,
		true,
	);

export function completeLoginArguments(prefix: string, runtime?: TuiSlashCommandRuntime) {
	if (runtime?.ctx.oauthManualInput.hasPending()) return null;
	return completeArguments(prefix, runtime, oauthProviderValues);
}

export function completeLogoutArguments(prefix: string, runtime?: TuiSlashCommandRuntime) {
	return completeArguments(prefix, runtime, oauthProviderValues);
}

export async function completeSessionPinArguments(prefix: string, runtime?: TuiSlashCommandRuntime) {
	const session = runtime?.focusedSession ?? runtime?.ctx.viewSession ?? runtime?.ctx.session;
	const list = await session?.listCurrentProviderOAuthAccounts();
	if (!list) return null;
	const query = prefix.trimStart().toLowerCase();
	const rows: AutocompleteItem[] = [];
	for (const account of toSessionPinAccounts(list.accounts)) {
		const position = String(account.position + 1);
		const label = oneLine(account.label);
		if (![position, label, account.email, account.accountId].some(value => value?.toLowerCase().startsWith(query))) {
			continue;
		}
		rows.push({
			value: `${position} `,
			label: `${position}. ${label}`,
			description: account.active ? t("commands.arguments.currentAccount") : undefined,
			preserveInputOnSubmit: !query,
			submitsCommand: true,
		});
	}
	if (list.accounts.some(account => account.active) && "active".startsWith(query)) {
		rows.push({ value: "active ", label: "active", preserveInputOnSubmit: !query, submitsCommand: true });
	}
	return rows.length ? rows : null;
}

export const runningJobValues: ArgumentValueProvider = (prefix, runtime) => {
	const ids = runtime?.ctx.session.getAsyncJobSnapshot({ recentLimit: 0 })?.running.map(job => job.id) ?? [];
	const items = argumentValues("all", ...ids)(prefix);
	return prefix ? items : (items?.map(item => ({ ...item, preserveInputOnSubmit: true })) ?? null);
};

export const resetUsageValues: ArgumentValueProvider = async (prefix, runtime) => {
	if (!runtime) return null;
	const { session } = runtime.ctx;
	const { credentials, oauth } = session.modelRegistry.authStorage;
	// Completion lists locally stored targets. Only execution/selector opening
	// checks live provider eligibility; typing must not contact providers.
	await credentials.reload();
	const slash = prefix.indexOf("/");
	const selector = slash < 0 ? undefined : prefix.slice(0, slash).toLowerCase();
	const providers = selector === undefined ? getOAuthProviders().map(provider => provider.id) : [selector];
	const rows: AutocompleteItem[] = [];
	for (const id of providers) {
		const provider = normalizeResetProvider(id);
		if (!provider) continue;
		for (const account of toSessionPinAccounts(oauth.accounts(provider, session.sessionId))) {
			const exact = `${id}/${account.credentialId}`;
			const description = oneLine(account.label);
			rows.push({ value: `${exact} `, label: exact, description });
			if (account.active) rows.push({ value: `${id}/active `, label: `${id}/active`, description });
		}
	}
	return matchingRows(rows, prefix, true);
};

export async function completeTodoPath(prefix: string, runtime?: TuiSlashCommandRuntime) {
	if (!runtime) return null;
	const complete = buildDirectoryArgumentCompletions({ cwd: runtime.ctx.sessionManager.getCwd(), includeFiles: true });
	const items = await complete(prefix.replace(/^"/, "").replace(/"$/, ""));
	return (
		items?.map(item => ({
			...item,
			submitsCommand: !item.value.endsWith("/"),
			preserveInputOnSubmit: !prefix.trim(),
		})) ?? null
	);
}

export const todoPhaseValues: ArgumentValueProvider = (prefix, runtime) => {
	const rows =
		runtime?.ctx.todoPhases
			.filter(({ name }) => !/[\r\n]/.test(name))
			.map(({ name }) => ({
				// Append tokenizes a phase name before reading open task text.
				value: `${/[\s"\\]/.test(name) ? `"${name.replaceAll(/(["\\])/g, "\\$1")}"` : name} `,
				label: oneLine(name),
			})) ?? [];
	const query = prefix.replace(/^"/, "").toLowerCase();
	const matches = rows.filter(row => row.label.toLowerCase().startsWith(query));
	return matches.length ? matches : null;
};

export function todoTargetCompletions(includePhases: boolean) {
	return (prefix: string, runtime?: TuiSlashCommandRuntime): AutocompleteItem[] | null => {
		const query = prefix.trim().toLowerCase();
		const rows = new Map<string, AutocompleteItem>();
		for (const phase of runtime?.ctx.todoPhases ?? []) {
			for (const task of phase.tasks) {
				const value = task.content.toLowerCase();
				if (!value.includes(query) || rows.has(value) || /[\r\n]/.test(value)) continue;
				rows.set(value, {
					value: `${task.content} `,
					label: oneLine(task.content),
					description: oneLine(phase.name),
				});
			}
		}
		if (includePhases) {
			for (const phase of runtime?.ctx.todoPhases ?? []) {
				const value = phase.name.toLowerCase();
				if (!value.includes(query) || rows.has(value) || /[\r\n]/.test(value)) continue;
				rows.set(value, {
					value: `${phase.name} `,
					label: oneLine(phase.name),
					description: t("commands.arguments.phase"),
				});
			}
		}
		const items = [...rows.values()].map(row => ({
			...row,
			submitsCommand: true,
			preserveInputOnSubmit: !query && includePhases,
		}));
		if (includePhases && "all".startsWith(query)) {
			// The handlers use a bare verb for "all"; a literal `all` can name a task.
			items.push({
				value: "",
				label: t("commands.arguments.allNoTarget"),
				submitsCommand: true,
				preserveInputOnSubmit: true,
			});
		}
		return items.length ? items : null;
	};
}

const statsFlags = ["--port", "-p", "--host"];
const scopeValues = argumentValues("project", "user");
const mcpAddFlags: Record<string, ((prefix: string) => AutocompleteItem[] | null) | null> = {
	"--scope": scopeValues,
	"--url": null,
	"--transport": argumentValues("http", "sse"),
	"--token": null,
};

export function completeStatsArguments(prefix: string, runtime?: TuiSlashCommandRuntime) {
	return completeCurrentArgument(prefix, runtime, (current, _context, previous) => {
		const used = new Set<string>();
		for (let i = 0; i < previous.length; i++) {
			const flag = previous[i]!;
			if (flag.startsWith("--port=") || flag.startsWith("--host=")) {
				used.add(flag.slice(0, flag.indexOf("=")));
				continue;
			}
			if (!statsFlags.includes(flag) || ++i === previous.length) return null;
			used.add(flag === "-p" ? "--port" : flag);
		}
		const available = statsFlags.filter(flag => !used.has(flag === "-p" ? "--port" : flag));
		const items = argumentValues(...available)(current);
		return items?.map(row => ({ ...row, preserveInputOnSubmit: !prefix.trim() })) ?? null;
	});
}

export function completeMcpAddArguments(prefix: string, runtime?: TuiSlashCommandRuntime) {
	return completeCurrentArgument(prefix, runtime, (current, _context, previous) => {
		const hasName = previous.length > 0 && !previous[0]!.startsWith("-");
		const used = new Set<string>();
		for (let i = hasName ? 1 : 0; i < previous.length; i++) {
			const flag = previous[i]!;
			if (!Object.hasOwn(mcpAddFlags, flag)) return null; // Includes `--`: the command tail stays open.
			if (++i === previous.length) return mcpAddFlags[flag]?.(current) ?? null;
			used.add(flag);
		}
		const available = hasName ? Object.keys(mcpAddFlags).filter(flag => !used.has(flag)) : ["--scope"];
		if (hasName && !used.has("--url") && !used.has("--token")) available.push("--");
		if (!hasName && !current.startsWith("-")) return null; // New names stay open.
		return argumentValues(...available)(current);
	});
}

const mcpRemoveValues = mcpServerArgumentValues("remove");
export function completeMcpRemoveArguments(prefix: string, runtime?: TuiSlashCommandRuntime) {
	return completeCurrentArgument(prefix, runtime, (current, context, previous) => {
		if (previous.length === 0) return mcpRemoveValues(current, context, previous);
		if (previous.length === 1) return argumentValues("--scope")(current);
		if (previous.length === 2 && previous[1] === "--scope") {
			return scopeValues(current)?.map(row => ({ ...row, submitsCommand: true })) ?? null;
		}
		return null;
	});
}

export async function completeGitRevision(
	prefix: string,
	runtime?: TuiSlashCommandRuntime,
): Promise<AutocompleteItem[] | null> {
	if (!runtime || /\s/.test(prefix.trimStart())) return null;
	try {
		const repo = vcs.requireGit(getProjectDir());
		const [branches, tags, commits] = await Promise.all([
			repo.listBranches(true),
			repo.tagsAt("HEAD").catch(() => []),
			repo.logOnelines(20),
		]);
		const revisions = new Map<string, AutocompleteItem>();
		for (const value of ["HEAD", ...branches, ...tags]) {
			revisions.set(value, { value: `${value} `, label: value, submitsCommand: true });
		}
		for (const commit of commits) {
			const split = commit.indexOf(" ");
			if (split < 0) continue;
			const value = commit.slice(0, split);
			revisions.set(value, {
				value: `${value} `,
				label: value,
				description: oneLine(commit.slice(split + 1)),
				submitsCommand: true,
			});
		}
		return matchingRows([...revisions.values()], prefix, true);
	} catch {
		return null;
	}
}

const hubAgentValues: ArgumentValueProvider = async (prefix, runtime) => {
	if (!runtime) return null;
	const { ctx } = runtime;
	const registry = ctx.collabGuest?.agentRegistry ?? AgentRegistry.global();
	const file = ctx.sessionManager.getSessionFile();
	if (!ctx.collabGuest && file?.endsWith(".jsonl")) await ensurePersistedRoster(registry, file);
	const root = ctx.collabGuest ? undefined : registry.rootForSession(ctx.session);
	const rows = registry
		.list()
		.filter(ref => {
			if (ref.kind === "mailbox" || (!ctx.collabGuest && !ref.session && !ref.sessionFile)) return false;
			if (!registry.isInRootTree(ref.id, root)) return false;
			return (
				ctx.collabGuest ||
				!file?.endsWith(".jsonl") ||
				!ref.sessionFile ||
				sessionFileBelongsToRoot(ref.sessionFile, file)
			);
		})
		.map(ref => ({ value: `${ref.id} `, label: ref.id, description: oneLine(ref.displayName) }));
	return matchingRows(rows, prefix, true);
};

export function completeHubArguments(prefix: string, runtime?: TuiSlashCommandRuntime) {
	return completeArguments(prefix, runtime, hubAgentValues);
}

const enabledToolValues: ArgumentValueProvider = (prefix, runtime) => {
	if (!runtime) return null;
	return matchingRows(
		runtime.ctx.session.getToolCatalogEntries().map(tool => ({
			value: `${tool.name} `,
			label: tool.name,
			description: oneLine(tool.description),
			submitsCommand: prefix === tool.name,
		})),
		prefix,
		true,
	);
};

export function completeToolArguments(prefix: string, runtime?: TuiSlashCommandRuntime) {
	const head = /^\s*(\S+)[ \t]+/.exec(prefix);
	if (!head) return completeArguments(prefix, runtime, enabledToolValues);
	const tool = runtime?.ctx.session.getToolCatalogTool(head[1]!);
	if (!tool) return null;
	const tail = prefix.slice(head[0].length);
	const candidates = getToolArgumentCompletions(toolWireSchema(tool), tail);
	return candidates?.map(row => ({ ...row, value: head[0] + row.value, preserveInputOnSubmit: !tail })) ?? null;
}

const ircGroupVerbs = argumentValues("list", "mine", "members", "create", "add", "remove", "leave", "keep");

export function completeIrcArguments(prefix: string, runtime?: TuiSlashCommandRuntime) {
	const operator = runtime?.ctx.ircOperatorId;
	const peers = () =>
		operator
			? AgentRegistry.global()
					.listVisibleTo(operator)
					.map(ref => ref.id)
			: [];
	return completeCurrentArgument(prefix, runtime, async (current, _context, previous) => {
		if (!previous.length) {
			const comma = current.lastIndexOf(",");
			if (comma >= 0) {
				const leading = current.slice(0, comma + 1);
				const addressed = leading.split(",");
				const matches = argumentValues(...peers().filter(peer => !addressed.includes(peer)))(
					current.slice(comma + 1),
				);
				return matches?.map(row => ({ ...row, value: leading + row.value })) ?? null;
			}
			const { groups = [] } =
				operator && (!current || current.startsWith("#"))
					? await IrcBus.global().group(operator, { op: "groups" })
					: {};
			const targets = new Set(["all", "group", ...peers(), ...groups.map(name => `#${name}`)]);
			return matchingRows(
				[...targets].map(value => ({ value: `${value} `, label: value })),
				current,
				true,
			);
		}
		if (previous[0] !== "group") return null; // Message text stays open.
		if (previous.length === 1) {
			return (
				ircGroupVerbs(current)?.map(row => ({
					...row,
					submitsCommand: row.label === "list" || row.label === "mine",
				})) ?? null
			);
		}
		const [, verb, group, ...chosen] = previous;
		if (previous.length === 2) {
			if (!operator || !verb || !["members", "add", "remove", "leave", "keep"].includes(verb)) return null;
			const { groups = [] } = await IrcBus.global().group(operator, { op: "groups" });
			return (
				argumentValues(...groups)(current)?.map(row => ({
					...row,
					submitsCommand: verb === "members" || verb === "leave",
				})) ?? null
			);
		}
		if (!operator || (verb !== "create" && verb !== "add" && verb !== "remove")) return null;
		const targets =
			verb === "remove" && group
				? ((await IrcBus.global().group(operator, { op: "members", group })).members ?? [])
				: peers();
		return argumentValues(...targets.filter(peer => !chosen.includes(peer)))(current);
	});
}
