import { type ApiKeyCredential, apiKeyAccountKey } from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import type { ApiKeyLoginResult, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import {
	inspectProviderCertificate,
	isRecord,
	type ProviderTlsTrust,
	wrapFetchForProviderTls,
} from "@oh-my-pi/pi-utils";
import { NEOPROXY_PROVIDER_ID } from "../config/model-discovery";
import type { ModelRegistry } from "../config/model-registry";
import { ModelsConfigFile } from "../config/models-config";

/** Validate an assigned inference key; ordinary login storage owns credential persistence. */
export function registerNeoProxyLogin(registry: ModelRegistry, url?: string): void {
	registerOAuthProvider({
		id: NEOPROXY_PROVIDER_ID,
		name: "NeoProxy",
		loginKind: "custom",
		login: callbacks => connect(registry, callbacks, url),
	});
}

/**
 * Run one NeoProxy login with `url` supplied instead of prompted (`/login
 * neoproxy <url>`), then restore the prompting provider for later logins.
 */
export async function withNeoProxyLoginUrl<T>(
	registry: ModelRegistry,
	url: string,
	login: () => Promise<T>,
): Promise<T> {
	registerNeoProxyLogin(registry, url);
	try {
		return await login();
	} finally {
		registerNeoProxyLogin(registry);
	}
}

function serverUrl(value: string): string {
	const url = new URL(value.trim());
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("NeoProxy URL must not contain credentials, a query, or a fragment.");
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error("NeoProxy requires HTTPS; HTTP is allowed only on loopback.");
	}
	url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
	return url.href.replace(/\/+$/, "");
}

async function connect(
	registry: ModelRegistry,
	callbacks: OAuthLoginCallbacks,
	suppliedUrl?: string,
): Promise<ApiKeyLoginResult> {
	callbacks.signal?.throwIfAborted();
	const file = ModelsConfigFile.relocate(registry.getConfigFile());
	const loaded = file.tryLoad(true);
	if (loaded.status === "error") throw loaded.error;
	const previous = loaded.value ?? null;
	const configured = previous?.providers?.neoproxy?.baseUrl;
	const enteredUrl =
		suppliedUrl ??
		(await callbacks.onPrompt({
			message: "NeoProxy server URL (HTTPS, or loopback HTTP)",
			placeholder: configured ?? "https://neoproxy.example.com",
			allowEmpty: !!configured,
		}));
	const root = serverUrl(enteredUrl || configured || "");
	callbacks.signal?.throwIfAborted();
	let tlsTrust: ProviderTlsTrust | undefined;
	if (new URL(root).protocol === "https:") {
		const certificate = await inspectProviderCertificate(root, callbacks.signal);
		const confirmation = {
			title: `Trust NeoProxy certificate for ${new URL(root).origin}?`,
			message: `Hostname: ${certificate.hostname}\nOrigin: ${new URL(root).origin}\nServer certificate SHA-256: ${certificate.serverFingerprint256}\nCA SHA-256: ${certificate.caFingerprint256}\nCompare both fingerprints with your administrator through a trusted channel before accepting. Trust is stored only beside this provider's credential, never in the global certificate store.`,
		};
		const confirmed = callbacks.onConfirm
			? await callbacks.onConfirm(confirmation)
			: (
					await callbacks.onPrompt({
						message: `${confirmation.title}\n${confirmation.message}\nType yes to confirm.`,
					})
				)
					.trim()
					.toLowerCase() === "yes";
		callbacks.signal?.throwIfAborted();
		if (confirmed !== true)
			throw new DOMException(
				"NeoProxy certificate trust was declined; no API key was requested or sent.",
				"AbortError",
			);
		tlsTrust = certificate.trust;
	}
	const key = (await callbacks.onPrompt({ message: "NeoProxy administrator-assigned API key", secret: true })).trim();
	if (!key) throw new Error("An existing administrator-assigned NeoProxy API key is required.");
	const baseFetch = callbacks.fetch ?? fetch;
	const fetcher = tlsTrust === undefined ? baseFetch : wrapFetchForProviderTls(baseFetch, tlsTrust);
	callbacks.onProgress?.("Validating your NeoProxy API key and discovering granted models.");
	callbacks.signal?.throwIfAborted();
	const response = await fetcher(`${root}/v1/models`, {
		method: "GET",
		headers: { Authorization: `Bearer ${key}` },
		signal: callbacks.signal,
		redirect: "error",
		credentials: "omit",
	});
	if (!response.ok) {
		const reason =
			response.status === 401
				? "invalid or revoked API key; ask your NeoProxy administrator for an assigned key"
				: response.status === 403
					? "access denied; ask your NeoProxy administrator for access"
					: "model discovery failed";
		throw new Error(`NeoProxy GET /v1/models: HTTP ${response.status} (${reason}).`);
	}
	let models: unknown;
	try {
		models = await response.json();
	} catch {
		callbacks.signal?.throwIfAborted();
		throw new Error("Invalid NeoProxy model catalogue.");
	}
	if (
		!isRecord(models) ||
		!Array.isArray(models.data) ||
		models.data.some(model => !isRecord(model) || typeof model.id !== "string" || !model.id.trim())
	) {
		throw new Error("Invalid NeoProxy model catalogue.");
	}
	callbacks.signal?.throwIfAborted();
	const config = structuredClone(previous ?? {});
	const providers = (config.providers ??= {});
	// Persist only endpoint/discovery settings; AuthStorage saves the returned key.
	providers.neoproxy = {
		...providers.neoproxy,
		baseUrl: `${root}/v1`,
		auth: "apiKey",
		discovery: { type: "proxy" },
	};
	delete providers.neoproxy.apiKey;
	callbacks.onProgress?.(
		`${models.data.length} granted model(s). After connecting, use /model or /roles to select a model or assign a role.`,
	);
	if (models.data.length === 0)
		callbacks.onProgress?.(
			"No models are granted yet; ask your NeoProxy administrator to assign models to this key.",
		);
	callbacks.signal?.throwIfAborted();
	const origin = new URL(root).origin;
	const replaceExisting = await chooseKeyReplacement(registry, callbacks, origin, key);
	callbacks.signal?.throwIfAborted();
	return {
		type: "api_key",
		key,
		...(replaceExisting ? { replaceExisting: true as const } : {}),
		requestOrigin: origin,
		...(tlsTrust !== undefined ? { tlsTrust } : {}),
		onPersisted: async () => {
			try {
				await file.save(config, previous);
			} catch {
				throw new Error(
					"The validated NeoProxy credential was stored for the requested origin, but saving endpoint configuration did not complete. The new key remains origin-bound and cannot be sent to a different previous origin. Check the endpoint settings and reconnect after fixing the configuration write.",
				);
			}
		},
	};
}

/**
 * Keys aggregate: each stored key contributes the models its administrator
 * granted, so a new key for the same server is added beside the others unless
 * the user explicitly replaces them. NeoProxy has one server URL and every key
 * is bound to its server's origin, so keys for another origin can never serve
 * the new URL and are replaced. Re-entering a stored key only refreshes it.
 */
async function chooseKeyReplacement(
	registry: ModelRegistry,
	callbacks: OAuthLoginCallbacks,
	origin: string,
	key: string,
): Promise<boolean> {
	const keys = storedNeoProxyKeys(registry);
	const others = keys.filter(credential => credential.key !== key);
	if (keys.some(credential => (credential.requestOrigin ?? credential.tlsTrust?.origin) !== origin)) {
		callbacks.onProgress?.(
			`Switching NeoProxy to ${origin}: ${others.length} stored key(s) for the previous server will be replaced; keys only work with the server that issued them.`,
		);
		return true;
	}
	if (others.length === 0) return false;
	const answer = await callbacks.onPrompt({
		message: `${others.length} other NeoProxy key(s) are stored for ${origin}. Press Enter to add this key beside them (models granted to every key are combined), or type replace to remove them.`,
		placeholder: "add",
		allowEmpty: true,
	});
	const choice = answer.trim().toLowerCase();
	if (choice === "replace") return true;
	if (choice !== "" && choice !== "add") throw new Error('Answer "add" (or press Enter) or "replace".');
	return false;
}

function storedNeoProxyKeys(registry: ModelRegistry): ApiKeyCredential[] {
	const stored = registry.authStorage.credentials.all().neoproxy;
	return (Array.isArray(stored) ? stored : stored ? [stored] : []).filter(
		(credential): credential is ApiKeyCredential => credential.type === "api_key",
	);
}

/**
 * `/neoproxy` status: the configured server URL, each stored key's non-secret
 * id with the number of models it grants, and the discovery/cache state.
 */
export function describeNeoProxy(registry: ModelRegistry): string {
	const loaded = ModelsConfigFile.relocate(registry.getConfigFile()).tryLoad(true);
	const baseUrl = loaded.status === "error" ? undefined : loaded.value?.providers?.neoproxy?.baseUrl;
	const keys = storedNeoProxyKeys(registry);
	if (!baseUrl && keys.length === 0) {
		return "NeoProxy is not connected. Run /login neoproxy <url> (or `npi login neoproxy --url <url>`) with an administrator-assigned API key.";
	}
	const models = registry.getProviderModels(NEOPROXY_PROVIDER_ID);
	const lines = [`NeoProxy server: ${baseUrl ? baseUrl.replace(/\/v1\/?$/, "") : "(not configured)"}`];
	lines.push(`Stored keys: ${keys.length}`);
	for (const credential of keys) {
		const id = apiKeyAccountKey(credential);
		const granted = models.filter(model => model.accountAccess && Object.hasOwn(model.accountAccess, id)).length;
		lines.push(`  ${id} (${credential.requestOrigin ?? "any origin"}): ${granted} model(s)`);
	}
	const state = registry.getProviderDiscoveryState(NEOPROXY_PROVIDER_ID);
	const status = state ? `${state.status}${state.stale ? ", from cache" : ""}` : "not discovered yet";
	lines.push(`Models: ${models.length} (${status})${state?.error ? `; last error: ${state.error}` : ""}`);
	lines.push("Add a key: /login neoproxy · Change server: /neoproxy url <url> · Remove a key: /logout neoproxy");
	return lines.join("\n");
}
