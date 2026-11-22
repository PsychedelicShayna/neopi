import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { getProxyForUrl } from "@oh-my-pi/pi-ai/utils/proxy";
import { type FetchImpl, isRecord, wrapFetchForCredentialScope } from "@oh-my-pi/pi-utils";
import { NEOPROXY_PROVIDER_ID } from "../config/model-discovery";
import type { ModelRegistry } from "../config/model-registry";
import { ModelsConfigFile } from "../config/models-config";

const PROBE_TIMEOUT_MS = 5_000;

/** One approved endpoint and key for the lifetime of a call. */
export interface NeoProxyLiveEndpoint {
	baseUrl: string;
	apiKey: string;
	fetch: FetchImpl;
	tls?: Bun.TLSOptions;
}

/** Resolve only stored, origin-bound credentials; model discovery cannot establish a Live grant. */
export async function resolveNeoProxyLiveEndpoint(
	registry: Pick<ModelRegistry, "getConfigFile">,
	auth: AuthStorage,
	signal: AbortSignal | undefined,
	canUse: () => boolean,
): Promise<NeoProxyLiveEndpoint | undefined> {
	signal?.throwIfAborted();
	const keys = auth.credentials.list(NEOPROXY_PROVIDER_ID);
	if (keys.length === 0) return undefined;
	const loaded = ModelsConfigFile.relocate(registry.getConfigFile()).tryLoad(true);
	const baseUrl = loaded.status === "error" ? undefined : loaded.value?.providers?.[NEOPROXY_PROVIDER_ID]?.baseUrl;
	if (!baseUrl) return undefined;
	const target = URL.parse(baseUrl);
	if (!target || target.username || target.password || target.search || target.hash) return undefined;
	const secure = target.protocol === "https:";
	const loopback = target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
	if (!secure && !loopback) return undefined;
	target.pathname = `${target.pathname.replace(/\/+$/, "")}/live`;
	const proxy = getProxyForUrl(NEOPROXY_PROVIDER_ID, target);
	for (const { credential: key } of keys) {
		signal?.throwIfAborted();
		if (!canUse()) return undefined;
		if (key.type !== "api_key" || !key.key || (key.requestOrigin ?? key.tlsTrust?.origin) !== target.origin) continue;
		if (secure && !key.tlsTrust) continue; // HTTPS login always binds a confirmed CA.
		try {
			const fetcher = wrapFetchForCredentialScope(fetch, key);
			const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
			const init: BunFetchRequestInit = {
				method: "GET",
				headers: { Authorization: `Bearer ${key.key}`, Accept: "application/json" },
				proxy,
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			};
			const response = await fetcher(target, init);
			if (response.status !== 200) {
				await response.body?.cancel();
				continue;
			}
			const body: unknown = await response.json();
			signal?.throwIfAborted();
			if (isRecord(body) && body.available === true) {
				return {
					baseUrl,
					apiKey: key.key,
					fetch: fetcher,
					tls: key.tlsTrust ? { ca: key.tlsTrust.caPem, rejectUnauthorized: true } : undefined,
				};
			}
		} catch {
			// One rejected, unreachable, or misconfigured key must not hide a sibling's grant.
			signal?.throwIfAborted();
		}
	}
	signal?.throwIfAborted();
	return undefined;
}
