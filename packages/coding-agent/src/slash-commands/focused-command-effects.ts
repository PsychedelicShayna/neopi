import { parseSubcommand } from "./helpers/parse";

export type FocusedCommandEffect =
	| "transcript"
	| "dispatch"
	| "mode"
	| "kernel"
	| "profile"
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
const VIEW_FILES: FocusedCommandRoute = { target: "view", effect: "files" };
const VIEW_ACCOUNT: FocusedCommandRoute = { target: "view", effect: "account" };
const HOME_ACCOUNT: FocusedCommandRoute = { target: "home", effect: "account" };
const HOME_MODE: FocusedCommandRoute = { target: "home", effect: "mode" };
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
	...["add-dir", "remove-dir", "defer", "plan", "guided-goal"].map(name => [name, HOME] as const),
	...["branch", "tree"].map(name => [name, VIEW] as const),
	...["cleanse", "local"].map(name => [name, VIEW_FILES] as const),
	["tan", { target: "home", effect: "dispatch" }],
	...["clear", "shake", "handoff"].map(name => [name, TRANSCRIPT] as const),
	...["new", "delete", "resume", "vibe", "loop"].map(name => [name, MAIN_SESSION] as const),
	...["move", "wt"].map(name => [name, MAIN_PROCESS] as const),
	["launch-profile", { target: "main", effect: "profile" }],
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
		case "advisor":
			return verb === "configure" ? MAIN_SETTINGS : HOME;
		case "persona":
			if (!verb) return VIEW;
			return verb === "live" || verb === "clone" || verb === "delete" ? MAIN_SETTINGS : HOME;
		case "loadout":
			return verb ? HOME : VIEW;
		case "kernel":
			if (verb === "reset") return MAIN_SESSION;
			return verb === "interrupt" ? { target: "home", effect: "kernel" } : HOME;
		case "goal":
			return verb === "drop" ? HOME_MODE : HOME;
		case "plan-review":
			return verb === "approve" || verb === "refine" ? HOME_MODE : HOME;
		case "fork":
			if (!verb) return MAIN_SESSION;
			return !rest && /^(?:pane|window|tab)$/.test(verb) ? { target: "view", effect: "dispatch" } : VIEW;
		case "todo":
			if (verb === "edit" || verb === "expand" || verb === "collapse") return VIEW;
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
			if (verb === "delete") return MAIN_SESSION;
			if (verb === "pin") return rest ? HOME_ACCOUNT : VIEW_ACCOUNT;
			return rest ? MAIN_SESSION : HOME;
		default:
			return Object.hasOwn(routes, name) && routes[name] ? routes[name] : { target: "main", effect: "unknown" };
	}
}
