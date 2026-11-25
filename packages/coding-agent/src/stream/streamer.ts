import * as readline from "node:readline";
import { IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { getLocale, type Locale, t } from "@oh-my-pi/pi-utils/i18n";
import {
	STREAM_CHAT_TEXT_MAX,
	STREAM_CLOSE_HOST_CONFLICT,
	STREAM_PROTO,
	STREAM_ROUTES,
	STREAM_TITLE_MAX,
	type StreamChatMessage,
	type StreamPaneFrame,
	type StreamServerToHost,
} from "@oh-my-pi/pi-wire";
import {
	applyScreenFrame,
	isSessionFrame,
	MAX_LOCAL_LINE_BYTES,
	STREAM_LOCAL_PROTO,
	type StreamScreen,
	type StreamSessionFrame,
	type StreamStreamerFrame,
} from "./protocol";
import { streamSocketEndpoint } from "./paths";
import { runStreamTui, type StreamTuiInfo } from "./console-tui";
import { StreamServerClient, type StreamServerFatalError } from "./server-client";

interface PaneState extends StreamScreen {
	id: number;
	title: string;
	paused: boolean;
}

interface LocalConnection {
	conn: IpcConnection;
	pane?: PaneState;
}

export interface StreamUrls {
	hostUrl: string;
}

export type StreamConsoleEvent =
	| {
			t: "link";
			state: "connecting" | "live" | "reconnecting" | "stopped";
			detail?: string;
			channel?: string;
			user?: string;
	  }
	| { t: "pane"; action: "attached" | "closed"; id: number; title: string; cols: number; rows: number }
	| { t: "viewers"; n: number }
	| { t: "chat"; msg: StreamChatMessage }
	| { t: "title"; title: string }
	| { t: "error"; message: string }
	| { t: "notice"; message: string };

interface StreamConnectionOptions {
	projectDir: string;
	title: string;
	hostUrl: string;
	/** Bearer token resolver for the host socket (see `StencilCredential`). */
	token: () => Promise<string | null>;
	/** Test seam; production uses the server client's normal retry policy. */
	reconnectDelay?: (attempt: number) => number;
}

export interface StreamMuxHostOptions extends StreamConnectionOptions {
	onEvent: (event: StreamConsoleEvent) => void;
}

export interface StreamConsoleOptions extends StreamConnectionOptions {
	noTui?: boolean;
}

/** Convert a public stream base URL into its identity-derived host WebSocket route. */
export function resolveStreamUrls(baseUrl: string): StreamUrls {
	let base: URL;
	try {
		base = new URL(baseUrl);
	} catch {
		throw new Error(t("cli.commands.stream.invalidServerUrl", { url: baseUrl }));
	}
	if (!(["http:", "https:", "ws:", "wss:"] as const).some(protocol => protocol === base.protocol)) {
		throw new Error(t("cli.commands.stream.serverUrlProtocol", { url: baseUrl }));
	}
	base.hash = "";
	base.search = "";
	base.pathname = base.pathname.replace(/\/+$/, "");
	const socketUrl = new URL(base.toString());
	if (socketUrl.protocol === "http:") socketUrl.protocol = "ws:";
	if (socketUrl.protocol === "https:") socketUrl.protocol = "wss:";
	const socketBase = socketUrl.toString().replace(/\/$/, "");
	return { hostUrl: `${socketBase}${STREAM_ROUTES.host}` };
}

/** Local session multiplexer and materialized-state owner for one live channel. */
export class StreamMuxHost {
	readonly #options: StreamMuxHostOptions;
	readonly #onEvent: (event: StreamConsoleEvent) => void;
	readonly #eventLocale: Locale;
	readonly #client: StreamServerClient;
	readonly #connections = new Set<LocalConnection>();
	readonly #panes = new Map<number, PaneState>();
	readonly #finished = Promise.withResolvers<number>();
	#server?: IpcServer;
	#nextPaneId = 1;
	#viewerCount?: number;
	#channel = "";
	#viewerUrl = "";
	#title: string;
	#started = false;
	#closing = false;

	constructor(options: StreamMuxHostOptions, eventLocale: Locale = "en") {
		this.#options = options;
		this.#onEvent = options.onEvent;
		this.#eventLocale = eventLocale;
		this.#title = options.title;
		this.#client = new StreamServerClient({
			url: options.hostUrl,
			title: options.title,
			token: options.token,
			replay: () => this.#replayFrames(),
			onFrame: frame => this.#handleServerFrame(frame),
			onFatal: error => void this.#handleFatal(error),
			onDisconnect: delayMs =>
				this.#onEvent({
					t: "link",
					state: "reconnecting",
					detail: t(this.#eventLocale, "cli.commands.stream.retrying", {
						seconds: Math.round(delayMs / 1000),
					}),
				}),
			reconnectDelay: options.reconnectDelay,
		});
	}

	async start(): Promise<string> {
		if (this.#started) throw new Error(t("cli.commands.stream.alreadyStarted"));
		this.#started = true;
		const endpoint = await streamSocketEndpoint(this.#options.projectDir);
		try {
			this.#server = await IpcServer.listen(
				endpoint,
				{ framing: "lines", maxFrameBytes: MAX_LOCAL_LINE_BYTES },
				conn => this.#accept(conn),
			);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
				throw new Error(t("cli.commands.stream.directoryInUse", { app: APP_NAME, endpoint }));
			}
			throw error;
		}
		this.#onEvent({ t: "notice", message: t(this.#eventLocale, "cli.commands.stream.connecting") });
		this.#onEvent({ t: "title", title: this.#title });
		this.#onEvent({ t: "link", state: "connecting" });
		this.#client.start();
		return endpoint;
	}

	wait(): Promise<number> {
		return this.#finished.promise;
	}

	sendChat(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (trimmed.startsWith("/title ")) {
			const title = trimmed.slice(7).trim();
			if (!title) return;
			this.setTitle(title);
			return;
		}
		this.#client.send({ t: "chat", text: trimmed.slice(0, STREAM_CHAT_TEXT_MAX) });
	}

	setTitle(title: string): void {
		const trimmed = title.trim();
		if (!trimmed) return;
		if (trimmed.length > STREAM_TITLE_MAX) {
			this.#onEvent({
				t: "error",
				message: t(this.#eventLocale, "cli.commands.stream.titleTooLong", { max: STREAM_TITLE_MAX }),
			});
			return;
		}
		this.#title = trimmed;
		this.#client.setTitle(this.#title);
		this.#onEvent({ t: "title", title: this.#title });
	}

	close(reason = "stream ended", exitCode = 0): Promise<void> {
		const detail =
			reason === "stream ended"
				? t(this.#eventLocale, "cli.commands.stream.ended")
				: reason === "stream stopped"
					? t(this.#eventLocale, "cli.commands.stream.stopped")
					: reason;
		return this.#closeWithDetail(reason, exitCode, detail);
	}

	/** Keep the IPC bye reason independent of the language of the console. */
	async #closeWithDetail(reason: string, exitCode: number, detail: string): Promise<void> {
		if (this.#closing) return;
		this.#closing = true;
		const bye: StreamStreamerFrame = { t: "bye", reason };
		for (const connection of this.#connections) {
			connection.conn.send(JSON.stringify(bye));
			connection.conn.end();
		}
		this.#connections.clear();
		this.#panes.clear();
		this.#client.close();
		this.#onEvent({ t: "link", state: "stopped", detail });

		const server = this.#server;
		this.#server = undefined;
		if (server) await server.close();
		this.#finished.resolve(exitCode);
	}

	#accept(conn: IpcConnection): void {
		if (this.#closing) {
			conn.destroy();
			return;
		}
		const connection: LocalConnection = { conn };
		this.#connections.add(connection);
		conn.start(
			frame => {
				if (conn.closed) return;
				if (!this.#handleLocalLine(connection, frame)) conn.destroy();
			},
			() => this.#detach(connection),
		);
	}

	#handleLocalLine(connection: LocalConnection, line: string): boolean {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return false;
		}
		if (!isSessionFrame(value)) return false;
		if (!connection.pane) return this.#attach(connection, value);
		if (value.t === "hello") return false;
		this.#applyFrame(connection.pane, value);
		return true;
	}

	#attach(connection: LocalConnection, frame: StreamSessionFrame): boolean {
		if (frame.t !== "hello" || frame.proto !== STREAM_LOCAL_PROTO) return false;
		const pane: PaneState = {
			id: this.#nextPaneId++,
			title: frame.title.slice(0, STREAM_TITLE_MAX),
			cols: frame.cols,
			rows: frame.rows,
			history: [],
			viewport: Array.from({ length: frame.rows }, () => ""),
			paused: false,
		};
		connection.pane = pane;
		this.#panes.set(pane.id, pane);
		connection.conn.send(JSON.stringify(this.#sessionWelcome()));
		if (this.#viewerCount !== undefined) {
			connection.conn.send(JSON.stringify({ t: "viewers", n: this.#viewerCount }));
		}
		this.#client.send({ t: "pane-open", pane: pane.id, title: pane.title, cols: pane.cols, rows: pane.rows });
		this.#onEvent({
			t: "pane",
			action: "attached",
			id: pane.id,
			title: pane.title,
			cols: pane.cols,
			rows: pane.rows,
		});
		return true;
	}

	#applyFrame(pane: PaneState, frame: Exclude<StreamSessionFrame, { t: "hello" }>): void {
		if (frame.t === "paused") pane.paused = frame.paused;
		else applyScreenFrame(pane, frame);
		const wire: StreamPaneFrame = { ...frame, pane: pane.id };
		this.#client.send(wire);
	}

	#detach(connection: LocalConnection): void {
		this.#connections.delete(connection);
		const pane = connection.pane;
		if (!pane || !this.#panes.delete(pane.id)) return;
		if (!this.#closing) {
			this.#client.send({ t: "pane-close", pane: pane.id });
			this.#onEvent({
				t: "pane",
				action: "closed",
				id: pane.id,
				title: pane.title,
				cols: pane.cols,
				rows: pane.rows,
			});
		}
	}

	*#replayFrames(): IterableIterator<StreamPaneFrame> {
		for (const pane of this.#panes.values()) {
			yield { t: "pane-open", pane: pane.id, title: pane.title, cols: pane.cols, rows: pane.rows };
			yield { t: "history", pane: pane.id, rows: pane.history };
			yield { t: "viewport", pane: pane.id, rows: pane.viewport };
			yield { t: "paused", pane: pane.id, paused: pane.paused };
		}
	}

	#handleServerFrame(frame: StreamServerToHost): void {
		switch (frame.t) {
			case "welcome":
				if (frame.proto !== STREAM_PROTO) {
					const reason = `stream protocol mismatch (server ${frame.proto}, client ${STREAM_PROTO})`;
					const message = t(this.#eventLocale, "cli.commands.stream.protocolMismatch", {
						server: frame.proto,
						client: STREAM_PROTO,
					});
					this.#onEvent({ t: "error", message });
					void this.#closeWithDetail(reason, 1, message);
					return;
				}
				this.#channel = frame.channel;
				this.#viewerUrl = frame.url;
				this.#broadcast(this.#sessionWelcome());
				this.#onEvent({
					t: "link",
					state: "live",
					detail: frame.url,
					channel: frame.channel,
					user: frame.user,
				});
				break;
			case "viewers":
				this.#broadcast({ t: "viewers", n: frame.n });
				if (frame.n !== this.#viewerCount) {
					this.#viewerCount = frame.n;
					this.#onEvent({ t: "viewers", n: frame.n });
				}
				break;
			case "chat":
				this.#broadcast({ t: "chat", msg: frame.msg });
				this.#onEvent({ t: "chat", msg: frame.msg });
				break;
			case "error":
				this.#onEvent({
					t: "error",
					message: t(this.#eventLocale, "cli.commands.stream.serverError", { message: frame.message }),
				});
				break;
		}
	}

	#sessionWelcome(): StreamStreamerFrame {
		return { t: "welcome", proto: STREAM_LOCAL_PROTO, channel: this.#channel, url: this.#viewerUrl };
	}

	#broadcast(frame: StreamStreamerFrame): void {
		const line = JSON.stringify(frame);
		for (const connection of this.#connections) {
			if (connection.pane) connection.conn.send(line);
		}
	}

	async #handleFatal(error: StreamServerFatalError): Promise<void> {
		const conflict = error.code === STREAM_CLOSE_HOST_CONFLICT;
		const reason = conflict ? "your channel already has a live host" : error.message;
		const message = conflict ? t(this.#eventLocale, "cli.commands.stream.hostConflict") : reason;
		this.#onEvent({ t: "error", message });
		await this.#closeWithDetail(reason, 1, message);
	}
}

/** Render stream events as the original line-oriented console output. */
export function logConsoleSink(): (event: StreamConsoleEvent) => void {
	return event => {
		switch (event.t) {
			case "link":
				if (event.state === "live") {
					process.stdout.write(`live: ${event.detail ?? ""}\n`);
				} else if (event.state === "reconnecting") {
					process.stderr.write(`stream server connection lost; ${event.detail ?? "reconnecting"}\n`);
				}
				break;
			case "pane":
				process.stdout.write(
					event.action === "attached"
						? `pane attached: #${event.id} ${event.title} ${event.cols}x${event.rows}\n`
						: `pane closed: #${event.id} ${event.title}\n`,
				);
				break;
			case "viewers":
				process.stdout.write(`viewers: ${event.n}\n`);
				break;
			case "chat":
				process.stdout.write(`${formatChat(event.msg)}\n`);
				break;
			case "title":
				process.stdout.write(`title: ${event.title}\n`);
				break;
			case "error":
				process.stderr.write(`${event.message}\n`);
				break;
			case "notice":
				process.stdout.write(`${event.message}\n`);
				break;
		}
	};
}

/** Run the foreground console UX until a signal or fatal server rejection. */
export async function runStreamConsole(options: StreamConsoleOptions): Promise<number> {
	const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true && !options.noTui;
	const events: StreamConsoleEvent[] = [];
	const listeners = new Set<(event: StreamConsoleEvent) => void>();
	const sink = interactive
		? (event: StreamConsoleEvent): void => {
				if (listeners.size === 0) events.push(event);
				for (const listener of listeners) listener(event);
			}
		: logConsoleSink();
	// The line-oriented console keeps its original output for scripts.
	const host = new StreamMuxHost({ ...options, onEvent: sink }, interactive ? getLocale() : "en");
	await host.start();

	const stop = (): void => {
		void host.close("stream stopped");
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);

	let input: readline.Interface | undefined;
	try {
		if (interactive) {
			const info: StreamTuiInfo = {
				title: options.title,
				initialEvents: events.slice(),
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			};
			await runStreamTui(host, info);
		} else {
			input = readline.createInterface({ input: process.stdin, terminal: false });
			input.on("line", line => host.sendChat(line));
		}
		return await host.wait();
	} finally {
		input?.close();
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}

function formatChat(message: StreamChatMessage): string {
	const time = new Date(message.ts);
	const hours = String(time.getHours()).padStart(2, "0");
	const minutes = String(time.getMinutes()).padStart(2, "0");
	return `[${hours}:${minutes}] ${message.name}: ${message.text}`;
}
