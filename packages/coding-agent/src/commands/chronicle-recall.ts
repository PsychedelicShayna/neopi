/**
 * `npi chronicle recall "<query>"`: coarse-to-fine recall over the derived temporal view.
 */
import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runChronicleRecall } from "../cli/chronicle-temporal-cli";

export default class ChronicleRecall extends Command {
	static description =
		"Find Chronicler atoms by descending summaries from year to hour; prints atoms with transcript provenance and the branches considered";

	static args = {
		query: Args.string({ description: "What you remember, in any wording", required: true }),
	};

	static flags = {
		from: Flags.string({ description: "Earliest time (YYYY[-MM[-DD]] local prefix or ISO instant)" }),
		to: Flags.string({ description: "Latest time (prefixes are inclusive)" }),
		project: Flags.string({ description: "Project path substring" }),
		session: Flags.string({ description: "Session id or prefix" }),
		hint: Flags.string({ description: "An adjacent event remembered from around the same time" }),
		resolution: Flags.string({ description: "Stop at year|month|week|day|hour and list candidate periods" }),
		node: Flags.string({ description: "Search inside this candidate period key" }),
		budget: Flags.integer({ description: "Maximum atoms to return" }),
		beam: Flags.integer({ description: "Branches kept per expansion" }),
		ranker: Flags.string({ description: "model (chronicler-summary role) or lexical (no model calls)" }),
		json: Flags.boolean({ char: "j", description: "Emit the full result as JSON", default: false }),
		"agent-dir": Flags.string({ description: "Agent directory whose view to use" }),
	};

	static examples = [
		`${APP_NAME} chronicle recall "when we fixed the login loop"`,
		`${APP_NAME} chronicle recall "the flaky parser test" --from 2026-09 --project neopi`,
		`${APP_NAME} chronicle recall "that renderer idea" --hint "the day the build server died"`,
		`${APP_NAME} chronicle recall "release planning" --resolution month`,
		`${APP_NAME} chronicle recall "release planning" --node 2026/09 --resolution day`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(ChronicleRecall);
		process.exitCode = await runChronicleRecall({
			query: args.query ?? "",
			from: flags.from,
			to: flags.to,
			project: flags.project,
			session: flags.session,
			hint: flags.hint,
			resolution: flags.resolution,
			node: flags.node,
			budget: flags.budget,
			beam: flags.beam,
			ranker: flags.ranker,
			json: flags.json,
			agentDir: flags["agent-dir"],
		});
	}
}
