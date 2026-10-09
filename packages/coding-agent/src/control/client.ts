/**
 * Client for one control endpoint (plan §7, §8).
 *
 * Connects by registry metadata, verifies the server's challenge against the
 * instance id before sending the token, completes `hello`, and correlates
 * responses by `requestId`. Never spawns processes.
 */
import * as net from "node:net";
import { RpcFrameDecoder, RpcFrameEncoder } from "../modes/rpc/rpc-frame";
import { callerConnectionToken, type ControlMetadata } from "./registry";
import { type ControlResponse, type ControlSnapshot } from "./types";

export interface ControlClientOptions {
	metadata: ControlMetadata;
	label: string;
	kind?: "tool" | "cli" | "other";
	/** The caller's own publication, for identity binding. */
	caller?: { instanceId: string; token: string } | null;
	controlChain?: string[];
	allowSelf?: boolean;
	allowNested?: boolean;
	/** Read-only probe (`list`). */
	probe?: boolean;
	timeoutMs?: number;
}

export class ControlClientError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ControlClientError";
	}
}

interface PendingRequest {
	resolve: (response: ControlResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout | undefined;
}

/** One authenticated connection. */
export class ControlClient {
	readonly #options: ControlClientOptions;
	readonly #decoder = new RpcFrameDecoder();
	/** Outbound frames: protocol v2 chunks any command over the 1 MiB line limit. */
	readonly #encoder = new RpcFrameEncoder();
	readonly #pending = new Map<string, PendingRequest>();
	readonly #events: Array<(frame: Record<string, unknown>) => void> = [];
	#socket: net.Socket | undefined;
	#buffer = "";
	#seq = 0;
	#closed = false;
	connectionId = "";
	snapshot: ControlSnapshot | undefined;

	constructor(options: ControlClientOptions) {
		this.#options = options;
	}

	/** Connect, verify the challenge, and authenticate. */
	async connect(): Promise<ControlSnapshot> {
		const { metadata } = this.#options;
		const socket = net.createConnection({ path: metadata.endpoint });
		this.#socket = socket;
		const { promise, resolve, reject } = Promise.withResolvers<ControlSnapshot>();
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new ControlClientError("timeout", "handshake timed out"));
		}, this.#options.timeoutMs ?? 5_000);
		let challenged = false;
		socket.once("error", error => reject(new ControlClientError("unreachable", error.message)));
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			this.#buffer += chunk;
			let newline = this.#buffer.indexOf("\n");
			while (newline >= 0) {
				const line = this.#buffer.slice(0, newline).trim();
				this.#buffer = this.#buffer.slice(newline + 1);
				newline = this.#buffer.indexOf("\n");
				if (!line) continue;
				let frame: Record<string, unknown>;
				try {
					const parsed = this.#decoder.push(JSON.parse(line));
					if (!parsed) continue;
					frame = parsed as Record<string, unknown>;
				} catch (error) {
					reject(new ControlClientError("parse", error instanceof Error ? error.message : String(error)));
					return;
				}
				if (!challenged) {
					challenged = true;
					if (frame.type !== "challenge" || frame.instanceId !== metadata.instanceId) {
						reject(new ControlClientError("unauthorized", "challenge did not match the registry entry"));
						socket.destroy();
						return;
					}
					socket.write(`${JSON.stringify(this.#hello())}\n`);
					continue;
				}
				if (frame.type === "response" && frame.command === "hello") {
					clearTimeout(timer);
					if (frame.success !== true) {
						reject(
							new ControlClientError(
								typeof frame.code === "string" ? frame.code : "unauthorized",
								typeof frame.error === "string" ? frame.error : "hello failed",
							),
						);
						return;
					}
					const data = frame.data as { connectionId?: string; snapshot?: ControlSnapshot } | undefined;
					this.#encoder.setProtocolVersion(2);
					this.connectionId = data?.connectionId ?? "";
					this.snapshot = data?.snapshot;
					resolve(data?.snapshot as ControlSnapshot);
					continue;
				}
				this.#dispatch(frame);
			}
		});
		socket.once("close", () => {
			this.#closed = true;
			for (const pending of this.#pending.values()) {
				if (pending.timer) clearTimeout(pending.timer);
				pending.reject(new ControlClientError("closed", "connection closed"));
			}
			this.#pending.clear();
		});
		return promise;
	}

	#hello(): Record<string, unknown> {
		const { metadata, label, kind, caller, controlChain, allowSelf, allowNested, probe } = this.#options;
		return {
			type: "hello",
			requestId: "h1",
			token: metadata.token,
			protocolVersion: 2,
			client: {
				label,
				kind: kind ?? "cli",
				callerInstanceId: caller?.instanceId ?? null,
				callerConnectionToken: caller
					? callerConnectionToken(caller.token, metadata.instanceId, caller.instanceId)
					: null,
				controlChain: controlChain ?? [],
			},
			override: { allowSelf: allowSelf === true, allowNested: allowNested === true },
			...(probe ? { probe: true } : {}),
		};
	}

	#dispatch(frame: Record<string, unknown>): void {
		if (frame.type === "response") {
			const id =
				typeof frame.requestId === "string" ? frame.requestId : typeof frame.id === "string" ? frame.id : "";
			const pending = this.#pending.get(id);
			if (pending) {
				this.#pending.delete(id);
				if (pending.timer) clearTimeout(pending.timer);
				pending.resolve(frame as unknown as ControlResponse);
				return;
			}
		}
		for (const listener of this.#events) listener(frame);
	}

	/** Send one command and await its response. */
	request(command: Record<string, unknown>, timeoutMs?: number): Promise<ControlResponse> {
		if (this.#closed || !this.#socket) return Promise.reject(new ControlClientError("closed", "not connected"));
		const requestId =
			(command.requestId as string | undefined) ?? (command.id as string | undefined) ?? `r${++this.#seq}`;
		const frame = { ...command, requestId };
		const { promise, resolve, reject } = Promise.withResolvers<ControlResponse>();
		const timeout = timeoutMs ?? this.#options.timeoutMs ?? 30_000;
		const timer =
			timeout > 0
				? setTimeout(() => {
						this.#pending.delete(requestId);
						reject(new ControlClientError("timeout", `${String(command.type)} timed out`));
					}, timeout)
				: undefined;
		this.#pending.set(requestId, { resolve, reject, timer });
		this.#socket.write(this.#encoder.encode(frame));
		return promise;
	}

	/** Listen for non-response frames (events, receipts). Returns an unsubscribe. */
	onEvent(listener: (frame: Record<string, unknown>) => void): () => void {
		this.#events.push(listener);
		return () => {
			const index = this.#events.indexOf(listener);
			if (index >= 0) this.#events.splice(index, 1);
		};
	}

	close(): void {
		if (this.#socket && !this.#closed) {
			try {
				this.#socket.write(`${JSON.stringify({ type: "bye", requestId: "bye" })}\n`);
			} catch {
				// The socket is already gone.
			}
		}
		this.#socket?.destroy();
	}
}
