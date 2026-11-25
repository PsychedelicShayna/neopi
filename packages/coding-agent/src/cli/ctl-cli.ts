/**
 * `npi ctl` implementation (#171). Discovers sessions from the registry and
 * speaks the control protocol. Never spawns a session.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "@oh-my-pi/pi-utils";
import { untilAborted } from "@oh-my-pi/pi-utils/abortable";
import { t, type TranslationValues } from "@oh-my-pi/pi-utils/i18n";
import { ControlClient, ControlClientError } from "../control/client";
import type { ControlCallerIdentity } from "../control/host";
import { readControlEntries, type ControlMetadata, type ControlRegistryOptions } from "../control/registry";
import type { ControlSnapshot } from "../control/types";

export interface CtlIo {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

const processIo: CtlIo = {
	stdout: text => process.stdout.write(text),
	stderr: text => process.stderr.write(text),
};
const ioScope = new AsyncLocalStorage<CtlIo>();

/** The sink for the current ctl call: the tool's request-local sink, else the process streams. */
const io: CtlIo = {
	stdout: text => (ioScope.getStore() ?? processIo).stdout(text),
	stderr: text => (ioScope.getStore() ?? processIo).stderr(text),
};

/** Run ctl helpers against a sink instead of the process streams (the ctl tool). Request-local. */
export function withCtlIo<T>(sink: CtlIo, fn: () => Promise<T>): Promise<T> {
	return ioScope.run(sink, fn);
}

export function ctlExit(code: number): never {
	process.exitCode = code;
	return undefined as never;
}

class CtlTargetError extends ControlClientError {
	constructor(
		code: "ambiguous" | "not_found",
		readonly key: string,
		readonly values: TranslationValues,
	) {
		// Keep the error message stable for structured consumers such as ctl pipe.
		super(code, t("en", key, values));
	}
}

/** Resolve a target selector to one registry entry. */
export async function resolveCtlTarget(selector: string, options?: ControlRegistryOptions): Promise<ControlMetadata> {
	const entries = await readControlEntries(options);
	const wanted = selector.trim();
	const tiers: Array<(meta: ControlMetadata) => boolean> = [
		meta => meta.instanceId === wanted,
		meta => wanted.length >= 4 && meta.instanceId.startsWith(wanted),
		meta => meta.sessionId === wanted,
		meta => meta.tmuxPane === wanted || meta.tmuxPane === `%${wanted}`,
		meta => wanted.startsWith("pid:") && meta.pid === Number(wanted.slice(4)),
		meta => meta.title === wanted,
		meta => (meta.title ?? "").toLowerCase().startsWith(wanted.toLowerCase()) && wanted.length >= 2,
		meta => meta.cwd === wanted,
	];
	for (const tier of tiers) {
		const matches = entries.filter(entry => tier(entry.meta));
		if (matches.length === 1) return matches[0]!.meta;
		if (matches.length > 1) {
			throw new CtlTargetError("ambiguous", "cli.commands.ctl.targetAmbiguous", {
				target: wanted,
				matches: matches.map(entry => entry.meta.instanceId).join(", "),
			});
		}
	}
	throw new CtlTargetError("not_found", "cli.commands.ctl.targetNotFound", { target: wanted });
}

const callerBinding = new AsyncLocalStorage<ControlCallerIdentity | null>();

/** The ctl tool sets this so the connection carries the caller's publication. */
export function withCtlCaller<T>(caller: ControlCallerIdentity | null, fn: () => Promise<T>): Promise<T> {
	return callerBinding.run(caller, fn);
}

async function connect(selector: string, label: string, signal?: AbortSignal): Promise<ControlClient> {
	const caller = callerBinding.getStore();
	const self = selector === "self" && caller !== undefined;
	if (self && !caller) {
		throw new ControlClientError("no_caller", "the calling session has no published control endpoint");
	}
	const metadata = self && caller ? caller.metadata : await untilAborted(signal, () => resolveCtlTarget(selector));
	const client = new ControlClient({
		metadata,
		label,
		kind: caller ? "tool" : "cli",
		caller: caller ? { instanceId: caller.metadata.instanceId, token: caller.metadata.token } : null,
		controlChain: caller?.controlChain ?? [],
		allowSelf: self,
		allowNested: self,
	});
	try {
		await untilAborted(signal, () => client.connect());
	} catch (error) {
		client.close();
		throw error;
	}
	return client;
}

export async function ctlList(json: boolean, signal?: AbortSignal): Promise<number> {
	const entries = await untilAborted(signal, () => readControlEntries());
	const rows = [];
	for (const entry of entries) {
		const client = new ControlClient({
			metadata: entry.meta,
			label: "ctl-list",
			kind: "cli",
			probe: true,
			timeoutMs: 750,
		});
		try {
			const snapshot = await untilAborted(signal, () => client.connect());
			rows.push({ meta: publicMeta(entry.meta), snapshot });
		} catch (error) {
			if (signal?.aborted) throw error;
			rows.push({ meta: publicMeta(entry.meta), snapshot: null, state: "unresponsive" });
		} finally {
			client.close();
		}
	}
	if (json) {
		io.stdout(`${JSON.stringify({ version: 1, sessions: rows }, null, 2)}\n`);
	} else if (rows.length === 0) {
		io.stdout(t("cli.commands.ctl.noSessions"));
	} else {
		for (const row of rows) {
			const meta = row.meta;
			io.stdout(
				`${meta.instanceId}  pid=${meta.pid}  pane=${meta.tmuxPane ?? "-"}  ${meta.role}  ${meta.title ?? meta.cwd}\n`,
			);
		}
	}
	return 0;
}

function publicMeta(meta: ControlMetadata): Omit<ControlMetadata, "token"> {
	const { token: _token, ...rest } = meta;
	return rest;
}

export async function ctlState(selector: string, json: boolean, signal?: AbortSignal): Promise<number> {
	const client = await connect(selector, "ctl", signal);
	try {
		const response = await untilAborted(signal, () => client.request({ type: "get_status" }));
		if (!response.success) return fail(response.error, response.code);
		const snapshot = response.data as ControlSnapshot;
		io.stdout(json ? `${JSON.stringify(snapshot, null, 2)}\n` : formatSnapshot(snapshot));
		return 0;
	} finally {
		client.close();
	}
}

export function ctlSend(
	selector: string,
	text: string,
	mode: "prompt" | "steer" | "follow_up" | "input" | "slash",
	json: boolean,
	signal?: AbortSignal,
): Promise<number> {
	const params = mode === "input" || mode === "slash" ? { text } : { message: text };
	return ctlRpc(selector, mode, params, json, signal);
}

// These commands can run a slash/extension handler or interrupt the issuing
// turn. Their final reply must not keep that turn's own ctl call pending.
const selfDispatchedCommands: Record<string, true> = {
	abort: true,
	abort_and_restore_queue: true,
	abort_and_prompt: true,
	esc: true,
	input: true,
	slash: true,
	prompt: true,
};

export async function ctlRpc(
	selector: string,
	type: string,
	params: Record<string, unknown>,
	json: boolean,
	signal?: AbortSignal,
): Promise<number> {
	const client = await connect(selector, "ctl", signal);
	let dispatched = false;
	try {
		const command = { type, ...params };
		signal?.throwIfAborted();
		const request = client.request(command, 120_000);
		let response;
		// Only the self selector can authenticate to the caller's own host.
		if (selector === "self" && callerBinding.getStore() && Object.hasOwn(selfDispatchedCommands, command.type)) {
			dispatched = true;
			void request
				.then(
					reply => {
						if (!reply.success) {
							logger.warn("Self ctl command failed", { type: command.type, error: reply.error });
						}
					},
					(error: unknown) => logger.warn("Self ctl command failed", { type: command.type, error: String(error) }),
				)
				.finally(() => client.close());
			response = { command: command.type, success: true, data: { dispatched: true } };
		} else {
			response = await untilAborted(signal, request);
		}
		io.stdout(`${JSON.stringify(response, null, json ? 2 : 0)}\n`);
		return response.success ? 0 : 1;
	} finally {
		if (!dispatched) client.close();
	}
}

function formatSnapshot(snapshot: ControlSnapshot): string {
	const session = snapshot.session;
	const model = session?.model;
	const fast = session?.fastModeActive
		? "active"
		: session?.fastModeEnabled
			? "on (inactive)"
			: session
				? "off"
				: "unknown";
	return [
		`${snapshot.instanceId}  ${snapshot.role}  pid=${snapshot.pid}  ready=${snapshot.ready}`,
		`cwd=${snapshot.cwd}`,
		`busy streaming=${snapshot.busy.streaming} pending(steer+follow-up)=${snapshot.busy.pendingSteerAndFollowUp}`,
		`model=${model ? `${model.provider}/${model.id}` : "-"}  effort=${session?.thinkingLevel ?? "-"}  fast=${fast}`,
		`sessionName=${session?.sessionName ? JSON.stringify(session.sessionName) : "-"}`,
		`sessionFile=${session?.sessionFile ?? "-"}`,
		t("cli.commands.ctl.build", { revision: snapshot.build.gitSha ?? t("cli.commands.ctl.unknownRevision") }),
		"",
	].join("\n");
}

function fail(error?: string, code?: string): number {
	io.stderr(`${code ?? "error"}: ${error ?? t("cli.commands.ctl.failed")}\n`);
	return code === "not_found" || code === "ambiguous" ? 3 : code === "unauthorized" ? 4 : code === "conflict" ? 5 : 1;
}

export function ctlFail(error: unknown): number {
	if (error instanceof CtlTargetError) return fail(t(error.key, error.values), error.code);
	if (error instanceof ControlClientError) return fail(error.message, error.code);
	io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
	return 1;
}
