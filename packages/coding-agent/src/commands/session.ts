/**
 * Hand a session to another machine, or check who owns it.
 *
 * `omp session pack <session> <out.tar>` writes a self-contained archive,
 * `omp session unpack <archive.tar> --cwd <dir>` lands it in `<dir>`'s session
 * directory (printing the session file path as the only stdout line),
 * `omp session moved <session> --to <label>` marks the copy left behind stale
 * so resuming it forks instead of continuing it, and
 * `omp session lease --json -- <id>...` reports which sessions a running omp owns
 * without taking their ownership leases.
 */
import chalk from "@oh-my-pi/pi-utils/chalk";
import { isRecord } from "@oh-my-pi/pi-utils";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { sessionHelp as commandHelp } from "../cli/command-help";
import { resolveSessionFileArg } from "../cli/session-arg";
import { ControlClient } from "../control/client";
import { type ControlMetadata, readControlEntries } from "../control/registry";
import {
	canonicalSessionLeaseFile,
	inspectSessionFileLease,
	type SessionFileLeaseIdentity,
	type SessionFileLeaseReport,
} from "../session/session-lease";
import { SessionMoveRefusedError } from "../session/session-manager";
import { probeSessionLeases } from "../session/session-storage";
import {
	markSessionMoved,
	packSession,
	SessionTransferError,
	unpackSession,
	type UnpackMode,
} from "../session/session-transfer";

const ACTIONS = ["pack", "unpack", "moved", "lease"] as const;
type SessionAction = (typeof ACTIONS)[number];

const USAGE: Record<SessionAction, string> = {
	pack: "omp session pack <session> <out.tar>",
	unpack: "omp session unpack <archive.tar> --cwd <dir>",
	moved: "omp session moved <session> --to <label>",
	lease: "npi session lease [--json] -- <session-id>... | npi session lease --file <path> [--json]",
};

const UNPACK_NOTE: Record<UnpackMode, string> = {
	created: "cli.commands.session.unpack_created",
	replaced: "cli.commands.session.unpack_replaced",
	forked: "cli.commands.session.unpack_forked",
};

function isSessionAction(value: string): value is SessionAction {
	return ACTIONS.some(action => action === value);
}

/**
 * Probe each id's ownership lease without taking it. JSON consumers (omp-web)
 * get `{held, unknown}`; ids in neither list are free, including ids that name
 * no session.
 */
function printSessionLeases(sessionIds: string[], json: boolean): void {
	const report = probeSessionLeases(sessionIds);
	if (json) {
		process.stdout.write(`${JSON.stringify(report)}\n`);
		return;
	}
	for (const id of report.held) process.stdout.write(`held\t${id}\n`);
	for (const id of report.unknown) process.stdout.write(`unknown\t${id}\n`);
}

async function attestFileLease(
	metadata: ControlMetadata,
	sessionFile: string,
): Promise<SessionFileLeaseIdentity | undefined> {
	const { pid, instanceId, imageId } = metadata;
	const client = new ControlClient({ metadata, label: "session lease", probe: true, timeoutMs: 1_000 });
	try {
		await client.connect();
		const response = await client.request({ type: "get_session_file_lease", sessionFile });
		const data = response.data;
		if (
			response.success &&
			isRecord(data) &&
			data.status === "held" &&
			data.sessionFile === sessionFile &&
			isRecord(data.holder) &&
			data.holder.pid === pid &&
			data.holder.instanceId === instanceId &&
			data.holder.imageId === imageId
		) {
			return { pid, instanceId, imageId };
		}
	} catch {
		// An unreachable, busy, or older endpoint cannot attest this lease.
	} finally {
		client.close();
	}
}

async function querySessionFileLease(file: string): Promise<SessionFileLeaseReport> {
	const report = inspectSessionFileLease(file);
	if (report.status !== "held_unknown") return report;
	const { sessionFile } = report;
	const entries = await readControlEntries({ prune: false }).catch(() => []);
	for (const { meta } of entries) {
		if (!meta.sessionFile) continue;
		try {
			if (canonicalSessionLeaseFile(meta.sessionFile) !== sessionFile) continue;
		} catch {
			continue;
		}
		const holder = await attestFileLease(meta, sessionFile);
		if (holder) return { status: "held", sessionFile, holder };
	}
	return report;
}

export default class Session extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "pack, unpack, moved, or lease",
			required: true,
			options: ACTIONS,
		}),
		source: Args.string({
			description: "Session .jsonl path or id (pack, moved); archive path (unpack); session ids (lease)",
			required: false,
		}),
		output: Args.string({
			description: "Archive file to write (pack)",
			required: false,
		}),
	};

	static flags = {
		cwd: Flags.string({ description: "Directory the session continues in on this machine (unpack)" }),
		to: Flags.string({ description: "Where the session went, e.g. a machine name (moved)" }),
		json: Flags.boolean({ description: "Print the session lease report as JSON (lease)" }),
		file: Flags.string({ description: "Inspect the lifetime lease of this exact session file (lease; always JSON)" }),
	};

	static get examples() {
		return [
			`# ${t("cli.commands.session.example.pack")}\n  omp session pack ~/.omp/agent/sessions/<project>/<file>.jsonl /tmp/session.tar`,
			`# ${t("cli.commands.session.example.unpack")}\n  omp session unpack /tmp/session.tar --cwd ~/src/project`,
			`# ${t("cli.commands.session.example.moved")}\n  omp session moved <file>.jsonl --to cloud`,
			`# ${t("cli.commands.session.example.lease")}\n  omp session lease --json -- <id> <id>`,
			`# ${t("cli.commands.session.example.file_lease")}\n  npi session lease --file /path/to/session.jsonl`,
		];
	}

	async run(): Promise<void> {
		const { args, flags, argv } = await this.parse(Session);
		const action = args.action ?? "";
		if (!isSessionAction(action)) throw new CliUsageError(t("cli.commands.session.unknown_action", { action }));
		const usage = USAGE[action];
		if (action === "lease") {
			if (flags.cwd !== undefined || flags.to !== undefined) {
				throw new CliUsageError(t("cli.commands.session.lease_flags", { usage }));
			}
			const sessionIds = argv.slice(1);
			if (flags.file !== undefined) {
				if (flags.file.length === 0 || sessionIds.length !== 0) {
					throw new CliUsageError(t("cli.commands.session.file_path_required", { usage }));
				}
				process.stdout.write(`${JSON.stringify(await querySessionFileLease(flags.file))}\n`);
				return;
			}
			if (sessionIds.length === 0) throw new CliUsageError(t("cli.commands.session.id_required", { usage }));
			printSessionLeases(sessionIds, flags.json === true);
			return;
		}
		if (flags.json) throw new CliUsageError(t("cli.commands.session.json_lease_only", { usage }));
		if (flags.file !== undefined) throw new CliUsageError(t("cli.commands.session.file_lease_only", { usage }));
		if (argv.length > (action === "pack" ? 3 : 2)) {
			throw new CliUsageError(
				t("cli.commands.session.unexpected_argument", { argument: String(argv.at(-1)), usage }),
			);
		}
		const source = args.source;
		if (!source) {
			const key =
				action === "unpack" ? "cli.commands.session.archive_required" : "cli.commands.session.session_required";
			throw new CliUsageError(t(key, { usage }));
		}
		if (action !== "unpack" && flags.cwd !== undefined) {
			throw new CliUsageError(t("cli.commands.session.cwd_unpack_only", { usage }));
		}
		if (action !== "moved" && flags.to !== undefined) {
			throw new CliUsageError(t("cli.commands.session.to_moved_only", { usage }));
		}

		try {
			switch (action) {
				case "pack": {
					if (!args.output) throw new CliUsageError(t("cli.commands.session.output_required", { usage }));
					const result = await packSession(await this.#resolveSession(source), args.output);
					if (result.missingBlobs.length > 0) {
						process.stderr.write(
							`${chalk.yellow(t("cli.commands.session.blobs_missing", { count: result.missingBlobs.length }))}\n`,
						);
					}
					process.stdout.write(`${result.archivePath}\n`);
					return;
				}
				case "unpack": {
					if (!flags.cwd) throw new CliUsageError(t("cli.commands.session.cwd_required", { usage }));
					const result = await unpackSession(source, { cwd: flags.cwd });
					process.stderr.write(`${chalk.dim(t(UNPACK_NOTE[result.mode], { id: result.id }))}\n`);
					process.stdout.write(`${result.sessionFile}\n`);
					return;
				}
				case "moved": {
					if (flags.to === undefined) throw new CliUsageError(t("cli.commands.session.to_required", { usage }));
					await markSessionMoved(await this.#resolveSession(source), flags.to);
					return;
				}
			}
		} catch (error) {
			if (error instanceof SessionTransferError || error instanceof SessionMoveRefusedError) {
				process.stderr.write(
					`${chalk.red(t("cli.commands.session.transfer_error", { message: error.message }))}\n`,
				);
				process.exitCode = 1;
				return;
			}
			throw error;
		}
	}

	/** A session path or id resolved to a file, with lookup failures reported as transfer errors. */
	async #resolveSession(source: string): Promise<string> {
		try {
			return await resolveSessionFileArg(source, process.cwd());
		} catch (error) {
			throw new SessionTransferError(error instanceof Error ? error.message : String(error));
		}
	}
}
