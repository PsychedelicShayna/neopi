import * as path from "node:path";
import updatePrompt from "../prompts/npi-update.md" with { type: "text" };

const NPI_EXECUTABLE_NAMES = new Set(["npi", "npi.exe"]);
/** Restrict fork-only argv rewrites to the dedicated binary, not `omp` or source Bun runs. */
export function isNpiExecutable(executablePath: string): boolean {
	const executableName = path.basename(executablePath.replaceAll("\\", "/")).toLowerCase();
	return NPI_EXECUTABLE_NAMES.has(executableName);
}

/** Route the fork executable's exact `update` command into a normal prompted agent session. */
export function resolveNpiUpdateArgv(argv: string[], executablePath: string): string[] {
	if (argv.length !== 1 || argv[0] !== "update") return argv;
	if (!isNpiExecutable(executablePath)) return argv;
	return ["launch", updatePrompt.trim()];
}
