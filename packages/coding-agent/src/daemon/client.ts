/**
 * Client side of the session-daemon socket: start the daemon when needed,
 * list/create sessions, and attach to one as an rpc-ui viewer.
 */
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { SESSION_DAEMON_WORKER_ARG } from "../cli/worker-selectors";
import { RpcFrameDecoder, RpcFrameEncoder } from "../modes/rpc/rpc-frame";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { SESSION_DAEMON_DIR_ENV, sessionDaemonDir, sessionDaemonEndpoint } from "./paths";
import type { HostedSessionInfo } from "./server";

const CONNECT_TIMEOUT_MS = 250;
const START_DEADLINE_MS = 8_000;

export class SessionDaemonClient {
	readonly #connection: IpcConnection;
	readonly #encoder = new RpcFrameEncoder();
	readonly #decoder = new RpcFrameDecoder();
	readonly #pending = new Map<string, PromiseWithResolvers<Record<string, unknown>>>();
	readonly #frameListeners = new Set<(frame: Record<string, unknown>) => void>();
	readonly #closed = Promise.withResolvers<string | null>();
	#isClosed = false;
	#nextId = 0;

	private constructor(connection: IpcConnection) {
		this.#connection = connection;
		connection.start(
			line => this.#onLine(line),
			reason => {
				this.#isClosed = true;
				for (const pending of this.#pending.values())
					pending.reject(new Error(reason ?? "daemon connection closed"));
				this.#pending.clear();
				this.#closed.resolve(reason);
			},
		);
	}

	static async connect(endpoint: string = sessionDaemonEndpoint(currentDaemonDir())): Promise<SessionDaemonClient> {
		return new SessionDaemonClient(
			await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: CONNECT_TIMEOUT_MS }),
		);
	}

	/** Resolves with the close reason (`null` for an orderly close). */
	get closed(): Promise<string | null> {
		return this.#closed.promise;
	}

	/** Every frame that is not a response to a request made through {@link request}. */
	onFrame(listener: (frame: Record<string, unknown>) => void): () => void {
		this.#frameListeners.add(listener);
		return () => this.#frameListeners.delete(listener);
	}

	send(frame: Record<string, unknown>): void {
		for (const line of this.#encoder.encodeFrames(frame))
			this.#connection.send(line.endsWith("\n") ? line.slice(0, -1) : line);
	}

	/** Send a command with a fresh id and await its `response`. Rejects on `success:false`. */
	async request(frame: Record<string, unknown>): Promise<unknown> {
		if (this.#isClosed || this.#connection.closed) throw new Error("session daemon connection closed");
		const id = `c${++this.#nextId}`;
		const pending = Promise.withResolvers<Record<string, unknown>>();
		this.#pending.set(id, pending);
		this.send({ ...frame, id });
		const response = await pending.promise;
		if (response.success === false) throw new Error(String(response.error ?? `${String(frame.type)} failed`));
		return response.data;
	}

	async list(): Promise<HostedSessionInfo[]> {
		const data = (await this.request({ type: "daemon.list" })) as { sessions: HostedSessionInfo[] };
		return data.sessions;
	}

	async create(cwd: string, args: string[] = []): Promise<HostedSessionInfo> {
		const data = (await this.request({ type: "daemon.new", cwd, args })) as { session: HostedSessionInfo };
		return data.session;
	}

	/** Attach this connection to a session; resolves with the journal snapshot identity. */
	attach(sessionId: string): Promise<unknown> {
		return this.request({ type: "daemon.attach", sessionId });
	}

	async detach(): Promise<void> {
		await this.request({ type: "daemon.detach" });
	}

	async kill(sessionId: string): Promise<void> {
		await this.request({ type: "daemon.kill", sessionId });
	}

	close(): void {
		this.#connection.end();
	}

	#onLine(line: string): void {
		let frame: Record<string, unknown>;
		try {
			const decoded = this.#decoder.push(JSON.parse(line));
			if (!decoded) return;
			frame = decoded as Record<string, unknown>;
		} catch (error) {
			logger.warn("session-daemon client: bad frame", { error: String(error) });
			return;
		}
		if (frame.type === "response" && typeof frame.id === "string") {
			const pending = this.#pending.get(frame.id);
			if (pending) {
				this.#pending.delete(frame.id);
				pending.resolve(frame);
				return;
			}
		}
		for (const listener of this.#frameListeners) listener(frame);
	}
}

function currentDaemonDir(): string {
	return process.env[SESSION_DAEMON_DIR_ENV] || sessionDaemonDir();
}

/**
 * Connect to the profile's session daemon, starting it detached when nothing
 * answers. Rejects when it cannot be reached within the start deadline; callers
 * fall back to a standalone session.
 */
export async function ensureSessionDaemon(): Promise<SessionDaemonClient> {
	const dir = currentDaemonDir();
	const endpoint = sessionDaemonEndpoint(dir);
	try {
		return await SessionDaemonClient.connect(endpoint);
	} catch {
		// Nothing listening: start one. Racing starters are resolved by the daemon's lock.
	}
	const spawn = resolveWorkerSpawnCmd(SESSION_DAEMON_WORKER_ARG);
	const child = Bun.spawn(spawn.cmd, {
		cwd: spawn.cwd,
		env: workerEnvFromParent({ [SESSION_DAEMON_DIR_ENV]: dir }),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		detached: true,
	});
	child.unref();
	const deadline = Date.now() + START_DEADLINE_MS;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			return await SessionDaemonClient.connect(endpoint);
		} catch (error) {
			// Keep probing even if our child exited: it may have lost the lease to a daemon still binding.
			lastError = error;
			await Bun.sleep(100);
		}
	}
	throw new Error(
		`session daemon did not start: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
	);
}
