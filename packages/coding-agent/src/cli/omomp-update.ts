import * as path from "node:path";
import updatePrompt from "../prompts/omomp-update.md" with { type: "text" };

const FORK_EXECUTABLE_NAMES = new Set(["npi", "npi.exe", "omomp", "omomp.exe"]);

/** Route the fork executable's exact `update` command into a normal prompted agent session. `npi` is the install name; `omomp` remains so an old binary does not fall through to the upstream updater. */
export function resolveOmompUpdateArgv(argv: string[], executablePath: string): string[] {
	if (argv.length !== 1 || argv[0] !== "update") return argv;
	const executableName = path.basename(executablePath.replaceAll("\\", "/")).toLowerCase();
	if (!FORK_EXECUTABLE_NAMES.has(executableName)) return argv;
	return ["launch", updatePrompt.trim()];
}
