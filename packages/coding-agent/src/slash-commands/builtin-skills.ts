import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { t } from "@oh-my-pi/pi-utils/i18n";
import type { SkillSearchHit } from "@oh-my-pi/pi-wire/skillshare";
import type { InteractiveModeContext } from "../modes/types";
import { parseSkillSpec, SkillshareClient } from "../skillshare/client";
import {
	formatInstalledSkills,
	formatScriptApproval,
	formatSkillChanges,
	formatSkillSearch,
	installSkillPackages,
	listInstalledSkills,
	type SkillChange,
	type SkillInstallHooks,
	updateSkillPackages,
} from "../skillshare/installer";
import {
	formatSkillId,
	getSkillsInstallPaths,
	parseSkillId,
	readSkillsLock,
	readSkillsManifest,
} from "../skillshare/manifest";
import { argumentValues, completeCurrentArgument } from "./builtin-completions";
import { clearSubmittedText } from "./helpers/draft";
import { errorMessage, parseSubcommand } from "./helpers/parse";
import type { SlashCommandSpec, SubcommandDef } from "./types";

function skillsUsage() {
	return [
		t("commands.skills.guide"),
		t("commands.skills.guideSearch"),
		t("commands.skills.guideInstall"),
		t("commands.skills.guideInstalled"),
		t("commands.skills.guideUpdate"),
	].join("\n");
}

const GLOBAL_FLAGS = ["--global", "-g"];
const completeGlobalFlag = argumentValues(...GLOBAL_FLAGS);
// Typing in the editor does not query the remote registry. Offer the last explicit search's
// package IDs and versions alongside locally recorded names and versions.
const recentSkillSearch = new WeakMap<InteractiveModeContext, SkillSearchHit[]>();

function completeSkillTargets(install: boolean): NonNullable<SubcommandDef["getArgumentCompletions"]> {
	return (tail, runtime) =>
		completeCurrentArgument(tail, runtime, async (prefix, context, previous) => {
			const parsed = parseTargets(previous);
			if ("error" in parsed) return null;
			const flags = parsed.global ? null : completeGlobalFlag(prefix);
			if (!context || prefix.startsWith("-")) return flags;

			const items = flags ?? [];
			const { ctx } = context;
			const cwd = ctx.sessionManager.getCwd();
			const selected = new Set(
				parsed.names.map(name => {
					const spec = install ? parseSkillSpec(name) : null;
					return spec ? formatSkillId(spec.scope, spec.name) : name;
				}),
			);
			const lower = prefix.toLowerCase();
			const versionSeparator = lower.indexOf("@", 1);
			const versionId = install && versionSeparator > 0 ? lower.slice(0, versionSeparator) : undefined;
			const matches = new Map<string, AutocompleteItem>();
			const add = (id: string, description?: string, version?: string) => {
				if (selected.has(id)) return;
				const value = versionId && versionId === id.toLowerCase() && version ? `${id}@${version}` : id;
				if (value.toLowerCase().startsWith(lower) && !matches.has(value)) {
					matches.set(value, { value: `${value} `, label: value, description });
				}
			};
			if (install) {
				for (const hit of recentSkillSearch.get(ctx) ?? []) {
					add(formatSkillId(hit.scope, hit.name), hit.description, hit.version);
				}
			}
			// Update accepts only entries in the chosen manifest, not orphaned lock entries.
			const scopes = install ? [false, true] : [parsed.global];
			const local = await Promise.all(
				scopes.map(async global => {
					const paths = await getSkillsInstallPaths({ cwd, global }).catch(() => null);
					if (!paths) return null;
					const [manifest, lock] = await Promise.all([
						readSkillsManifest(paths.manifest).catch(() => null),
						versionId ? readSkillsLock(paths.lock).catch(() => null) : null,
					]);
					return { manifest, lock };
				}),
			);
			for (const source of local) {
				if (!source) continue;
				for (const [id, range] of Object.entries(source.manifest?.skills ?? {})) {
					if (parseSkillId(id)) add(id, range, source.lock?.skills[id]?.version);
				}
			}
			return [...matches.values(), ...items];
		});
}

/** Split `<name…> [--global|-g]`; unknown flags are errors. */
function parseTargets(tokens: readonly string[]): { names: string[]; global: boolean } | { error: string } {
	const names: string[] = [];
	let global = false;
	for (const token of tokens) {
		if (!token) continue;
		if (GLOBAL_FLAGS.includes(token)) global = true;
		else if (token.startsWith("-"))
			return { error: t("commands.skills.unknownOption", { option: token, usage: skillsUsage() }) };
		else names.push(token);
	}
	return { names, global };
}

async function withClient<T>(run: (client: SkillshareClient) => Promise<T>): Promise<T> {
	const client = await SkillshareClient.create();
	try {
		return await run(client);
	} finally {
		client.close();
	}
}

function tuiHooks(ctx: InteractiveModeContext): SkillInstallHooks {
	return {
		warn: message => ctx.showWarning(message),
		confirmScripts: request =>
			ctx.showHookConfirm(t("commands.skills.confirmScripts"), formatScriptApproval(request)),
	};
}

async function reportChanges(ctx: InteractiveModeContext, changes: SkillChange[]): Promise<void> {
	if (changes.length === 0) {
		ctx.showStatus(t("commands.skills.upToDate"));
		return;
	}
	await ctx.refreshSkillState();
	ctx.showStatus(formatSkillChanges(changes));
}

export const BUILTIN_SKILLS_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "skills",
		icon: "skill",
		get description() {
			return t("commands.skills.description");
		},
		subcommands: [
			{
				name: "search",
				get description() {
					return t("commands.skills.searchDescription");
				},
				usage: "<query>",
			},
			{
				name: "install",
				get description() {
					return t("commands.skills.installDescription");
				},
				usage: "<@scope/name[@range]>… [--global]",
				getArgumentCompletions: completeSkillTargets(true),
			},
			{
				name: "installed",
				get description() {
					return t("commands.skills.installedDescription");
				},
			},
			{
				name: "update",
				get description() {
					return t("commands.skills.updateDescription");
				},
				usage: "[@scope/name…] [--global]",
				getArgumentCompletions: completeSkillTargets(false),
			},
			{
				name: "help",
				get description() {
					return t("commands.skills.helpDescription");
				},
			},
		],
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const { ctx } = runtime;
			clearSubmittedText(runtime);
			const { verb, rest } = parseSubcommand(command.args);
			const cwd = ctx.sessionManager.getCwd();
			try {
				switch (verb) {
					case "search": {
						if (!rest) {
							ctx.showError(t("commands.skills.searchUsage"));
							return;
						}
						const response = await withClient(client => client.search(rest));
						recentSkillSearch.set(ctx, response.hits);
						ctx.showStatus(formatSkillSearch(response));
						return;
					}
					case "install": {
						const targets = parseTargets(rest.split(/\s+/));
						if ("error" in targets) {
							ctx.showError(targets.error);
							return;
						}
						if (targets.names.length === 0) {
							ctx.showError(t("commands.skills.installUsage"));
							return;
						}
						ctx.showStatus(t("commands.skills.installing", { skills: targets.names.join(", ") }), { dim: true });
						const changes = await withClient(client =>
							installSkillPackages(
								client,
								{ specs: targets.names, global: targets.global, yes: false, cwd },
								tuiHooks(ctx),
							),
						);
						await reportChanges(ctx, changes);
						return;
					}
					case "installed": {
						ctx.showStatus(formatInstalledSkills(await listInstalledSkills(cwd)));
						return;
					}
					case "update": {
						const targets = parseTargets(rest.split(/\s+/));
						if ("error" in targets) {
							ctx.showError(targets.error);
							return;
						}
						ctx.showStatus(t("commands.skills.checkingUpdates"), { dim: true });
						const changes = await withClient(client =>
							updateSkillPackages(client, { names: targets.names, global: targets.global, cwd }, tuiHooks(ctx)),
						);
						await reportChanges(ctx, changes);
						return;
					}
					case "":
					case "help":
						ctx.showStatus(skillsUsage());
						return;
					default:
						ctx.showError(t("commands.skills.unknownSubcommand", { subcommand: verb, usage: skillsUsage() }));
						return;
				}
			} catch (error) {
				ctx.showError(t("commands.skills.error", { error: errorMessage(error) }));
			}
		},
	},
];
