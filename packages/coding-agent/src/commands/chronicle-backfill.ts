/**
 * `npi chronicle backfill`: capture stored sessions' uncovered backlog headlessly (#198).
 */
import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import {
	createChronicleBackfillDeps,
	DEFAULT_BACKFILL_CONCURRENCY,
	runChronicleBackfill,
} from "../cli/chronicle-backfill-cli";

export default class ChronicleBackfill extends Command {
	static description =
		"Capture Chronicler beats for stored sessions without resuming them; resumable and deduplicated by committed batches";

	static args = {
		sessions: Args.string({
			description: "Session ids (prefixes, as for --resume) or transcript paths",
			multiple: true,
		}),
	};

	static flags = {
		project: Flags.string({ description: "Every session recorded in this project directory" }),
		all: Flags.boolean({ description: "Every stored session not yet fully covered", default: false }),
		since: Flags.string({ description: "Only sessions active on or after this date (e.g. 2026-09-01)" }),
		until: Flags.string({ description: "Only sessions started on or before this date" }),
		"min-size": Flags.string({ description: "Only transcripts at least this large (e.g. 64k, 2MB)" }),
		"dry-run": Flags.boolean({
			char: "n",
			description: "List selected sessions and uncovered entry counts; no model calls",
			default: false,
		}),
		concurrency: Flags.integer({
			char: "j",
			description: `Sessions captured at once (default ${DEFAULT_BACKFILL_CONCURRENCY})`,
			default: DEFAULT_BACKFILL_CONCURRENCY,
		}),
		timeout: Flags.string({ description: "Per-session capture budget before the final drain (default 2h)" }),
		drain: Flags.string({ description: "Per-session final drain budget (default 10m)" }),
		force: Flags.boolean({ description: "Run even when chronicler.enabled is false", default: false }),
	};

	static examples = [
		`${APP_NAME} chronicle backfill --all --dry-run`,
		`${APP_NAME} chronicle backfill 01a0ee26`,
		`${APP_NAME} chronicle backfill --project ~/src/app --since 2026-09-01 --until 2026-09-07`,
		`${APP_NAME} chronicle backfill --all --min-size 64k -j 2 --timeout 30m --drain 5m`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(ChronicleBackfill);
		const deps = createChronicleBackfillDeps();
		try {
			process.exitCode = await runChronicleBackfill(
				{
					sessions: args.sessions ?? [],
					project: flags.project,
					all: flags.all,
					since: flags.since,
					until: flags.until,
					minSize: flags["min-size"],
					dryRun: flags["dry-run"],
					concurrency: flags.concurrency,
					timeout: flags.timeout,
					drain: flags.drain,
					force: flags.force,
				},
				deps,
			);
		} finally {
			deps.close();
		}
	}
}
