/**
 * `NODE_EXTRA_CA_CERTS` shim for Bun's `fetch`.
 *
 * Node's TLS layer honours `NODE_EXTRA_CA_CERTS` natively, but Bun's
 * `fetch` does not, and both the provider streams (`openai-responses`,
 * `openai-completions`, `openai-codex-responses`, `ollama-chat`, ...) and
 * catalog model discovery (`/models` probes) route every request through
 * Bun's runtime. Without this wrapper, corporate relays and private
 * gateways behind a custom CA bundle fail with
 * `unknown certificate verification error` even when the env var is set.
 *
 * The wrapper merges the resolved CA bundle into Bun's `RequestInit.tls.ca`.
 * Bun's `tls.ca` REPLACES the default trust store when set, so the wrapper
 * always seeds {@link tls.rootCertificates} when the caller has not already
 * curated their own CA list.
 */
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import * as fs from "node:fs";
import * as tls from "node:tls";
import { $env } from "./env";
import { isEnoent } from "./fs-error";

/**
 * `fetch`-compatible function. Accepts any callable matching the standard
 * fetch signature; `preconnect` is optional because non-Bun runtimes
 * (browsers, test mocks) won't expose it.
 */
export type FetchImpl = ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) & {
	preconnect?: typeof globalThis.fetch.preconnect;
};

/**
 * `NODE_EXTRA_CA_CERTS` was set but unusable (path does not exist). This is
 * a config/contract error, not a transient transport fault — it is never
 * retried.
 */
export class ExtraCaError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ExtraCaError";
	}
}

/** A credential's confirmed transport policy failed; retrying cannot authorize the request. */
export class CredentialScopeError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "CredentialScopeError";
	}
}

const TLS_CODE_PATTERN =
	/^(?:CERT_|SELF_SIGNED|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT)/i;
export const TLS_CERTIFICATE_TEXT_PATTERN =
	/unable to verify|certificate verif(?:y|ication)|self[- ]signed certificate|\bCERT_[A-Z_]+\b|\bSELF_SIGNED[A-Z_]*\b|\bUNABLE_TO_GET_ISSUER_CERT[A-Z_]*\b|\bUNABLE_TO_VERIFY_LEAF_SIGNATURE\b/i;

/** Certificate validation is distinct from a transient TLS socket or record failure. */
export function isTlsCertificateError(code: string | undefined, message: string | undefined): boolean {
	return (
		(code !== undefined && TLS_CODE_PATTERN.test(code)) ||
		(message !== undefined && TLS_CERTIFICATE_TEXT_PATTERN.test(message))
	);
}

function hasCertificateFailure(error: unknown): boolean {
	for (let depth = 0; depth < 8 && typeof error === "object" && error !== null; depth++) {
		const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
		const message = "message" in error && typeof error.message === "string" ? error.message : undefined;
		if (isTlsCertificateError(code, message)) return true;
		error = "cause" in error ? error.cause : undefined;
	}
	return false;
}

async function fetchWithCredentialPolicy(
	fetchImpl: FetchImpl,
	input: string | URL | Request,
	init: RequestInit,
): Promise<Response> {
	try {
		const response = await fetchImpl(input, init);
		const status = response.status;
		if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
			response.body?.cancel().catch(() => {});
			throw new CredentialScopeError(
				"Credential request origin does not permit redirects; no redirect was followed.",
			);
		}
		return response;
	} catch (error) {
		if (hasProviderTlsTrust(init) && hasCertificateFailure(error)) {
			throw new CredentialScopeError(
				"TLS certificate verification failed for the credential's trusted origin. Reconnect to review the server certificate.",
				{ cause: error },
			);
		}
		throw error;
	}
}

/** Bun extension to `RequestInit` for the TLS options we touch. */
type BunTlsOptions = {
	ca?: string | string[];
	cert?: string;
	key?: string;
	rejectUnauthorized?: boolean;
	serverName?: string;
	ciphers?: string;
};

type BunTlsRequestInit = RequestInit & { tls?: BunTlsOptions };

/** Explicit human-confirmed trust, stored only with the credential that needs it. */
export interface ProviderTlsTrust {
	origin: string;
	caPem: string;
	caFingerprint256: string;
}

const SCOPED_TLS_INIT = Symbol("omp.providerTlsTrust");
type ScopedTlsRequestInit = BunTlsRequestInit & { [SCOPED_TLS_INIT]?: true };

/** Explicit credential trust excludes ambient CA configuration, even an invalid ambient file. */
export function hasProviderTlsTrust(init: RequestInit | undefined): boolean {
	return (init as ScopedTlsRequestInit | undefined)?.[SCOPED_TLS_INIT] === true;
}

/** Reject corrupt or broadened stored trust rather than falling back to ambient roots. */
function validateProviderTlsTrust(trust: ProviderTlsTrust, target?: string | URL): X509Certificate {
	if (trust === null || typeof trust !== "object")
		throw new CredentialScopeError("Stored provider TLS trust is invalid; reconnect to confirm trust.");
	const origin = new URL(trust.origin);
	if (origin.protocol !== "https:" || origin.origin !== trust.origin) {
		throw new CredentialScopeError("Provider TLS trust must name an exact HTTPS origin.");
	}
	if (target !== undefined && new URL(target).origin !== trust.origin) {
		throw new CredentialScopeError("Provider TLS trust origin does not match the request; no credentials were sent.");
	}
	const ca = new X509Certificate(trust.caPem);
	if (!ca.ca || ca.fingerprint256 !== trust.caFingerprint256 || !ca.checkIssued(ca) || !ca.verify(ca.publicKey)) {
		throw new CredentialScopeError(
			"Provider TLS CA fingerprint or certificate is invalid; reconnect to confirm trust.",
		);
	}
	const now = Date.now();
	if (now < Date.parse(ca.validFrom) || now > Date.parse(ca.validTo)) {
		throw new CredentialScopeError(
			"Provider TLS CA is not currently valid; reconnect after the administrator renews it.",
		);
	}
	return ca;
}

/** Enforce exact-origin, CA-only verified TLS and refuse every redirect on credential-bearing requests. */
export function wrapFetchForProviderTls(fetchImpl: FetchImpl, trust: ProviderTlsTrust): FetchImpl {
	const ca = validateProviderTlsTrust(trust);
	const { origin, caPem } = trust;
	const validFrom = Date.parse(ca.validFrom);
	const validTo = Date.parse(ca.validTo);
	const wrapped: FetchImpl = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (new URL(url).origin !== origin)
			throw new CredentialScopeError(
				"Provider TLS trust origin does not match the request; no credentials were sent.",
			);
		const now = Date.now();
		if (now < validFrom || now > validTo)
			throw new CredentialScopeError(
				"Provider TLS CA is not currently valid; reconnect after the administrator renews it.",
			);
		const scoped: ScopedTlsRequestInit = {
			...init,
			redirect: "manual",
			credentials: "omit",
			tls: { ca: caPem, rejectUnauthorized: true },
			[SCOPED_TLS_INIT]: true,
		};
		return fetchWithCredentialPolicy(fetchImpl, input, scoped);
	};
	// Retain transport composition markers so request retries do not build another outer layer.
	return Object.assign(wrapped, fetchImpl);
}

/** Credential-origin binding also protects cleartext loopback during endpoint activation. */
export interface CredentialRequestScope {
	requestOrigin?: string;
	tlsTrust?: ProviderTlsTrust;
}

export function wrapFetchForCredentialScope(fetchImpl: FetchImpl, scope?: CredentialRequestScope): FetchImpl {
	if (scope?.tlsTrust !== undefined) {
		if (scope.requestOrigin !== undefined && scope.requestOrigin !== scope.tlsTrust.origin) {
			throw new CredentialScopeError(
				"Credential origin and TLS trust origin do not match; no credentials were sent.",
			);
		}
		return wrapFetchForProviderTls(fetchImpl, scope.tlsTrust);
	}
	const origin = scope?.requestOrigin;
	if (origin === undefined) return fetchImpl;
	if (new URL(origin).origin !== origin)
		throw new CredentialScopeError("Stored credential request origin is invalid.");
	const wrapped: FetchImpl = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (new URL(url).origin !== origin)
			throw new CredentialScopeError(
				"Credential request origin does not match the request; no credentials were sent.",
			);
		return fetchWithCredentialPolicy(fetchImpl, input, { ...init, redirect: "manual", credentials: "omit" });
	};
	return Object.assign(wrapped, fetchImpl);
}

export interface ProviderCertificateInspection {
	hostname: string;
	serverFingerprint256: string;
	caFingerprint256: string;
	/** The confirmed CA is always persisted, even if ambient roots already verified inspection. */
	trust: ProviderTlsTrust;
}

/**
 * TLS handshake only: this socket never sends HTTP, credentials, or application data.
 * An untrusted private server must supply its complete chain, including its root CA.
 */
export async function inspectProviderCertificate(
	target: string,
	signal?: AbortSignal,
): Promise<ProviderCertificateInspection> {
	signal?.throwIfAborted();
	const url = new URL(target);
	if (url.protocol !== "https:") throw new Error("Certificate inspection requires HTTPS.");
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const pending = Promise.withResolvers<ProviderCertificateInspection>();
	const socket = tls.connect({
		host: hostname,
		port: Number(url.port || 443),
		servername: isIP(hostname) ? undefined : hostname,
		rejectUnauthorized: false,
	});
	const abort = () => socket.destroy(signal?.reason instanceof Error ? signal.reason : new Error("Login cancelled"));
	signal?.addEventListener("abort", abort, { once: true });
	socket.once("error", pending.reject);
	socket.once("close", () =>
		pending.reject(new Error("TLS certificate inspection closed before completing the handshake.")),
	);
	socket.once("secureConnect", () => {
		try {
			signal?.throwIfAborted();
			const peer = socket.getPeerCertificate(true);
			const hostnameError = tls.checkServerIdentity(hostname, peer);
			if (hostnameError) throw hostnameError;
			const leaf = new X509Certificate(peer.raw);
			const chain: X509Certificate[] = [leaf];
			let current = peer;
			while (current.issuerCertificate) {
				const issuer = current.issuerCertificate;
				if (chain.some(cert => cert.fingerprint256 === issuer.fingerprint256)) break;
				current = issuer;
				chain.push(new X509Certificate(issuer.raw));
			}
			// Verified public/ambient chains may omit their root on the wire. Resolve only
			// the actual issuer of this verified chain, before asking the human to pin it.
			const last = chain.at(-1)!;
			if (socket.authorized && (!last.ca || !last.checkIssued(last) || !last.verify(last.publicKey))) {
				let available: readonly string[] = tls.rootCertificates;
				if (typeof tls.getCACertificates === "function") {
					try {
						available = tls.getCACertificates();
					} catch {
						// Some runtimes expose the Node accessor before implementing it.
					}
				}
				const findRoot = (certificates: readonly string[]): X509Certificate | undefined => {
					for (const pem of certificates) {
						const candidate = new X509Certificate(pem);
						if (
							candidate.ca &&
							last.checkIssued(candidate) &&
							last.verify(candidate.publicKey) &&
							candidate.checkIssued(candidate) &&
							candidate.verify(candidate.publicKey)
						)
							return candidate;
					}
					return undefined;
				};
				const root =
					findRoot(available) ??
					findRoot(resolveExtraCa()?.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []);
				if (root) chain.push(root);
			}
			const now = Date.now();
			for (let i = 0; i < chain.length; i++) {
				const cert = chain[i];
				if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) {
					throw new Error("The server certificate chain is not currently valid.");
				}
				const issuer = chain[i + 1];
				if (issuer && (!issuer.ca || !cert.checkIssued(issuer) || !cert.verify(issuer.publicKey))) {
					throw new Error("The server supplied an invalid CA chain.");
				}
			}
			const ca = chain.at(-1);
			if (chain.length < 2 || !ca?.ca || !ca.checkIssued(ca) || !ca.verify(ca.publicKey)) {
				throw new Error(
					"The server did not supply a usable CA chain. Ask the administrator to serve the complete certificate chain, including the private root CA; a server leaf certificate is not a CA.",
				);
			}
			const trust = {
				origin: url.origin,
				caPem: ca.toString(),
				caFingerprint256: ca.fingerprint256,
			};
			validateProviderTlsTrust(trust, target);
			pending.resolve({
				hostname,
				serverFingerprint256: leaf.fingerprint256,
				caFingerprint256: ca.fingerprint256,
				trust,
			});
		} catch (error) {
			pending.reject(error);
		} finally {
			socket.destroy();
		}
	});
	try {
		return await pending.promise;
	} finally {
		signal?.removeEventListener("abort", abort);
		socket.destroy();
	}
}
const EXTRA_CA_FETCH_MARKER = Symbol("omp.extraCaFetch");
type ExtraCaFetch = FetchImpl & { [EXTRA_CA_FETCH_MARKER]?: true };

/**
 * Cached resolution of `NODE_EXTRA_CA_CERTS`. Keyed on the env value plus
 * the file mtime for path values so on-disk cert rotation (short-lived
 * corporate bundles) invalidates the cache instead of pinning the first
 * read forever.
 */
let cacheKey: string | undefined;
let cacheValue: string | undefined;

/**
 * Returns the PEM bytes referenced by `NODE_EXTRA_CA_CERTS`, or `undefined`
 * when the env var is unset/empty.
 *
 * Accepts the same shapes Node accepts plus an inline-PEM escape hatch:
 * - Inline PEM (`-----BEGIN CERTIFICATE-----...`). Literal `\n` escapes in
 *   the env value are expanded so callers can ship single-line PEMs through
 *   shell exports.
 * - File path. Anything that does not contain a PEM header is treated as a
 *   path, matching Node's "extensionless filename is still a path" contract.
 *   `ENOENT` becomes {@link ExtraCaError}; other I/O errors bubble.
 */
export function resolveExtraCa(): string | undefined {
	const raw = $env.NODE_EXTRA_CA_CERTS?.trim();
	if (!raw) return undefined;

	let key: string;
	if (raw.includes("-----BEGIN")) {
		key = raw;
	} else {
		try {
			key = `${raw}@${fs.statSync(raw).mtimeMs}`;
		} catch {
			key = raw;
		}
	}
	if (key === cacheKey) return cacheValue;

	if (raw.includes("-----BEGIN")) {
		cacheValue = raw.replace(/\\n/g, "\n");
	} else {
		try {
			cacheValue = fs.readFileSync(raw, "utf8");
		} catch (error) {
			if (isEnoent(error)) {
				throw new ExtraCaError(`NODE_EXTRA_CA_CERTS path does not exist: ${raw}`);
			}
			throw error;
		}
	}
	cacheKey = key;
	return cacheValue;
}

/** Test seam: drop the cached PEM so a follow-up call re-reads the env. */
export function __resetExtraCaCache(): void {
	cacheKey = undefined;
	cacheValue = undefined;
}

/**
 * Merge `extraCa` into `init.tls.ca`. When the caller has not supplied a CA
 * list, the system root store is included alongside the extra bundle —
 * Bun's `tls.ca` replaces the default trust store, so omitting roots would
 * break every public host. When the caller already curated a list (e.g.
 * Anthropic Foundry's mTLS options, which already seed
 * `tls.rootCertificates`), only the extra CA is appended.
 */
export function withExtraCaInit(init: RequestInit | undefined, extraCa: string): RequestInit {
	if ((init as ScopedTlsRequestInit | undefined)?.[SCOPED_TLS_INIT]) return init!;
	const existingTls = (init as BunTlsRequestInit | undefined)?.tls;
	const existingCa = existingTls?.ca;
	let mergedCa: string[];
	if (existingCa === undefined) {
		mergedCa = [...tls.rootCertificates, extraCa];
	} else if (Array.isArray(existingCa)) {
		mergedCa = [...existingCa, extraCa];
	} else {
		mergedCa = [existingCa, extraCa];
	}
	return { ...init, tls: { ...existingTls, ca: mergedCa } } as RequestInit;
}

/**
 * Wrap `fetchImpl` so every call honours `NODE_EXTRA_CA_CERTS`. Idempotent:
 * a fetch already wrapped is returned unchanged so repeated composition
 * (Anthropic auth-retry replays, request-debug fan-out) never stacks
 * wrappers. When the env var is unset the original fetch is returned, so
 * default deployments pay nothing.
 */
export function wrapFetchForExtraCa(fetchImpl: FetchImpl): FetchImpl {
	const maybeWrapped = fetchImpl as ExtraCaFetch;
	if (maybeWrapped[EXTRA_CA_FETCH_MARKER]) return fetchImpl;
	// Peek once at construction — if the env var is unset, skip the wrapper
	// entirely so the hot fetch path stays a single function call. The env
	// is evaluated again per request below to catch in-process updates from
	// tests (`__resetExtraCaCache` + env mutation).
	if (!$env.NODE_EXTRA_CA_CERTS?.trim()) return fetchImpl;

	const wrapped = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			if (hasProviderTlsTrust(init)) return fetchImpl(input, init);
			const extraCa = resolveExtraCa();
			return extraCa ? fetchImpl(input, withExtraCaInit(init, extraCa)) : fetchImpl(input, init);
		},
		fetchImpl.preconnect ? { preconnect: fetchImpl.preconnect } : {},
		{ [EXTRA_CA_FETCH_MARKER]: true as const },
	);
	return wrapped;
}
