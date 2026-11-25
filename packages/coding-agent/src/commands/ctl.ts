/**
 * Drive a running npi session over its control socket (issue #171).
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { ctlFail, ctlList, ctlRpc, ctlSend, ctlState } from "../cli/ctl-cli";
import { ctlHelp } from "../cli/command-help";
import { ctlPipe } from "../cli/ctl-pipe";

/** The named operations and aliases handled here; other operations pass through to RPC. */
const OPERATIONS: Readonly<Record<string, string>> = {
	state: "state",
	status: "state",
	send: "send",
	input: "input",
	slash: "slash",
	steer: "steer",
	"follow-up": "follow-up",
	abort: "abort",
	esc: "esc",
	rpc: "rpc",
	action: "action",
	keys: "keys",
	"dialog-answer": "dialog_answer",
	dialog_answer: "dialog_answer",
};
export default class Ctl extends Command {
	static description = ctlHelp.description;

	static args = {
		target: Args.string({ description: "Session selector, or 'list'", required: false }),
		op: Args.string({
			description: "Named operation or RPC type",
			suggestions: Object.keys(OPERATIONS),
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit JSON", default: false }),
		steer: Flags.boolean({ description: "Queue as a steer", default: false }),
		"follow-up": Flags.boolean({ description: "Queue as a follow-up", default: false }),
		label: Flags.string({ description: "Control pipe connection label" }),
	};

	static strict = false;

	async run(): Promise<void> {
		const { args, argv, flags } = await this.parse(Ctl);
		try {
			const head = args.target ?? "list";
			if (head === "pipe") {
				process.exitCode = await ctlPipe(args.op ?? "", { label: flags.label });
				return;
			}
			if (head === "list") {
				process.exitCode = await ctlList(flags.json);
				return;
			}
			const requestedOp = args.op ?? "state";
			const op = OPERATIONS[requestedOp] ?? requestedOp;
			const rest = argv.slice(2).filter(token => !token.startsWith("--"));
			if (op === "state") {
				process.exitCode = await ctlState(head, flags.json);
				return;
			}
			if (op === "send" || op === "input" || op === "slash" || op === "steer" || op === "follow-up") {
				const mode = flags.steer
					? "steer"
					: flags["follow-up"]
						? "follow_up"
						: op === "follow-up"
							? "follow_up"
							: op === "send"
								? "prompt"
								: op;
				process.exitCode = await ctlSend(head, rest.join(" "), mode, flags.json);
				return;
			}
			if (op === "abort" || op === "esc") {
				process.exitCode = await ctlRpc(head, op === "esc" ? "esc" : "abort", {}, flags.json);
				return;
			}
			if (op === "rpc") {
				const type = rest[0];
				if (!type) {
					process.stderr.write(t("cli.commands.ctl.rpcUsage"));
					process.exitCode = 2;
					return;
				}
				const params = rest[1] ? (JSON.parse(rest[1]) as Record<string, unknown>) : {};
				process.exitCode = await ctlRpc(head, type, params, true);
				return;
			}
			if (op === "action") {
				process.exitCode = await ctlRpc(head, "action", { actionId: rest[0] ?? "" }, flags.json);
				return;
			}
			if (op === "keys") {
				process.exitCode = await ctlRpc(head, "keys", { keys: rest.map(key => ({ key })) }, flags.json);
				return;
			}
			if (op === "dialog_answer") {
				process.exitCode = await ctlRpc(
					head,
					"dialog_answer",
					{ dialogId: rest[0] ?? "", answer: rest[1] ? JSON.parse(rest[1]) : rest[1] },
					flags.json,
				);
				return;
			}
			process.exitCode = await ctlRpc(head, op.replaceAll("-", "_"), {}, flags.json);
		} catch (error) {
			process.exitCode = ctlFail(error);
		}
	}
}
