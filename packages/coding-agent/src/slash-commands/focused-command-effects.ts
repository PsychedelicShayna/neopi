import { parseSubcommand } from "./helpers/parse";

export type FocusedCommandEffect =
	| "transcript"
	| "jobs"
	| "tool"
	| "account"
	| "session"
	| "settings"
	| "external"
	| "process"
	| "files"
	| "unknown";

type FocusedCommandRoute = { target: "view" | "home" | "main"; effect?: FocusedCommandEffect };

const VIEW: FocusedCommandRoute = { target: "view" };
const HOME: FocusedCommandRoute = { target: "home" };
const TRANSCRIPT: FocusedCommandRoute = { target: "home", effect: "transcript" };
const MAIN_SESSION: FocusedCommandRoute = { target: "main", effect: "session" };
const MAIN_SETTINGS: FocusedCommandRoute = { target: "main", effect: "settings" };
const MAIN_EXTERNAL: FocusedCommandRoute = { target: "main", effect: "external" };
const MAIN_PROCESS: FocusedCommandRoute = { target: "main", effect: "process" };

/**
 * `/` availability does not depend on this table. It says where the current
 * handler can actually run and what needs a warning. Future commands still
 * run after confirmation, but are not assumed safe or focused-session aware.
 */
const routes: Readonly<Record<string, FocusedCommandRoute>> = Object.fromEntries([
	...[
		"btw",
		"copy",
		"effort",
		"export",
		"fast",
		"model",
		"notice",
		"retry",
		"hotkeys",
		"changelog",
		"hub",
		"queue",
	].map(name => [name, VIEW] as const),
	...["chat", "dirs", "fresh", "rename", "trace", "dump", "tools", "context", "skillful", "ratchet", "prewalk"].map(
		name => [name, HOME] as const,
	),
	...["clear", "shake", "handoff"].map(name => [name, TRANSCRIPT] as const),
	...[
		"new",
		"delete",
		"resume",
		"branch",
		"fork",
		"tree",
		"tan",
		"cleanse",
		"plan",
		"plan-review",
		"vibe",
		"goal",
		"guided-goal",
		"loop",
		"defer",
		"move",
		"wt",
		"add-dir",
		"remove-dir",
		"local",
		"launch-profile",
		"advisor",
		"loadout",
		"persona",
		"kernel",
	].map(name => [name, MAIN_SESSION] as const),
	...[
		"settings",
		"statusline",
		"setup",
		"voice",
		"repl",
		"sounds",
		"language",
		"live-persona",
		"personality",
		"extended-context",
		"modelpreset",
		"computer",
		"forget-approvals",
		"marketplace",
		"plugins",
		"reload-plugins",
		"extensions",
		"agents",
		"chain",
		"skills",
		"mcp",
	].map(name => [name, MAIN_SETTINGS] as const),
	...[
		"ssh",
		"open",
		"browser",
		"irc",
		"share",
		"collab",
		"join",
		"leave",
		"spawn",
		"issue",
		"memory",
		"chron",
		"moa",
		"record",
		"live",
		"live-transcript",
		"neoproxy",
		"stats",
		"git",
		"commit",
		"security",
		"omfg",
		"pin",
		"unpin",
	].map(name => [name, MAIN_EXTERNAL] as const),
	...["exit", "quit", "restart", "pause", "monitor", "debug"].map(name => [name, MAIN_PROCESS] as const),
]);

export function focusedCommandRoute(name: string, args: string): FocusedCommandRoute {
	const { verb, rest } = parseSubcommand(args);
	switch (name) {
		case "roles":
			return verb === "project" || verb === "global" ? MAIN_SETTINGS : VIEW;
		case "compact":
			return verb === "control" ? { target: "home", effect: "settings" } : TRANSCRIPT;
		case "slow":
			return verb === "status" ? HOME : { target: "home", effect: "settings" };
		case "todo":
			if (verb === "edit" || verb === "expand" || verb === "collapse") return MAIN_SESSION;
			if (verb === "import" || verb === "export") return { target: "home", effect: "files" };
			return HOME;
		case "jobs":
			return verb === "kill" ? { target: "view", effect: "jobs" } : VIEW;
		case "usage":
			return verb === "reset" ? { target: "main", effect: "account" } : VIEW;
		case "login":
		case "logout":
			return { target: "main", effect: "account" };
		case "tool":
		case "force":
			return { target: "home", effect: "tool" };
		case "session":
			return verb === "delete" || verb === "pin" || rest ? MAIN_SESSION : HOME;
		default:
			return Object.hasOwn(routes, name) && routes[name] ? routes[name] : { target: "main", effect: "unknown" };
	}
}
