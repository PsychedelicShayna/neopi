/**
 * `npi chronicle index`: build or refresh the derived temporal view over committed atoms.
 */
import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runChronicleIndex } from "../cli/chronicle-temporal-cli";

export default class ChronicleIndex extends Command {
	static description =
		"Build or refresh the year/month/week/day/hour view over every session's Chronicler atoms; only stale nodes are regenerated";

	static flags = {
		rebuild: Flags.boolean({ description: "Regenerate every node, fresh or not", default: false }),
		"dry-run": Flags.boolean({
			char: "n",
			description: "Report stale nodes and diagnostics; no model calls, no writes",
			default: false,
		}),
		since: Flags.string({
			description: "Only regenerate nodes overlapping this time or later (YYYY[-MM[-DD]] or ISO)",
		}),
		until: Flags.string({ description: "Only regenerate nodes overlapping this time or earlier" }),
		json: Flags.boolean({ char: "j", description: "Emit the full report as JSON", default: false }),
		"agent-dir": Flags.string({ description: "Agent directory whose sessions and view to use" }),
	};

	static examples = [
		`${APP_NAME} chronicle index --dry-run`,
		`${APP_NAME} chronicle index`,
		`${APP_NAME} chronicle index --since 2026-09 --until 2026-09-15`,
		`${APP_NAME} chronicle index --rebuild`,
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(ChronicleIndex);
		process.exitCode = await runChronicleIndex({
			rebuild: flags.rebuild,
			dryRun: flags["dry-run"],
			since: flags.since,
			until: flags.until,
			json: flags.json,
			agentDir: flags["agent-dir"],
		});
	}
}
