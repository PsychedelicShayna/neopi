import type { AvailableCommand } from "@oh-my-pi/pi-utils/acp";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { SkillsSettings } from "../extensibility/settings";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { ExtensionRunner } from "../extensibility/extensions";
import { getSkillSlashCommandName, type Skill } from "../extensibility/skills";
import { type FileSlashCommand, loadSlashCommands } from "../extensibility/slash-commands";
import { ACP_BUILTIN_RESERVED_NAMES, isAcpBuiltinShadowedName } from "./acp-builtins";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "./builtin-registry";

export type AvailableSlashCommandSource = "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";

/**
 * Where a command can run. `headless` commands work in every host (RPC, ACP, the control socket and
 * the TUI); `tui` commands need the terminal UI (selectors, dashboards, wizards) and are refused elsewhere.
 */
export type SlashCommandAvailability = "headless" | "tui";

export interface InternalAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
	availability: SlashCommandAvailability;
}

export interface AvailableCommandsSession {
	readonly extensionRunner?: ExtensionRunner;
	readonly customCommands: ReadonlyArray<LoadedCustomCommand>;
	readonly mcpPromptCommands?: ReadonlyArray<LoadedCustomCommand>;
	readonly skills: ReadonlyArray<Skill>;
	readonly skillsSettings?: SkillsSettings;
	readonly effectiveExtensionRoots?: EffectiveExtensionRoots;
	setSlashCommands(slashCommands: FileSlashCommand[]): void;
	sessionManager: { getCwd(): string };
}

export async function buildAvailableSlashCommands(
	session: AvailableCommandsSession,
	loadFileCommands: (cwd: string) => Promise<FileSlashCommand[]> = cwd =>
		loadSlashCommands({ cwd, extensionRoots: session.effectiveExtensionRoots }),
): Promise<InternalAvailableSlashCommand[]> {
	const commands: InternalAvailableSlashCommand[] = [];
	const seenNames = new Set<string>();
	const appendCommand = (command: InternalAvailableSlashCommand): void => {
		if (seenNames.has(command.name)) return;
		seenNames.add(command.name);
		commands.push(command);
	};

	for (const command of BUILTIN_SLASH_COMMANDS_INTERNAL) {
		const hint = command.acpInputHint ?? command.inlineHint;
		appendCommand({
			name: command.name,
			aliases: command.aliases,
			description: command.acpDescription ?? command.description,
			input: hint ? { hint } : undefined,
			subcommands: command.subcommands,
			source: "builtin",
			availability: command.handle ? "headless" : "tui",
		});
		// ACP dispatch resolves builtin aliases before `session.prompt()` sees the
		// input, so a custom/file command sharing an alias would be advertised but
		// never run. Reserve aliases of headless builtins here too; the aliases of
		// TUI-only builtins stay available to other commands.
		if (command.handle) {
			for (const alias of [...(command.aliases ?? []), ...(command.hiddenAliases ?? [])]) seenNames.add(alias);
		}
	}

	if (session.skillsSettings?.enableSkillCommands) {
		for (const skill of session.skills) {
			appendCommand({
				name: getSkillSlashCommandName(skill),
				description: skill.description || `Run ${skill.name} skill`,
				input: { hint: "arguments" },
				source: "skill",
				availability: "headless",
			});
		}
	}

	const runner = session.extensionRunner;
	if (runner) {
		for (const command of runner.getRegisteredCommands(ACP_BUILTIN_RESERVED_NAMES)) {
			if (isAcpBuiltinShadowedName(command.name)) continue;
			appendCommand({
				name: command.name,
				description: command.description ?? "(extension command)",
				input: { hint: "arguments" },
				source: "extension",
				availability: "headless",
			});
		}
	}

	for (const command of session.customCommands) {
		const source: AvailableSlashCommandSource = command.path?.startsWith("mcp:") ? "mcp_prompt" : "custom";
		appendCommand({
			name: command.command.name,
			description: command.command.description,
			input: { hint: "arguments" },
			source,
			availability: "headless",
		});
	}

	const fileCommands = await loadFileCommands(session.sessionManager.getCwd());
	session.setSlashCommands(fileCommands);
	for (const command of fileCommands) {
		appendCommand({
			name: command.name,
			description: command.description,
			input: command.argumentHint ? { hint: command.argumentHint } : undefined,
			source: "file",
			availability: "headless",
		});
	}

	return commands;
}

/** ACP clients see only the commands they can drive; TUI-only commands are not advertised. */
export function toAcpAvailableCommands(commands: readonly InternalAvailableSlashCommand[]): AvailableCommand[] {
	return commands
		.filter(command => command.availability === "headless")
		.map(command => ({
			name: command.name,
			description: command.description ?? "",
			input: command.input,
		}));
}
