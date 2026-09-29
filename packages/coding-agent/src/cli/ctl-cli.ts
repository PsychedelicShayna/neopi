/**
 * `npi ctl` implementation (#171). Discovers sessions from the registry and
 * speaks the control protocol. Never spawns a session.
 */
import { ControlClient, ControlClientError } from "../control/client";
import { readControlEntries, type ControlMetadata, type ControlRegistryOptions } from "../control/registry";
import type { ControlSnapshot } from "../control/types";

export interface CtlIo {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

const io: CtlIo = {
	stdout: text => process.stdout.write(text),
	stderr: text => process.stderr.write(text),
};

/** Run ctl helpers against a sink instead of the process streams (the ctl tool). */
export async function withCtlIo<T>(sink: CtlIo, fn: () => Promise<T>): Promise<T> {
	const previous = { ...io };
	io.stdout = sink.stdout;
	io.stderr = sink.stderr;
	try {
		return await fn();
	} finally {
		io.stdout = previous.stdout;
		io.stderr = previous.stderr;
	}
}

export function ctlExit(code: number): never {
	process.exitCode = code;
	return undefined as never;
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
			throw new ControlClientError(
				"ambiguous",
				`${wanted} matches ${matches.map(entry => entry.meta.instanceId).join(", ")}`,
			);
		}
	}
	throw new ControlClientError("not_found", `no control session matches ${wanted}`);
}

async function connect(selector: string, label: string): Promise<ControlClient> {
	const metadata = await resolveCtlTarget(selector);
	const client = new ControlClient({ metadata, label, kind: "cli" });
	await client.connect();
	return client;
}

export async function ctlList(json: boolean): Promise<number> {
	const entries = await readControlEntries();
	const rows = [];
	for (const entry of entries) {
		try {
			const client = new ControlClient({
				metadata: entry.meta,
				label: "ctl-list",
				kind: "cli",
				probe: true,
				timeoutMs: 750,
			});
			const snapshot = await client.connect();
			client.close();
			rows.push({ meta: publicMeta(entry.meta), snapshot });
		} catch {
			rows.push({ meta: publicMeta(entry.meta), snapshot: null, state: "unresponsive" });
		}
	}
	if (json) {
		io.stdout(`${JSON.stringify({ version: 1, sessions: rows }, null, 2)}\n`);
	} else if (rows.length === 0) {
		io.stdout("no control sessions\n");
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

export async function ctlState(selector: string, json: boolean): Promise<number> {
	const client = await connect(selector, "ctl");
	try {
		const response = await client.request({ type: "get_status" });
		if (!response.success) return fail(response.error, response.code);
		const snapshot = response.data as ControlSnapshot;
		io.stdout(json ? `${JSON.stringify(snapshot, null, 2)}\n` : formatSnapshot(snapshot));
		return 0;
	} finally {
		client.close();
	}
}

export async function ctlSend(
	selector: string,
	text: string,
	mode: "prompt" | "steer" | "follow_up" | "input" | "slash",
	json: boolean,
): Promise<number> {
	const client = await connect(selector, "ctl");
	try {
		const command = mode === "input" || mode === "slash" ? { type: mode, text } : { type: mode, message: text };
		const response = await client.request(command, 120_000);
		io.stdout(`${JSON.stringify(response, null, json ? 2 : 0)}\n`);
		return response.success ? 0 : 1;
	} finally {
		client.close();
	}
}

export async function ctlRpc(
	selector: string,
	type: string,
	params: Record<string, unknown>,
	json: boolean,
): Promise<number> {
	const client = await connect(selector, "ctl");
	try {
		const response = await client.request({ type, ...params }, 120_000);
		io.stdout(`${JSON.stringify(response, null, json ? 2 : 0)}\n`);
		return response.success ? 0 : 1;
	} finally {
		client.close();
	}
}

function formatSnapshot(snapshot: ControlSnapshot): string {
	return [
		`${snapshot.instanceId}  ${snapshot.role}  pid=${snapshot.pid}  ready=${snapshot.ready}`,
		`cwd=${snapshot.cwd}`,
		`busy streaming=${snapshot.busy.streaming} queued=${snapshot.busy.queued}`,
		`build ${snapshot.build.gitSha ?? "unknown"}`,
		"",
	].join("\n");
}

function fail(error?: string, code?: string): number {
	io.stderr(`${code ?? "error"}: ${error ?? "failed"}\n`);
	return code === "not_found" || code === "ambiguous" ? 3 : code === "unauthorized" ? 4 : code === "conflict" ? 5 : 1;
}

export function ctlFail(error: unknown): number {
	if (error instanceof ControlClientError) return fail(error.message, error.code);
	io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
	return 1;
}
