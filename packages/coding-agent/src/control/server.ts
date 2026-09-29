/**
 * The control socket server (plan §3.1, §6).
 *
 * One Unix socket per session publication. Every accepted connection is
 * checked for same-user peer credentials before a byte is parsed, challenged,
 * and authenticated by `hello` (bearer token, caller identity, self/nested/
 * cycle policy). Authenticated frames are dispatched by the host: reply-lane
 * frames immediately, everything else under the host budget.
 */
import * as net from "node:net";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import {
	RpcFrameDecoder,
	RpcFrameEncoder,
	MAX_RPC_FRAME_BYTES,
	MAX_RPC_REASSEMBLED_BYTES,
} from "../modes/rpc/rpc-frame";
import { ADMISSIONS_PER_SECOND, HANDSHAKE_TIMEOUT_MS, HostBudget, MAX_CONNECTIONS, workClass } from "./budget";
import { isSameUserPeer, peerCredentials, peerCredentialsSupported, type PeerCredentials } from "./peercred";
import { callerConnectionToken, constantTimeEqual, findControlMetadata, type ControlMetadata } from "./registry";
import {
	CONTROL_PROTOCOL_VERSION,
	type ControlChallengeFrame,
	type ControlOnlyCommand,
	type ControlOrigin,
	type ControlResponse,
	type ControlSnapshot,
} from "./types";

/** What the host does for one authenticated connection. */
export interface ControlConnectionHost {
	readonly instanceId: string;
	readonly token: string;
	readonly budget: HostBudget;
	/** Registry directory, for verifying a caller's publication. */
	readonly registryDir?: string;
	/** Current snapshot for the hello reply. */
	snapshot(): ControlSnapshot;
	/** Dispatch one authenticated command; the response is written by the connection. */
	dispatch(connection: ControlConnection, command: Record<string, unknown>): Promise<void>;
	/** A connection finished authenticating. */
	onAuthenticated?(connection: ControlConnection): void;
	/** A connection closed (authenticated or not). */
	onClosed(connection: ControlConnection): void;
}

let connectionSeq = 0;

/** One accepted socket, from challenge through close. */
export class ControlConnection {
	readonly id: string;
	readonly peer: PeerCredentials;
	readonly decoder = new RpcFrameDecoder();
	readonly encoder = new RpcFrameEncoder();
	readonly budget;
	authenticated = false;
	probe = false;
	label = "";
	kind: "tool" | "cli" | "other" = "other";
	callerInstanceId: string | undefined;
	controlChain: string[] = [];
	protocolVersion = 1;
	/** Admissions in the current one-second window. */
	#admissions = 0;
	#admissionWindow = 0;
	#closed = false;
	#inboundReserved = 0;
	readonly #chunkReserved = new Map<string, number>();

	constructor(
		readonly socket: net.Socket,
		readonly host: ControlConnectionHost,
		peer: PeerCredentials,
	) {
		this.id = `c${++connectionSeq}`;
		this.peer = peer;
		this.budget = host.budget.connection();
	}

	get origin(): ControlOrigin {
		return {
			kind: "control",
			connectionId: this.id,
			label: this.label,
			peerPid: this.peer.pid,
			...(this.callerInstanceId ? { callerInstanceId: this.callerInstanceId } : {}),
			...(this.controlChain.length > 0 ? { controlChain: [...this.controlChain, this.callerInstanceId ?? ""] } : {}),
		};
	}

	/** Ancestry seen by a nested target: the caller's chain plus the caller. */
	get propagatedChain(): string[] {
		return this.callerInstanceId ? [...this.controlChain, this.callerInstanceId] : [...this.controlChain];
	}

	write(frame: object): void {
		if (this.#closed) return;
		try {
			for (const line of this.encoder.encodeFrames(frame)) {
				const bytes = Buffer.byteLength(line);
				if (!this.budget.reserveSpool(bytes)) {
					this.close("client too slow");
					return;
				}
				this.socket.write(line, () => this.budget.releaseSpool(bytes));
			}
		} catch (error) {
			logger.warn("control: write failed", { connectionId: this.id, error: String(error) });
			this.close("write failed");
		}
	}

	respond(response: ControlResponse): void {
		this.write(response);
	}

	/** True when another admission would exceed the soft rate. */
	rateLimited(): boolean {
		const now = Math.floor(Date.now() / 1000);
		if (now !== this.#admissionWindow) {
			this.#admissionWindow = now;
			this.#admissions = 0;
		}
		if (this.#admissions >= ADMISSIONS_PER_SECOND) return true;
		this.#admissions++;
		return false;
	}

	close(reason?: string): void {
		if (this.#closed) return;
		this.#closed = true;
		if (reason) {
			logger.info("control: connection closed", { connectionId: this.id, reason });
		}
		this.budget.releaseAll();
		if (this.#inboundReserved > 0) this.host.budget.releaseInbound(this.#inboundReserved);
		this.socket.destroy();
		this.host.onClosed(this);
	}

	/** Feed one parsed frame (tests and the socket reader). */
	async handleFrame(frame: Record<string, unknown>): Promise<void> {
		if (!this.authenticated) {
			await this.#authenticate(frame);
			return;
		}
		const type = typeof frame.type === "string" ? frame.type : "";
		const kind = workClass(type, frame);
		if (kind !== "reply" && this.rateLimited()) {
			this.#reject(frame, "rate_limited", "too many requests; slow down");
			return;
		}
		const saturated = this.budget.admit(kind);
		if (saturated) {
			this.#reject(frame, "rate_limited", `${saturated} work limit reached`);
			return;
		}
		try {
			await this.host.dispatch(this, frame);
		} finally {
			if (kind === "ordinary") this.budget.release("ordinary");
		}
	}

	async #authenticate(frame: Record<string, unknown>): Promise<void> {
		if (frame.type !== "hello") {
			this.close("expected hello");
			return;
		}
		const failure = await authenticateHello(frame, this.host, this.peer);
		if (failure) {
			this.respond({
				type: "response",
				command: "hello",
				requestId: typeof frame.requestId === "string" ? frame.requestId : undefined,
				success: false,
				error: failure.message,
				code: failure.code,
			});
			this.close(failure.code);
			return;
		}
		const client = frame.client as Record<string, unknown>;
		this.label = String(client.label);
		this.kind = client.kind as "tool" | "cli" | "other";
		this.callerInstanceId = typeof client.callerInstanceId === "string" ? client.callerInstanceId : undefined;
		this.controlChain = Array.isArray(client.controlChain)
			? client.controlChain.filter((id): id is string => typeof id === "string")
			: [];
		this.probe = frame.probe === true;
		this.protocolVersion = frame.protocolVersion === 2 ? 2 : 1;
		if (this.protocolVersion === 2) this.encoder.setProtocolVersion(2);
		this.authenticated = true;
		this.respond({
			type: "response",
			command: "hello",
			requestId: typeof frame.requestId === "string" ? frame.requestId : undefined,
			success: true,
			data: { connectionId: this.id, snapshot: this.host.snapshot() },
		});
		this.host.onAuthenticated?.(this);
	}

	#reject(frame: Record<string, unknown>, code: string, error: string): void {
		const command = typeof frame.type === "string" ? frame.type : "unknown";
		this.respond({
			type: "response",
			command,
			requestId: typeof frame.requestId === "string" ? frame.requestId : undefined,
			id: typeof frame.id === "string" ? frame.id : undefined,
			success: false,
			error,
			code,
		});
	}

	/** Note inbound bytes reserved for a chunk sequence (released on completion). */
	noteInbound(bytes: number): boolean {
		if (!this.host.budget.reserveInbound(bytes)) return false;
		this.#inboundReserved += bytes;
		return true;
	}

	releaseInbound(bytes: number): void {
		this.#inboundReserved = Math.max(0, this.#inboundReserved - bytes);
		this.host.budget.releaseInbound(bytes);
	}

	/** Reserve one chunk's declared size. Rejects non-integers and negatives. */
	noteChunk(chunkId: string, bytes: number): boolean {
		if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAX_RPC_REASSEMBLED_BYTES) return false;
		// Every physical chunk repeats the logical length; reserve it once per sequence.
		if (this.#chunkReserved.has(chunkId)) return true;
		if (!this.noteInbound(bytes)) return false;
		this.#chunkReserved.set(chunkId, bytes);
		return true;
	}

	releaseChunk(chunkId: string): void {
		const bytes = this.#chunkReserved.get(chunkId) ?? 0;
		this.#chunkReserved.delete(chunkId);
		if (bytes > 0) this.releaseInbound(bytes);
	}
}

export interface HelloFailure {
	code: "unauthorized" | "self_target" | "nested_target" | "cycle";
	message: string;
}

/**
 * Authenticate one `hello`: token, label, caller binding, then the
 * self/nested/cycle policy. Returns the failure or undefined.
 */
export async function authenticateHello(
	frame: Record<string, unknown>,
	host: Pick<ControlConnectionHost, "instanceId" | "token" | "registryDir">,
	peer: PeerCredentials,
): Promise<HelloFailure | undefined> {
	if (!constantTimeEqual(host.token, frame.token)) {
		return { code: "unauthorized", message: "authentication failed" };
	}
	const client = frame.client;
	if (typeof client !== "object" || client === null) {
		return { code: "unauthorized", message: "hello requires a client object" };
	}
	const {
		label,
		kind,
		callerInstanceId,
		callerConnectionToken: presentedCallerToken,
		controlChain,
	} = client as Record<string, unknown>;
	if (typeof label !== "string" || !/^[\x20-\x7e]{1,64}$/.test(label)) {
		return { code: "unauthorized", message: "label must be 1-64 printable characters" };
	}
	if (kind !== "tool" && kind !== "cli" && kind !== "other") {
		return { code: "unauthorized", message: "client.kind must be tool, cli, or other" };
	}
	const chain = Array.isArray(controlChain) ? controlChain.filter((id): id is string => typeof id === "string") : [];
	if (typeof callerInstanceId === "string") {
		const caller = await findControlMetadata(callerInstanceId, { dir: host.registryDir });
		if (!caller) return { code: "unauthorized", message: "caller publication not found" };
		const expected = callerConnectionToken(caller.token, host.instanceId, callerInstanceId);
		if (typeof presentedCallerToken !== "string" || !constantTimeEqual(expected, presentedCallerToken)) {
			return { code: "unauthorized", message: "caller identity could not be verified" };
		}
	} else if (callerInstanceId !== undefined && callerInstanceId !== null) {
		return { code: "unauthorized", message: "callerInstanceId must be a string or null" };
	}
	const override = (frame.override ?? {}) as Record<string, unknown>;
	const allowSelf = override.allowSelf === true;
	const allowNested = override.allowNested === true;
	if (callerInstanceId === host.instanceId && !allowSelf) {
		return { code: "self_target", message: "a session cannot control itself (pass allowSelf to override)" };
	}
	if (chain.includes(host.instanceId) && !(allowSelf && allowNested)) {
		return { code: "cycle", message: "this session is already in the caller's control chain" };
	}
	if (chain.length > 0 && !allowNested) {
		return { code: "nested_target", message: "the caller is itself under control (pass allowNested to override)" };
	}
	void peer;
	return undefined;
}

export interface ControlServerOptions {
	host: ControlConnectionHost;
	/** Metadata of the publication, for the challenge frame. */
	metadata: Pick<ControlMetadata, "instanceId">;
}

/**
 * Serve one publication's socket. Peer credentials are checked before any byte
 * is parsed; a failed check destroys the socket.
 */
export class ControlServer {
	readonly #options: ControlServerOptions;
	readonly connections = new Set<ControlConnection>();
	#disabled = false;

	constructor(options: ControlServerOptions) {
		this.#options = options;
		if (!peerCredentialsSupported()) {
			this.#disabled = true;
			logger.warn("control: peer credentials unavailable; control socket disabled for this process");
		}
	}

	get disabled(): boolean {
		return this.#disabled;
	}

	/** Handle one accepted socket (the registry server calls this). */
	accept(socket: net.Socket): void {
		if (this.#disabled) {
			socket.destroy();
			return;
		}
		const creds = peerCredentials(socket);
		if (!isSameUserPeer(creds)) {
			logger.info("control: rejected connection", { reason: "peer credentials" });
			socket.destroy();
			return;
		}
		if (this.connections.size >= MAX_CONNECTIONS) {
			socket.destroy();
			return;
		}
		const connection = new ControlConnection(socket, this.#options.host, creds);
		this.connections.add(connection);
		const challenge: ControlChallengeFrame = {
			type: "challenge",
			instanceId: this.#options.metadata.instanceId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
			supportedProtocolVersions: [1, 2],
		};
		connection.write(challenge);
		this.#read(connection);
		const timer = setTimeout(() => {
			if (!connection.authenticated) connection.close("handshake timeout");
		}, HANDSHAKE_TIMEOUT_MS);
		socket.once("close", () => clearTimeout(timer));
	}

	async #read(connection: ControlConnection): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		connection.socket.setEncoding("utf8");
		connection.socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > MAX_RPC_FRAME_BYTES * 4 && !buffer.includes("\n")) {
				connection.close("frame_too_large");
				return;
			}
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (line.trim().length === 0) continue;
				if (Buffer.byteLength(line) > MAX_RPC_FRAME_BYTES) {
					connection.close("frame_too_large");
					return;
				}
				void this.#dispatchLine(connection, decoder.decode(Buffer.from(line))).catch(error => {
					logger.warn("control: frame dispatch failed", { error: String(error) });
				});
			}
		});
		connection.socket.once("close", () => {
			this.connections.delete(connection);
			connection.close();
		});
		connection.socket.on("error", () => connection.close("socket error"));
	}

	async #dispatchLine(connection: ControlConnection, line: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
			let reservedChunk: string | undefined;
			if (isRecord(parsed) && parsed.type === "rpc_chunk") {
				const bytes = parsed.byteLength;
				const chunkId = typeof parsed.chunkId === "string" ? parsed.chunkId : "";
				if (
					!chunkId ||
					typeof bytes !== "number" ||
					!Number.isInteger(bytes) ||
					bytes < 0 ||
					bytes > MAX_RPC_REASSEMBLED_BYTES
				) {
					connection.close("frame_too_large");
					return;
				}
				if (!connection.noteChunk(chunkId, bytes)) {
					connection.close("rate_limited");
					return;
				}
				reservedChunk = chunkId;
			}
			let assembled: unknown;
			try {
				assembled = connection.decoder.push(parsed);
			} catch {
				// An interrupted chunk has no reservation on the interrupting frame.
				// Closing releases the decoder's active sequence and every inbound
				// reservation, rather than leaving a 64 MiB budget hold on a live socket.
				connection.close("invalid chunk sequence");
				return;
			}
			if (assembled && reservedChunk) connection.releaseChunk(reservedChunk);
			parsed = assembled;
		} catch (error) {
			connection.respond({
				type: "response",
				command: "parse",
				success: false,
				error: error instanceof Error ? error.message : String(error),
				code: "parse",
			});
			return;
		}
		if (!parsed || typeof parsed !== "object") return;
		await connection.handleFrame(parsed as Record<string, unknown>);
	}
}

/** Structural guard for a control-only command frame. */
export function isControlCommand(
	frame: Record<string, unknown>,
): frame is ControlOnlyCommand & Record<string, unknown> {
	return typeof frame.type === "string";
}
