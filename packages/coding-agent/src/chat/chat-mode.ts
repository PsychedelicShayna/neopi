/**
 * Chat mode (`--chat[=erp|raw]`): a session with the harness's agentic
 * context stripped. The mode is resolved once at launch, persisted as a
 * session journal entry, and consulted by each subsystem at its existing
 * injection gate.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { CliUsageError } from "../cli/usage-error";
import type { SessionEntry } from "../session/session-entries";

export const CHAT_MODES = ["chat", "erp", "raw"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

/** Stripped context categories a user may opt back into. */
export const CHAT_INCLUDES = ["date", "cwd", "contextFiles", "skills", "rules", "memory"] as const;
export type ChatInclude = (typeof CHAT_INCLUDES)[number];

/** Settings value for `chat.mode`; `off` keeps the ordinary coding session. */
export const CHAT_MODE_SETTING_VALUES = ["off", ...CHAT_MODES] as const;
export type ChatModeSetting = (typeof CHAT_MODE_SETTING_VALUES)[number];

export interface ChatModeConfig {
	mode: ChatMode;
	include: readonly ChatInclude[];
}

/** Session journal entry recording the chat mode a session runs in. */
export const CHAT_MODE_ENTRY_TYPE = "chat_mode";

/** Tools whose grant makes the working directory meaningful to the model. */
const FILESYSTEM_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "write", "edit", "grep", "glob", "bash"]);

function isChatMode(value: unknown): value is ChatMode {
	return typeof value === "string" && (CHAT_MODES as readonly string[]).includes(value);
}

function isChatInclude(value: unknown): value is ChatInclude {
	return typeof value === "string" && (CHAT_INCLUDES as readonly string[]).includes(value);
}

/**
 * Parse a `--chat` value. The bare flag selects `chat`; `off` returns null so a
 * resumed chat session or a configured default can be switched off.
 */
export function parseChatModeArg(value: string | true): ChatMode | null {
	if (value === true) return "chat";
	const normalized = value.trim().toLowerCase();
	if (normalized === "off") return null;
	if (isChatMode(normalized)) return normalized;
	throw new CliUsageError(
		`Invalid --chat value: ${JSON.stringify(value)}. Expected one of: off, ${CHAT_MODES.join(", ")}.`,
	);
}

/** Parse `--chat-include` / `chat.include` names, rejecting unknown categories. */
export function parseChatIncludes(values: readonly string[], source: string): ChatInclude[] {
	const includes: ChatInclude[] = [];
	for (const raw of values) {
		const value = raw.trim();
		if (value.length === 0) continue;
		if (!isChatInclude(value)) {
			throw new CliUsageError(
				`Invalid ${source} entry: ${JSON.stringify(value)}. Expected any of: ${CHAT_INCLUDES.join(", ")}.`,
			);
		}
		if (!includes.includes(value)) includes.push(value);
	}
	return includes;
}

/**
 * Latest chat-mode state recorded on a session branch: a config when the
 * session runs in chat mode, `null` when it was explicitly switched off, and
 * `undefined` when the session never recorded one.
 */
export function readChatModeEntry(entries: readonly SessionEntry[]): ChatModeConfig | null | undefined {
	let state: ChatModeConfig | null | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== CHAT_MODE_ENTRY_TYPE || !isRecord(entry.data)) continue;
		const { mode, include } = entry.data;
		if (mode === "off") {
			state = null;
		} else if (isChatMode(mode)) {
			state = { mode, include: Array.isArray(include) ? include.filter(isChatInclude) : [] };
		}
	}
	return state;
}

/** Journal payload for {@link CHAT_MODE_ENTRY_TYPE}. */
export function chatModeEntryData(config: ChatModeConfig | null): { mode: ChatModeSetting; include: ChatInclude[] } {
	return config ? { mode: config.mode, include: [...config.include] } : { mode: "off", include: [] };
}

/** Whether two recorded chat-mode states are the same. */
export function sameChatMode(a: ChatModeConfig | null | undefined, b: ChatModeConfig | null | undefined): boolean {
	if (!a || !b) return (a ?? null) === (b ?? null);
	return (
		a.mode === b.mode && a.include.length === b.include.length && a.include.every(item => b.include.includes(item))
	);
}

export interface ChatModeResolutionInput {
	/** `--chat` value: `true` for the bare flag. */
	flag: string | true | undefined;
	/** `--chat-include` names. */
	includeFlag: readonly string[] | undefined;
	/** State recorded in the session being restored; `undefined` when none. */
	stored: ChatModeConfig | null | undefined;
	/** Whether the launch resumes or continues an existing session. */
	restoring: boolean;
	settingsMode: ChatModeSetting;
	settingsInclude: readonly string[];
}

/**
 * Resolve the session's chat mode. Explicit flags win; a restored session keeps
 * what it recorded (a session that never recorded chat mode stays a coding
 * session); a new session takes the `chat.mode` default.
 */
export function resolveChatMode(input: ChatModeResolutionInput): ChatModeConfig | null {
	let mode: ChatMode | null;
	let fromStored = false;
	if (input.flag !== undefined) {
		mode = parseChatModeArg(input.flag);
	} else if (input.restoring) {
		mode = input.stored?.mode ?? null;
		fromStored = true;
	} else {
		mode = input.settingsMode === "off" ? null : input.settingsMode;
	}
	if (mode === null) {
		if (input.includeFlag !== undefined) throw new CliUsageError("--chat-include requires chat mode (--chat)");
		return null;
	}
	const include =
		input.includeFlag !== undefined
			? parseChatIncludes(input.includeFlag, "--chat-include")
			: fromStored && input.stored
				? [...input.stored.include]
				: [...new Set(input.settingsInclude.filter(isChatInclude))];
	return { mode, include };
}

/**
 * Whether a stripped category is present in this chat session. Explicit
 * includes always win. Otherwise raw strips everything; chat and erp keep the
 * project context files (story lore) and expose the working directory only
 * when a filesystem tool is granted.
 */
export function chatModeIncludes(
	config: ChatModeConfig,
	item: ChatInclude,
	toolNames: readonly string[] = [],
): boolean {
	if (config.include.includes(item)) return true;
	if (config.mode === "raw") return false;
	if (item === "contextFiles") return true;
	if (item === "cwd") return toolNames.some(name => FILESYSTEM_TOOL_NAMES.has(name));
	return false;
}

/** Short status-line label: `chat`, `chat:erp`, `chat:raw`. */
export function chatModeLabel(mode: ChatMode): string {
	return mode === "chat" ? "chat" : `chat:${mode}`;
}
