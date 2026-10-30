/**
 * `npi hub` and `npi new`: the session-hub loop over the daemon.
 *
 * Detaching from a session returns to the hub; quitting the hub leaves every
 * hosted session running.
 */
import { runAttachView } from "./attach-view";
import { ensureSessionDaemon, type SessionDaemonClient } from "./client";
import type { HostedSessionInfo } from "./server";
import { runSessionHub } from "./session-hub";

async function attachLoop(client: SessionDaemonClient, first: HostedSessionInfo | undefined, cwd: string): Promise<void> {
	let next = first;
	for (;;) {
		if (next) {
			// Each attach gets its own connection: the daemon socket is per viewer once attached.
			const viewer = await ensureSessionDaemon();
			try {
				const exit = await runAttachView(viewer, next.id, next.title ?? `session ${next.id}`);
				if (exit === "closed") return;
			} finally {
				viewer.close();
			}
		}
		const choice = await runSessionHub(client);
		if (choice.kind === "quit") return;
		next =
			choice.kind === "new"
				? await client.create(cwd)
				: (await client.list()).find(session => session.id === choice.sessionId);
	}
}

/** `npi hub`: list hosted sessions and attach. */
export async function runHubCommand(cwd: string = process.cwd()): Promise<void> {
	const client = await ensureSessionDaemon();
	try {
		await attachLoop(client, undefined, cwd);
	} finally {
		client.close();
	}
}

/** `npi new [-- launch args]`: create a hosted session and attach to it. */
export async function runNewCommand(args: string[], cwd: string = process.cwd()): Promise<void> {
	const client = await ensureSessionDaemon();
	try {
		await attachLoop(client, await client.create(cwd, args), cwd);
	} finally {
		client.close();
	}
}
