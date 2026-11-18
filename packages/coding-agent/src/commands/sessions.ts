import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { sessionsHelp } from "../cli/command-help";
import { listSessionCatalog, readSessionCatalog } from "../cli/sessions-cli";
import { readSessionJournalPage, RpcJournalError } from "../modes/rpc/rpc-journal";

export default class Sessions extends Command {
	static description = sessionsHelp.description;
	static args = {
		operation: Args.string({ required: true, options: ["list", "read", "entries"] }),
		file: Args.string({ description: "Session JSONL file for read or entries" }),
	};
	static flags = {
		json: Flags.boolean({ description: "Emit a JSON document", default: false }),
		cwd: Flags.string({ description: "Project working directory" }),
		"session-dir": Flags.string({ description: "List exactly this directory (repeatable)", multiple: true }),
		all: Flags.boolean({ description: "List every project", default: false }),
		live: Flags.boolean({
			description: "With list: add each live session's state (busy, waiting, idle) and git branch",
			default: false,
		}),
		"max-messages": Flags.integer({ description: "Keep only the last N visible messages", min: 0 }),
		scope: Flags.string({ description: "Journal entry scope", options: ["journal", "branch"] }),
		direction: Flags.string({ description: "Paging direction", options: ["forward", "backward"] }),
		cursor: Flags.string({ description: "Opaque native journal cursor" }),
		limit: Flags.integer({ description: "Entries per page, 1 to 256", min: 1, max: 256 }),
	};

	async run(): Promise<void> {
		const json = this.argv.includes("--json");
		let parsed = false;
		try {
			const { args, flags } = await this.parse(Sessions);
			parsed = true;
			if (args.operation === "entries") {
				if (!args.file) throw new RpcJournalError("sessions entries requires a session file", "invalid_request");
				const page = await readSessionJournalPage(args.file, {
					scope: flags.scope as "journal" | "branch" | undefined,
					direction: flags.direction as "forward" | "backward" | undefined,
					cursor: flags.cursor,
					limit: flags.limit,
				});
				process.stdout.write(`${JSON.stringify(page)}\n`);
				return;
			}
			if (args.operation === "read" && !args.file) throw new Error("sessions read requires a session file");
			if (args.operation === "list" && args.file) throw new Error("sessions list does not accept a session file");
			const result =
				args.operation === "read"
					? await readSessionCatalog(args.file!, flags["max-messages"])
					: await listSessionCatalog({
							cwd: flags.cwd,
							sessionDirs: flags["session-dir"],
							all: flags.all,
							live: flags.live,
						});
			process.stdout.write(`${JSON.stringify(result)}\n`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (this.argv.includes("entries") && json) {
				process.stdout.write(
					`${JSON.stringify({
						error: {
							code:
								error instanceof RpcJournalError
									? error.code
									: parsed
										? "session_unavailable"
										: "invalid_request",
							message,
						},
					})}\n`,
				);
				process.exitCode = 1;
				return;
			}
			process.stderr.write(
				`${json ? JSON.stringify({ type: "error", code: "session_catalog_error", message }) : message}\n`,
			);
			process.exitCode = 1;
		}
	}
}
