import { prompt } from "@oh-my-pi/pi-utils";
import ideaPrompt from "../prompts/idea-funnel.md" with { type: "text" };
import { isNpiExecutable } from "./npi-update";

/** Route an idea supplied to the fork binary into one interactive funnel session. */
export function resolveNpiIdeaArgv(argv: string[], executablePath: string): string[] {
	if (argv[0] !== "idea" || argv.length < 2 || !isNpiExecutable(executablePath)) return argv;
	return ["launch", prompt.render(ideaPrompt, { idea: argv.slice(1).join(" ") }).trim()];
}
