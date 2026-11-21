import { type AuthStorage, type OAuthAccess, withOAuthAccess } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getProxyForUrl, wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import { CODEX_BASE_URL, getCodexAccountId, OPENAI_HEADERS } from "@oh-my-pi/pi-catalog/wire/codex";
import { getCodexClientVersion } from "@oh-my-pi/pi-catalog/wire/codex-version";
import { LiveWebRtcPeer } from "@oh-my-pi/pi-natives";
import { toError } from "@oh-my-pi/pi-utils";
import { NEOPROXY_PROVIDER_ID } from "../config/model-discovery";
import type { ModelRegistry } from "../config/model-registry";
import type { ScopeLike } from "../config/registry";
import { resolveConfigValue } from "../config/resolve-config-value";
import { generateCodexAttestation } from "./attestation";
import { type NeoProxyLiveEndpoint, resolveNeoProxyLiveEndpoint } from "./neoproxy";
import {
	buildLiveSessionPayload,
	buildLiveSessionUpdate,
	type LiveClientMessage,
	type LiveServerEvent,
	parseLiveServerEvent,
} from "./protocol";
import { cfgLiveApiKey, cfgLiveEndpoint } from "./settings";

const SIGNALING_URL = `${CODEX_BASE_URL}/codex/realtime/calls?intent=quicksilver&architecture=avas`;
const MAX_ERROR_BODY_LENGTH = 2_048;
const SIDEBAND_CONNECT_ATTEMPTS = 5;
const SIDEBAND_CONNECT_TIMEOUT_MS = 15_000;
const LIVE_PROVIDER = "openai-codex";
const LIVE_ORIGINATOR = "Codex Desktop";
const LIVE_CALL_ID_PATTERN = /^rtc_[\w-]+$/;
/** Proxy scope of a custom live endpoint: `PI_PROXY_LIVE`, else `PI_PROXY`, else the standard variables. */
const LIVE_ENDPOINT_PROXY = "live";
const MAX_ENDPOINT_REDIRECTS = 5;

type Lifecycle = "idle" | "connecting" | "connected" | "closing" | "closed";

export type LiveProvider = typeof LIVE_PROVIDER | typeof NEOPROXY_PROVIDER_ID;

type LiveRoute =
	| { kind: "custom"; endpoint: LiveEndpoint }
	| { kind: typeof NEOPROXY_PROVIDER_ID; endpoint: NeoProxyLiveEndpoint }
	| { kind: typeof LIVE_PROVIDER; access: OAuthAccess };

/** A custom realtime server that overrides automatic Live routing (the `live.endpoint` setting). */
export interface LiveEndpoint {
	/** Base URL the OpenAI Realtime WebRTC paths hang off, e.g. `http://127.0.0.1:8080/v1`. */
	baseUrl: string;
	/** Resolved bearer key, sent only to this endpoint. */
	apiKey?: string;
}

/**
 * The custom endpoint live calls use, with `live.apiKey` resolved like other configured secrets
 * (literal, environment variable name, or `!command`); `undefined` when `live.endpoint` is empty
 * and the transport selects its route automatically.
 */
export async function resolveLiveEndpoint(scope: ScopeLike): Promise<LiveEndpoint | undefined> {
	const baseUrl = cfgLiveEndpoint.get(scope)?.trim();
	if (!baseUrl) return undefined;
	const keyConfig = cfgLiveApiKey.get(scope)?.trim();
	if (!keyConfig) return { baseUrl };
	const apiKey = await resolveConfigValue(keyConfig);
	if (!apiKey) throw new Error("live.apiKey resolved to no key: its command failed or printed nothing");
	return { baseUrl, apiKey };
}

/** Where and with which credentials the call's sideband WebSocket connects. */
interface LiveSideband {
	url: string;
	headers: Record<string, string>;
	proxyScope: string;
	tls?: Bun.TLSOptions;
}

interface LiveSignalingResult {
	answer: string;
	sideband: LiveSideband;
}

class LiveSignalingError extends Error {
	status: number;
	errorMessage: string;

	constructor(status: number, message: string) {
		super(message);
		this.name = "LiveSignalingError";
		this.status = status;
		this.errorMessage = message;
	}
}

/** Callbacks emitted by the live WebRTC transport. */
export interface LiveTransportCallbacks {
	onEvent(event: LiveServerEvent): void;
	onOutputLevel(level: number): void;
}

/** Configuration required to establish a live call. */
export interface LiveTransportOptions {
	authStorage: AuthStorage;
	/** Explicit custom realtime server; otherwise prefer Codex, then a scoped NeoProxy login. */
	endpoint?: LiveEndpoint;
	modelRegistry?: Pick<ModelRegistry, "getConfigFile">;
	/** Restrict automatic routing when the session selects an offline provider. */
	canUseProvider?(provider: LiveProvider): boolean;
	sessionId: string;
	instructions: string;
	voice: string;
	model: string;
	callbacks: LiveTransportCallbacks;
	signal?: AbortSignal;
	/**
	 * SDP offer from a caller-owned WebRTC peer (one Opus audio track plus an `oai-events`
	 * data channel). When set, no native peer is created: the caller's peer carries the audio,
	 * {@link LiveTransport.sdpAnswer} holds the answer to apply to it, and this transport
	 * keeps only the sideband.
	 */
	sdpOffer?: string;
}

/** Extracts the server-assigned `rtc_*` call ID from a signaling Location header. */
export function parseLiveCallId(location: string | null): string | undefined {
	if (!location) return undefined;
	return location
		.split("?", 1)[0]
		?.split("/")
		.find(segment => LIVE_CALL_ID_PATTERN.test(segment));
}

/** Builds the Frameless Bidi sideband WebSocket URL for an accepted Codex call. */
export function buildLiveSidebandUrl(callId: string): string {
	const url = new URL(`https://api.openai.com/v1/live/${encodeURIComponent(callId)}`);
	url.protocol = "wss:";
	return url.toString();
}

/** Appends `path` to the endpoint base's path, keeping its query (`…/v1` → `…/v1/realtime`). */
function liveEndpointUrl(baseUrl: string, path: string): URL {
	const url = new URL(baseUrl);
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}`;
	return url;
}

/** The custom endpoint's signaling URL: `{base}/realtime/calls`. */
export function liveEndpointCallsUrl(baseUrl: string): string {
	return liveEndpointUrl(baseUrl, "realtime/calls").toString();
}

/** The custom endpoint's sideband URL: `{base as ws(s)}/realtime?call_id=<id>`. */
export function liveEndpointSidebandUrl(baseUrl: string, callId: string): string {
	const url = liveEndpointUrl(baseUrl, "realtime");
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("call_id", callId);
	return url.toString();
}

/** Extracts the call ID a custom endpoint names as the last path segment of its Location header. */
export function parseLiveEndpointCallId(location: string | null): string | undefined {
	const segment = location
		?.split(/[?#]/, 1)[0]
		?.split("/")
		.filter(part => part.length > 0)
		.at(-1);
	if (!segment) return undefined;
	try {
		return decodeURIComponent(segment) || undefined;
	} catch {
		return undefined;
	}
}

/** Headers a custom endpoint receives: its own bearer key, never Codex credentials. */
export function liveEndpointHeaders(endpoint: LiveEndpoint): Record<string, string> {
	return endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {};
}

function liveSessionHeaders(
	access: OAuthAccess,
	sessionId: string,
	voiceSessionId: string,
	attestation: string | undefined,
): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${access.accessToken}`,
		"OpenAI-Alpha": "quicksilver=v2",
		"User-Agent": `Codex Desktop/${getCodexClientVersion()}`,
		"x-session-id": sessionId,
		"voice-session-id": voiceSessionId,
		[OPENAI_HEADERS.ORIGINATOR]: LIVE_ORIGINATOR,
		[OPENAI_HEADERS.VERSION]: getCodexClientVersion(),
		[OPENAI_HEADERS.SCOPED_SESSION_ID]: sessionId,
		[OPENAI_HEADERS.THREAD_ID]: sessionId,
	};
	const accountId = access.accountId ?? getCodexAccountId(access.accessToken);
	if (accountId) headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
	if (attestation) headers["x-oai-attestation"] = attestation;
	return headers;
}

function boundedErrorBody(body: string, statusText: string): string {
	const normalized = body.trim().replaceAll(/\s+/g, " ");
	if (!normalized) return statusText || "empty response body";
	if (normalized.length <= MAX_ERROR_BODY_LENGTH) return normalized;
	return `${normalized.slice(0, MAX_ERROR_BODY_LENGTH)}…`;
}

function abortReason(signal: AbortSignal | undefined): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	return new DOMException("Live connection aborted", "AbortError");
}

/**
 * WebRTC transport for a live session on Codex, NeoProxy, or a custom endpoint, with a native or
 * caller-owned media peer.
 */
export class LiveTransport {
	readonly #options: LiveTransportOptions;
	#provider: LiveProvider | undefined;
	/** Prefix of user-facing errors: which server the call talks to. */
	#label: string;
	#peer: LiveWebRtcPeer | undefined;
	#sdpAnswer: string | undefined;
	readonly #voiceSessionId = crypto.randomUUID();
	#sideband: Bun.WebSocket | undefined;
	#state: Lifecycle = "idle";
	#connectPromise: Promise<void> | undefined;
	#closePromise: Promise<void> | undefined;
	#sendTail: Promise<void> = Promise.resolve();
	#muted = false;
	#outputSuppressed = false;
	#unexpectedFailureReported = false;
	readonly #abortListener: () => void;

	constructor(options: LiveTransportOptions) {
		this.#options = options;
		this.#label = options.endpoint ? "Live endpoint" : "Codex live";
		this.#abortListener = () => {
			void this.close();
		};
		if (!options.signal?.aborted) options.signal?.addEventListener("abort", this.#abortListener, { once: true });
	}

	/** SDP answer for the caller's peer once a {@link LiveTransportOptions.sdpOffer} call has been signaled. */
	get sdpAnswer(): string | undefined {
		return this.#sdpAnswer;
	}

	/** The provider selected automatically for this call; unset for an explicit endpoint. */
	get provider(): LiveProvider | undefined {
		return this.#provider;
	}

	/** Establish the media peer, signal the call, and wait for the data channel or sideband. */
	connect(): Promise<void> {
		if (this.#state === "connected") return Promise.resolve();
		if (this.#connectPromise) return this.#connectPromise;
		if (this.#state === "closing" || this.#state === "closed")
			return Promise.reject(new Error("Live transport is closed"));
		if (this.#options.signal?.aborted) return Promise.reject(abortReason(this.#options.signal));
		this.#state = "connecting";
		const operation = this.#connect().catch(async error => {
			await this.close();
			throw error;
		});
		this.#connectPromise = operation;
		return operation;
	}

	async #connect(): Promise<void> {
		const route = await this.#resolveRoute();
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		if (route.kind !== "custom") {
			this.#provider = route.kind;
			if (route.kind === NEOPROXY_PROVIDER_ID) this.#label = "NeoProxy Live";
			this.#assertProviderAllowed();
		}
		let offer = this.#options.sdpOffer;
		let peer: LiveWebRtcPeer | undefined;
		if (offer === undefined) {
			peer = this.#createPeer();
			this.#peer = peer;
			(peer as LiveWebRtcPeer & { setOutputSuppressed(suppressed: boolean): void }).setOutputSuppressed(
				this.#outputSuppressed,
			);
			offer = await peer.createOffer();
		}
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		this.#assertProviderAllowed();
		const signaling =
			route.kind === LIVE_PROVIDER
				? await this.#signalCodex(offer, route.access)
				: await this.#signalEndpoint(offer, route.endpoint);
		if (peer) {
			await peer.acceptAnswer(signaling.answer);
			peer.setMuted(this.#muted);
			await peer.waitForOpen();
		} else {
			this.#sdpAnswer = signaling.answer;
		}
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		await this.#connectSideband(signaling.sideband);
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		// Only an explicit custom endpoint got the bare SDP; NeoProxy received the Codex session config.
		if (route.kind === "custom") {
			const update = buildLiveSessionUpdate(this.#options.instructions, this.#options.voice);
			this.#sideband?.send(JSON.stringify(update));
		}
		this.#state = "connected";
	}

	#createPeer(): LiveWebRtcPeer {
		return new LiveWebRtcPeer(
			(error, payload) => {
				if (error) {
					this.#reportFailure(error.message);
				} else {
					this.#handleServerEvent(payload);
				}
			},
			(error, level) => {
				if (error) {
					this.#reportFailure(error.message);
				} else {
					this.#handleOutputLevel(level);
				}
			},
			(error, message) => this.#reportFailure(error?.message ?? message),
		);
	}

	async #resolveRoute(): Promise<LiveRoute> {
		const { endpoint, authStorage, modelRegistry, sessionId, signal, canUseProvider } = this.#options;
		if (endpoint) return { kind: "custom", endpoint };
		if (canUseProvider?.(LIVE_PROVIDER) !== false) {
			const access = await authStorage.oauth.access(LIVE_PROVIDER, sessionId, { signal });
			signal?.throwIfAborted();
			if (access && canUseProvider?.(LIVE_PROVIDER) !== false) return { kind: LIVE_PROVIDER, access };
		}
		if (modelRegistry && canUseProvider?.(NEOPROXY_PROVIDER_ID) !== false) {
			const proxy = await resolveNeoProxyLiveEndpoint(
				modelRegistry,
				authStorage,
				signal,
				() => canUseProvider?.(NEOPROXY_PROVIDER_ID) !== false,
			);
			if (proxy) return { kind: NEOPROXY_PROVIDER_ID, endpoint: proxy };
		}
		throw new AIError.MissingApiKeyError(
			canUseProvider?.(LIVE_PROVIDER) === false ? NEOPROXY_PROVIDER_ID : LIVE_PROVIDER,
			canUseProvider?.(LIVE_PROVIDER) === false
				? "No eligible NeoProxy Live key is available. Use /login neoproxy with a key that grants Live access."
				: "No Codex OAuth credential is available for a live call. Sign in to Codex or connect to NeoProxy with a key that grants Live access.",
		);
	}

	#assertProviderAllowed(): void {
		if (this.#provider && this.#options.canUseProvider?.(this.#provider) === false) {
			throw new Error(
				`Live audio cannot use ${this.#provider} outside the active session provider in offline mode.`,
			);
		}
	}

	async #signalCodex(offer: string, seed: OAuthAccess): Promise<LiveSignalingResult> {
		const attestation = await generateCodexAttestation();
		return await withOAuthAccess(
			this.#options.authStorage,
			LIVE_PROVIDER,
			access => this.#signalWithAccess(offer, access, attestation),
			{
				sessionId: this.#options.sessionId,
				signal: this.#options.signal,
				seed,
			},
		);
	}

	async #signalWithAccess(
		offer: string,
		access: OAuthAccess,
		attestation: string | undefined,
	): Promise<LiveSignalingResult> {
		const headers = new Headers({
			...liveSessionHeaders(access, this.#options.sessionId, this.#voiceSessionId, attestation),
			Accept: "*/*",
			"Content-Type": "application/json",
		});
		const fetchImpl = wrapFetchForProxy(fetch, LIVE_PROVIDER);
		this.#options.signal?.throwIfAborted();
		this.#assertProviderAllowed();
		const response = await fetchImpl(SIGNALING_URL, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sdp: offer,
				session: buildLiveSessionPayload(this.#options.instructions, this.#options.voice, this.#options.model),
			}),
			signal: this.#options.signal,
		});
		const responseBody = await response.text();
		if (!response.ok) {
			const detail = boundedErrorBody(responseBody, response.statusText);
			throw new LiveSignalingError(response.status, `Codex live signaling failed (${response.status}): ${detail}`);
		}
		const answer = responseBody;
		if (!answer.trim())
			throw new LiveSignalingError(response.status, "Codex live signaling returned an empty SDP answer");
		const callId = parseLiveCallId(response.headers.get("location"));
		if (!callId) {
			throw new LiveSignalingError(response.status, "Codex live signaling returned no valid call ID");
		}
		const sideband = {
			url: buildLiveSidebandUrl(callId),
			headers: liveSessionHeaders(access, this.#options.sessionId, this.#voiceSessionId, attestation),
			proxyScope: LIVE_PROVIDER,
		};
		return { answer, sideband };
	}

	/** Signal the configured custom endpoint or the scoped NeoProxy relay. */
	async #signalEndpoint(offer: string, endpoint: LiveEndpoint | NeoProxyLiveEndpoint): Promise<LiveSignalingResult> {
		const credentials = liveEndpointHeaders(endpoint);
		const scoped = "fetch" in endpoint ? endpoint : undefined;
		const proxyScope = scoped ? NEOPROXY_PROVIDER_ID : LIVE_ENDPOINT_PROXY;
		const fetcher = scoped?.fetch ?? fetch;
		const body = scoped
			? JSON.stringify({
					sdp: offer,
					session: buildLiveSessionPayload(this.#options.instructions, this.#options.voice, this.#options.model),
				})
			: offer;
		let url = new URL(liveEndpointCallsUrl(endpoint.baseUrl));
		const origin = url.origin;
		for (let redirects = 0; ; redirects++) {
			this.#options.signal?.throwIfAborted();
			this.#assertProviderAllowed();
			const init: BunFetchRequestInit = {
				method: "POST",
				headers: { ...credentials, "Content-Type": scoped ? "application/json" : "application/sdp" },
				body,
				redirect: "manual",
				proxy: getProxyForUrl(proxyScope, url),
				signal: this.#options.signal,
			};
			const response = await fetcher(url, init);
			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel();
				// The scoped fetcher refuses redirects; never retry a scoped key at another URL.
				if (scoped) throw new LiveSignalingError(response.status, "NeoProxy Live signaling was redirected");
				const target = location ? new URL(location, url) : undefined;
				const preservesPost = response.status === 307 || response.status === 308;
				if (!target || !preservesPost || target.origin !== origin || redirects >= MAX_ENDPOINT_REDIRECTS) {
					throw new LiveSignalingError(
						response.status,
						`Live endpoint signaling was redirected (${response.status}) to ${location ?? "nowhere"}; ` +
							"only same-origin 307/308 redirects are followed",
					);
				}
				url = target;
				continue;
			}
			const answer = await response.text();
			if (!response.ok) {
				const detail = boundedErrorBody(answer, response.statusText);
				throw new LiveSignalingError(
					response.status,
					`${this.#label} signaling failed (${response.status}): ${detail}`,
				);
			}
			if (!answer.trim()) {
				throw new LiveSignalingError(response.status, `${this.#label} signaling returned an empty SDP answer`);
			}
			const callId = parseLiveEndpointCallId(location);
			if (!callId) {
				throw new LiveSignalingError(response.status, `${this.#label} signaling returned no call ID in Location`);
			}
			const sideband = {
				url: liveEndpointSidebandUrl(endpoint.baseUrl, callId),
				headers: credentials,
				proxyScope,
				tls: scoped?.tls,
			};
			return { answer, sideband };
		}
	}

	async #connectSideband(sideband: LiveSideband): Promise<void> {
		let failure = new Error(`${this.#label} sideband connection failed`);
		for (let attempt = 0; attempt < SIDEBAND_CONNECT_ATTEMPTS; attempt++) {
			this.#options.signal?.throwIfAborted();
			this.#assertProviderAllowed();
			try {
				await this.#openSideband(sideband);
				return;
			} catch (cause) {
				failure = toError(cause);
				if (this.#options.signal?.aborted) throw abortReason(this.#options.signal);
				if (attempt + 1 < SIDEBAND_CONNECT_ATTEMPTS) await Bun.sleep(200 * 2 ** attempt);
			}
		}
		throw failure;
	}

	async #openSideband(sideband: LiveSideband): Promise<void> {
		const options = {
			headers: sideband.headers,
			proxy: getProxyForUrl(sideband.proxyScope, new URL(sideband.url)),
			...(sideband.tls ? { tls: sideband.tls } : {}),
		} satisfies Bun.WebSocketOptions;
		// Bun's native WebSocket requires a 101 upgrade, and does not follow redirects.
		const socket: Bun.WebSocket = Reflect.construct(WebSocket, [sideband.url, options]);
		socket.binaryType = "nodebuffer";
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let opened = false;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const cleanup = (): void => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			this.#options.signal?.removeEventListener("abort", onAbort);
		};
		const rejectConnect = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = (): void => {
			socket.close(1000, "aborted");
			rejectConnect(abortReason(this.#options.signal));
		};
		socket.onopen = () => {
			if (settled) {
				socket.close(1000, "stale");
				return;
			}
			opened = true;
			settled = true;
			cleanup();
			this.#sideband = socket;
			resolve();
		};
		socket.onmessage = event => {
			if (typeof event.data !== "string") {
				this.#reportFailure(`${this.#label} sideband returned an unexpected binary frame.`);
				return;
			}
			this.#handleSidebandEvent(event.data);
		};
		socket.onerror = event => {
			const detail = event instanceof ErrorEvent && event.message ? `: ${event.message}` : "";
			if (!opened) {
				rejectConnect(new Error(`${this.#label} sideband connection failed${detail}`));
				socket.close(1011, "connection failed");
				return;
			}
			this.#reportFailure(`${this.#label} sideband failed${detail}`);
		};
		socket.onclose = event => {
			if (!opened) {
				rejectConnect(new Error(`${this.#label} sideband closed before connecting (${event.code})`));
				return;
			}
			if (this.#sideband !== socket) return;
			this.#sideband = undefined;
			if (this.#state === "connecting" || this.#state === "connected") {
				const detail = event.reason ? `: ${event.reason}` : "";
				this.#reportFailure(`${this.#label} sideband closed (${event.code})${detail}`);
			}
		};
		if (this.#options.signal?.aborted) {
			onAbort();
		} else {
			this.#options.signal?.addEventListener("abort", onAbort, { once: true });
			timeout = setTimeout(() => {
				socket.close(1000, "connect timeout");
				rejectConnect(new Error(`${this.#label} sideband connection timed out`));
			}, SIDEBAND_CONNECT_TIMEOUT_MS);
			timeout.unref?.();
		}
		await promise;
	}

	#handleSidebandEvent(payload: string): void {
		if (this.#state === "closing" || this.#state === "closed") return;
		const event = parseLiveServerEvent(payload);
		if (!event) return;
		try {
			this.#options.callbacks.onEvent(event);
		} catch {}
	}

	#handleServerEvent(payload: string): void {
		if (this.#state === "closing" || this.#state === "closed") return;
		const event = parseLiveServerEvent(payload);
		if (!event || (this.#sideband?.readyState === WebSocket.OPEN && event.type !== "error")) return;
		try {
			this.#options.callbacks.onEvent(event);
		} catch {}
	}

	#handleOutputLevel(level: number): void {
		if (this.#state !== "connected" || !Number.isFinite(level)) return;
		try {
			this.#options.callbacks.onOutputLevel(Math.min(1, Math.max(0, level)));
		} catch {}
	}

	#reportFailure(message: string): void {
		if ((this.#state !== "connecting" && this.#state !== "connected") || this.#unexpectedFailureReported) {
			return;
		}
		this.#unexpectedFailureReported = true;
		try {
			this.#options.callbacks.onEvent({ type: "error", message });
		} catch {}
	}

	/** Serialize one Frameless Bidi control message onto the call's sideband WebSocket. */
	send(message: LiveClientMessage): Promise<void> {
		const operation = this.#sendTail.then(() => {
			if (this.#state !== "connected") throw new Error("Live transport is not connected");
			const sideband = this.#sideband;
			if (!sideband || sideband.readyState !== WebSocket.OPEN) {
				throw new Error(`${this.#label} sideband is not connected`);
			}
			sideband.send(JSON.stringify(message));
		});
		this.#sendTail = operation.catch(() => {});
		return operation;
	}

	/** Queue 16 kHz mono Float32 PCM; false when the native queue rejects it. */
	pushAudio(samples: Float32Array): boolean {
		if (this.#state !== "connected" || this.#muted || samples.length === 0) return false;
		return this.#peer?.pushAudio(samples) ?? false;
	}

	/** Speaker backlog still queued, and audio dropped to stay near two seconds. */
	playbackQueueStats(): { queuedMs: number; droppedMs: number } {
		// The method is on the native peer. Bindings are generated, so call it
		// structurally until `build:bindings` republishes the declaration.
		const peer = this.#peer as { playbackQueueStats?: () => { queuedMs: number; droppedMs: number } } | undefined;
		const stats = peer?.playbackQueueStats?.();
		if (!stats) return { queuedMs: 0, droppedMs: 0 };
		return { queuedMs: stats.queuedMs, droppedMs: stats.droppedMs };
	}

	/** Enable or disable the native audio source and discard partial input when muted. */
	async setMuted(muted: boolean): Promise<void> {
		this.#muted = muted;
		if (this.#state === "connected") this.#peer?.setMuted(muted);
	}

	/** Gate native RTP playback, independently of transcript/data-channel events. */
	setOutputSuppressed(suppressed: boolean): void {
		this.#outputSuppressed = suppressed;
		(
			this.#peer as (LiveWebRtcPeer & { setOutputSuppressed(suppressed: boolean): void }) | undefined
		)?.setOutputSuppressed(suppressed);
	}

	/** Stop sideband signaling and the native WebRTC media peer. Safe to call repeatedly. */
	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#state = "closing";
		const operation = this.#close();
		this.#closePromise = operation;
		return operation;
	}

	async #close(): Promise<void> {
		this.#options.signal?.removeEventListener("abort", this.#abortListener);
		const sideband = this.#sideband;
		const peer = this.#peer;
		this.#sideband = undefined;
		this.#peer = undefined;
		if (sideband && (sideband.readyState === WebSocket.OPEN || sideband.readyState === WebSocket.CONNECTING)) {
			sideband.close(1000, "done");
		}
		if (peer) {
			try {
				await peer.close();
			} catch {}
		}
		this.#state = "closed";
	}
}
