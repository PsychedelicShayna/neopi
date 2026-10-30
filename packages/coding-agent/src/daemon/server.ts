/**
 * The session daemon: one per user and profile, owner of hosted sessions.
 *
 * Each hosted session is a headless `npi --mode rpc-ui` runtime (the same
 * process NeoCode drives over stdio), so sessions publish their own control
 * sockets and `ctl` keeps working unchanged. The daemon keeps every child's
 * stdin open for the child's lifetime; viewers attach and detach through
 * {@link SessionRelay} without ever ending the session.
 *
 * Wire protocol on the daemon socket: rpc-frame JSONL, i.e. rpc-ui frames plus
 * a small envelope (`daemon.list`, `daemon.new`, `daemon.attach`,
 * `daemon.detach`, `daemon.kill`, `daemon.shutdown`). After `daemon.attach` the
 * connection carries that session's rpc-ui stream.
 */
import * as path from "node:path";
import { FileLock, IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { RpcFrameDecoder, RpcFrameEncoder } from "../modes/rpc/rpc-frame";
import { resolveCliEntryCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { SESSION_DAEMON_DIR_ENV, sessionDaemonDir, sessionDaemonEndpoint } from "./paths";
import { type RelayViewer, SessionRelay } from "./relay";

export type HostedStatus = "starting" | "running" | "needs_input" | "idle" | "exited";

/** One hub row. */
export interface HostedSessionInfo {
	id: string;
	pid: number | undefined;
	cwd: string;
	title: string | null;
	model: string | null;
	status: HostedStatus;
	viewers: number;
	createdAt: number;
	lastActivity: number;
	sessionFile: string | null;
	exitCode?: number | null;
}

/** How the daemon spawns a hosted session's runtime (tests substitute a fake child). */
export type SessionCommand = (args: string[]) => string[];

export interface SessionDaemonOptions {
	dir: string;
	/** Command prefix for a hosted runtime; `args` are appended. Defaults to re-entering this CLI. */
	sessionCommand?: SessionCommand;
	/** Extra environment for hosted runtimes. */
	env?: Record<string, string>;
}

interface Hosted {
	info: HostedSessionInfo;
	relay: SessionRelay;
	process: Bun.Subprocess<"pipe", "pipe", "pipe">;
	ready: boolean;
}

const defaultSessionCommand: SessionCommand = args => [...resolveCliEntryCmd(), "--mode", "rpc-ui", ...args];

let viewerSeq = 0;
const STDERR_TAIL_CHARS = 4_000;

export class SessionDaemon {
	readonly #options: SessionDaemonOptions;
	readonly #sessions = new Map<string, Hosted>();
	#server: IpcServer | undefined;
	#lock: FileLock | undefined;
	readonly #closed = Promise.withResolvers<void>();

	constructor(options: SessionDaemonOptions) {
		this.#options = options;
	}

	get endpoint(): string {
		return sessionDaemonEndpoint(this.#options.dir);
	}

	/** Resolves when the daemon has shut down. */
	get closed(): Promise<void> {
		return this.#closed.promise;
	}

	/** Claim the per-profile lease and listen. Returns false when another daemon owns the scope. */
	async start(): Promise<boolean> {
		const lock = FileLock.tryAcquire(path.join(this.#options.dir, "daemon.lock"));
		if (!lock.acquired) return false;
		this.#lock = lock;
		await Bun.write(path.join(this.#options.dir, "daemon.pid"), JSON.stringify({ pid: process.pid }));
		this.#server = await IpcServer.listen(this.endpoint, { framing: "lines" }, connection =>
			this.#accept(connection),
		);
		return true;
	}

	list(): HostedSessionInfo[] {
		return [...this.#sessions.values()].map(hosted => ({ ...hosted.info, ...this.#liveFields(hosted) }));
	}

	/** Start a hosted session; `args` are ordinary npi launch arguments (`--resume`, `--model`, ...). */
	create(cwd: string, args: string[] = []): HostedSessionInfo {
		const id = crypto.randomUUID().slice(0, 8);
		const command = (this.#options.sessionCommand ?? defaultSessionCommand)(args);
		const child = Bun.spawn(command, {
			cwd,
			env: workerEnvFromParent({ ...this.#options.env, PI_NO_TITLE: "1" }),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const encoder = new RpcFrameEncoder();
		const relay = new SessionRelay(frame => {
			try {
				child.stdin.write(encoder.encode(frame));
				void child.stdin.flush();
			} catch (error) {
				logger.warn("session-daemon: child write failed", { id, error: String(error) });
			}
		});
		const now = Date.now();
		const hosted: Hosted = {
			info: {
				id,
				pid: child.pid,
				cwd,
				title: null,
				model: null,
				status: "starting",
				viewers: 0,
				createdAt: now,
				lastActivity: now,
				sessionFile: null,
			},
			relay,
			process: child,
			ready: false,
		};
		this.#sessions.set(id, hosted);
		void this.#pump(hosted);
		void this.#drainStderr(hosted);
		void child.exited.then(code => {
			hosted.info.status = "exited";
			hosted.info.exitCode = code;
			relay.close();
			logger.info("session-daemon: hosted session exited", { id, code });
		});
		return this.list().find(info => info.id === id)!;
	}

	/** Terminate a hosted session. */
	async kill(id: string): Promise<boolean> {
		const hosted = this.#sessions.get(id);
		if (!hosted) return false;
		hosted.process.kill("SIGTERM");
		const exited = await Promise.race([hosted.process.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
		if (!exited) hosted.process.kill("SIGKILL");
		this.#sessions.delete(id);
		return true;
	}

	async shutdown(): Promise<void> {
		await this.#server?.close();
		this.#server = undefined;
		await Promise.all([...this.#sessions.keys()].map(id => this.kill(id)));
		this.#lock?.release();
		this.#lock = undefined;
		this.#closed.resolve();
	}

	#liveFields(hosted: Hosted): Partial<HostedSessionInfo> {
		const { relay } = hosted;
		const status: HostedStatus =
			hosted.info.status === "exited"
				? "exited"
				: !hosted.ready
					? "starting"
					: relay.pendingInteractions > 0
						? "needs_input"
						: relay.streaming
							? "running"
							: "idle";
		return { status, viewers: relay.viewerCount, lastActivity: relay.lastActivity };
	}

	async #pump(hosted: Hosted): Promise<void> {
		const decoder = new RpcFrameDecoder();
		const text = new TextDecoder();
		let buffer = "";
		const reader = (hosted.process.stdout as ReadableStream<Uint8Array>).getReader();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += text.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line) continue;
				let frame: object | undefined;
				try {
					frame = decoder.push(JSON.parse(line));
				} catch (error) {
					logger.warn("session-daemon: bad child frame", { id: hosted.info.id, error: String(error) });
					continue;
				}
				if (!frame) continue;
				this.#onChildFrame(hosted, frame as Record<string, unknown>);
			}
		}
	}

	#onChildFrame(hosted: Hosted, frame: Record<string, unknown>): void {
		if (frame.type === "ready" && !hosted.ready) {
			hosted.ready = true;
			// Chunked frames are reassembled here, so the daemon takes the larger v2 ceiling.
			void hosted.relay.query({ type: "negotiate_protocol", protocolVersion: 2 });
			void this.#refreshInfo(hosted);
		}
		if (frame.type === "agent_end" || frame.type === "session_info_changed" || frame.type === "config_update") {
			void this.#refreshInfo(hosted);
		}
		hosted.relay.fromChild(frame);
	}

	/** Pull hub metadata (title, model, session file) through an internal `get_state`. */
	async #refreshInfo(hosted: Hosted): Promise<void> {
		const response = await hosted.relay.query({ type: "get_state", includeDump: false });
		if (response.success !== true || typeof response.data !== "object" || response.data === null) return;
		const state = response.data as Record<string, unknown>;
		const model = state.model as { provider?: string; id?: string } | undefined;
		hosted.info.model = model?.provider && model.id ? `${model.provider}/${model.id}` : null;
		hosted.info.title = typeof state.sessionName === "string" ? state.sessionName : null;
		hosted.info.sessionFile = typeof state.sessionFile === "string" ? state.sessionFile : null;
	}

	/** Keep only the last few KiB of a hosted runtime's stderr, for the exit log. */
	async #drainStderr(hosted: Hosted): Promise<void> {
		const decoder = new TextDecoder();
		let tail = "";
		for await (const chunk of hosted.process.stderr as ReadableStream<Uint8Array>) {
			tail = (tail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS);
		}
		if (tail.trim()) logger.debug("session-daemon: hosted stderr", { id: hosted.info.id, text: tail });
	}

	#accept(connection: IpcConnection): void {
		const encoder = new RpcFrameEncoder();
		const decoder = new RpcFrameDecoder();
		let attached: { hosted: Hosted; viewer: RelayViewer } | undefined;
		const send = (frame: object): void => {
			for (const line of encoder.encodeFrames(frame))
				connection.send(line.endsWith("\n") ? line.slice(0, -1) : line);
		};
		const reply = (id: unknown, command: string, data?: unknown, error?: string): void =>
			send(
				error === undefined
					? { type: "response", id, command, success: true, data }
					: { type: "response", id, command, success: false, error },
			);
		const detach = (): void => {
			if (!attached) return;
			attached.hosted.relay.detach(attached.viewer.id);
			attached = undefined;
		};
		connection.start(
			line => {
				let frame: Record<string, unknown>;
				try {
					const decoded = decoder.push(JSON.parse(line));
					if (!decoded) return;
					frame = decoded as Record<string, unknown>;
				} catch (error) {
					send({ type: "response", command: "parse", success: false, error: String(error) });
					return;
				}
				const type = typeof frame.type === "string" ? frame.type : "";
				if (!type.startsWith("daemon.")) {
					if (attached) attached.hosted.relay.fromViewer(attached.viewer.id, frame);
					else reply(frame.id, type, undefined, "Not attached: send daemon.attach first");
					return;
				}
				switch (type) {
					case "daemon.list":
						reply(frame.id, type, { sessions: this.list(), pid: process.pid });
						return;
					case "daemon.new": {
						const cwd = typeof frame.cwd === "string" ? frame.cwd : process.cwd();
						const args = Array.isArray(frame.args) ? frame.args.filter(a => typeof a === "string") : [];
						try {
							reply(frame.id, type, { session: this.create(cwd, args) });
						} catch (error) {
							// A bad cwd or argv must fail this request, never the daemon and its other sessions.
							reply(frame.id, type, undefined, error instanceof Error ? error.message : String(error));
						}
						return;
					}
					case "daemon.attach": {
						const hosted = typeof frame.sessionId === "string" ? this.#sessions.get(frame.sessionId) : undefined;
						if (!hosted || hosted.info.status === "exited") {
							reply(frame.id, type, undefined, `No running session ${String(frame.sessionId)}`);
							return;
						}
						detach();
						const viewer: RelayViewer = {
							id: `v${++viewerSeq}`,
							send,
							setProtocolVersion: version => encoder.setProtocolVersion(version),
						};
						attached = { hosted, viewer };
						hosted.relay.attach(viewer, frame.id);
						return;
					}
					case "daemon.detach":
						detach();
						reply(frame.id, type);
						return;
					case "daemon.kill": {
						const id = typeof frame.sessionId === "string" ? frame.sessionId : "";
						void this.kill(id).then(killed =>
							killed ? reply(frame.id, type) : reply(frame.id, type, undefined, `No session ${id}`),
						);
						return;
					}
					case "daemon.shutdown":
						reply(frame.id, type);
						void this.shutdown();
						return;
					default:
						reply(frame.id, type, undefined, `Unknown daemon command ${type}`);
				}
			},
			() => detach(),
		);
	}
}

/** Entry for the hidden `__omp_worker_session_daemon` selector. */
export async function startSessionDaemonFromEnvironment(): Promise<void> {
	const dir = process.env[SESSION_DAEMON_DIR_ENV] || sessionDaemonDir();
	const daemon = new SessionDaemon({ dir });
	if (!(await daemon.start())) {
		logger.info("session-daemon: another daemon owns this profile; exiting", { dir });
		return;
	}
	logger.info("session-daemon: listening", { endpoint: daemon.endpoint, pid: process.pid });
	process.on("SIGTERM", () => void daemon.shutdown());
	await daemon.closed;
	process.exit(0);
}
