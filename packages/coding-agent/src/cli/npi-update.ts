import * as path from "node:path";
import updatePrompt from "../prompts/npi-update.md" with { type: "text" };

const NPI_EXECUTABLE_NAMES = new Set(["npi", "npi.exe"]);

/** Route the fork executable's exact `update` command into a normal prompted agent session. */
export function resolveNpiUpdateArgv(argv: string[], executablePath: string): string[] {
	if (argv.length !== 1 || argv[0] !== "update") return argv;
	const executableName = path.basename(executablePath.replaceAll("\\", "/")).toLowerCase();
	if (!NPI_EXECUTABLE_NAMES.has(executableName)) return argv;
	return ["launch", updatePrompt.trim()];
}
