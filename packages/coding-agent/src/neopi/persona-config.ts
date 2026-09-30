/**
 * `/persona` command surface shared by the TUI and text (ACP/RPC) modes, plus
 * the doc conversion for the fullscreen persona editor.
 *
 * Two scopes share one grammar: `/persona …` edits the session's system-prompt
 * persona, `/persona live …` edits the live voice model's persona.
 */
import type { PersonaConfigDoc, PersonaConfigEntry } from "@oh-my-pi/pi-tui/overlays/persona-config";
import {
	liveIngestSettingsFromFields,
	liveIngestSourceFields,
	type LiveIngestPersonaSettings,
} from "../live/ingest-settings";
import { createLivePersonaFeature, DEFAULT_LIVE_PERSONA, defaultLiveInstructions } from "../live/personas";
import type { AgentSession } from "../session/agent-session";
import {
	type PersonaDefinition,
	type PersonaHost,
	type PersonaUi,
	parsePersonaDefinition,
	personaFeature,
} from "./persona";

export type PersonaScope = "persona" | "live";

export const PERSONA_USAGE =
	"Usage: /persona [live] [set <name>|off|list|show <name>|status|clone <source> <name>|delete <name>]";

export const PERSONA_SUBCOMMANDS = [
	{ name: "set", description: "Switch to a persona", usage: "<name>" },
	{ name: "off", description: "Stop using a persona (live: back to the default)" },
	{ name: "list", description: "List personas; * marks the active one" },
	{ name: "show", description: "Print a persona's definition", usage: "<name>" },
	{ name: "status", description: "Show the active persona" },
	{ name: "clone", description: "Copy a persona under a new name", usage: "<source> <name>" },
	{ name: "delete", description: "Delete a persona", usage: "<name>" },
	{ name: "live", description: "Live voice personas: alone opens their editor, or add a subcommand" },
] as const;

/** A persona name offered by autocomplete. */
export interface PersonaNameItem {
	name: string;
	description: string;
	active: boolean;
}

function firstLine(text: string): string {
	const line = text.trim().split("\n", 1)[0] ?? "";
	return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** Personas of `scope` for completion; `sessionId` marks the session's active persona. */
export async function personaNameItems(scope: PersonaScope, sessionId: string | undefined): Promise<PersonaNameItem[]> {
	if (scope === "live") {
		const data = await liveFeature().data();
		return data.items.map(item => ({
			name: item.name,
			description: item.builtin ? "built-in default" : firstLine(item.instructions),
			active: item.active,
		}));
	}
	const data = await personaFeature().data(sessionId ?? "");
	return data.items.map(item => ({
		name: item.name,
		description: `${item.definition.mode} · ${item.definition.source.kind === "file" ? item.definition.source.path : firstLine(item.definition.source.content)}`,
		active: item.active,
	}));
}

const liveFeature = () => createLivePersonaFeature();

export interface ParsedPersonaCommand {
	scope: PersonaScope;
	verb: string;
	args: string[];
}

export function parsePersonaCommand(input: string): ParsedPersonaCommand {
	const words = input.trim().split(/\s+/).filter(Boolean);
	const scope: PersonaScope = words[0]?.toLowerCase() === "live" ? "live" : "persona";
	if (scope === "live") words.shift();
	const [verb = "", ...args] = words;
	return { scope, verb: verb.toLowerCase(), args };
}

/**
 * Run a non-menu persona subcommand. Returns the message to show, or
 * `undefined` when the verb/arguments do not form a command (caller shows usage).
 */
export async function runPersonaCommand(command: ParsedPersonaCommand, host: PersonaHost): Promise<string | undefined> {
	const { scope, verb, args } = command;
	const [first, second] = args;
	if (scope === "live") {
		switch (verb) {
			case "set":
				return first ? liveFeature().use(first) : undefined;
			case "off":
				return liveFeature().use(DEFAULT_LIVE_PERSONA);
			case "list":
				return liveFeature().list();
			case "show":
				return first ? liveFeature().show(first) : undefined;
			case "":
			case "status":
				return liveFeature().status();
			case "clone":
				return first && second ? liveFeature().clone(first, second) : undefined;
			case "delete":
				return first ? liveFeature().delete(first) : undefined;
			default:
				return undefined;
		}
	}
	const personas = personaFeature();
	switch (verb) {
		case "set":
			return first ? personas.use(first, host) : undefined;
		case "off":
			return personas.off(host);
		case "list":
			return personas.list(host.sessionId);
		case "show":
			return first ? personas.show(first) : undefined;
		case "":
		case "status":
			return personas.status(host.sessionId);
		case "clone":
			return first && second ? personas.clone(first, second) : undefined;
		case "delete":
			return first ? personas.delete(first, host) : undefined;
		default:
			return undefined;
	}
}

function entry(fields: Partial<PersonaConfigEntry> & { name: string }): PersonaConfigEntry {
	return {
		mode: "replace",
		sourceKind: "inline",
		content: "",
		path: "",
		literal: "",
		inheritToTasks: false,
		...fields,
	};
}

export async function loadPersonaConfigDoc(scope: PersonaScope, sessionId: string): Promise<PersonaConfigDoc> {
	if (scope === "live") {
		const data = await liveFeature().data();
		return {
			entries: data.items.map(item =>
				entry({
					name: item.name,
					originalName: item.builtin ? undefined : item.name,
					builtin: item.builtin || undefined,
					content: item.instructions,
					sources: liveIngestSourceFields(item.ingest),
					sourcesRaw: structuredClone(item.ingest),
				}),
			),
			active: data.active === DEFAULT_LIVE_PERSONA ? undefined : data.active,
		};
	}
	const data = await personaFeature().data(sessionId);
	return {
		entries: data.items.map(item => {
			const { definition } = item;
			return entry({
				name: item.name,
				originalName: item.name,
				mode: definition.mode,
				sourceKind: definition.source.kind,
				content: definition.source.kind === "inline" ? definition.source.content : "",
				path: definition.source.kind === "file" ? definition.source.path : "",
				literal: definition.literal ?? "",
				inheritToTasks: definition.inheritToTasks === true,
			});
		}),
		active: data.active,
	};
}

export async function savePersonaConfigDoc(
	scope: PersonaScope,
	doc: PersonaConfigDoc,
	host: PersonaHost,
): Promise<string> {
	if (scope === "live") {
		const personas: Record<string, { instructions: string; ingest: LiveIngestPersonaSettings }> = {};
		let defaultIngest: LiveIngestPersonaSettings | undefined;
		for (const item of doc.entries) {
			const ingest = liveIngestSettingsFromFields(item.sources, item.sourcesRaw);
			if (item.builtin) defaultIngest = ingest;
			else personas[item.name] = { instructions: item.content, ingest };
		}
		return liveFeature().saveAll(personas, doc.active, defaultIngest);
	}
	const personas: Record<string, PersonaDefinition> = {};
	const renames = new Map<string, string>();
	for (const item of doc.entries) {
		personas[item.name] = parsePersonaDefinition(
			item.mode,
			item.sourceKind,
			item.sourceKind === "inline" ? item.content : item.path,
			item.mode === "literal-substitute" ? item.literal : undefined,
			item.inheritToTasks,
		);
		if (item.originalName && item.originalName !== item.name) renames.set(item.originalName, item.name);
	}
	return personaFeature().saveAll(personas, renames, doc.active, host);
}

/** Content a new entry starts from in the editor. */
export function newPersonaContent(scope: PersonaScope): string {
	return scope === "live" ? defaultLiveInstructions : "";
}

/** Persona capabilities of a live session; `ui` is present only in the TUI. */
export function sessionPersonaHost(session: AgentSession, ui?: PersonaUi): PersonaHost {
	return {
		sessionId: session.sessionManager.getSessionId(),
		ui,
		invalidatePromptCache: () => session.invalidatePromptCache(),
		appendEntry: (customType, data) => {
			session.sessionManager.appendCustomEntry(customType, data);
		},
	};
}
