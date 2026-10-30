import { registerOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import { isRecord, wrapFetchForExtraCa } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { ModelsConfigFile } from "../config/models-config";

/** Dashboard credentials are exchanged once; only the resulting inference key is stored. */
export function registerNeoProxyLogin(registry: ModelRegistry, url?: string): void {
	registerOAuthProvider({
		id: "neoproxy",
		name: "NeoProxy",
		loginKind: "custom",
		login: callbacks => connect(registry, callbacks, url),
	});
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
	url.pathname = url.pathname.replace(/\/(?:v1|neo)\/?$/, "").replace(/\/+$/, "");
	return url.href.replace(/\/+$/, "");
}

async function connect(registry: ModelRegistry, callbacks: OAuthLoginCallbacks, suppliedUrl?: string): Promise<string> {
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
	const handle = (await callbacks.onPrompt({ message: "NeoProxy username" })).trim();
	const password = await callbacks.onPrompt({ message: "NeoProxy password", secret: true });
	if (!handle || !password) throw new Error("NeoProxy username and password are required.");
	const fetcher = callbacks.fetch ?? wrapFetchForExtraCa(fetch);
	let cookie: string | undefined;
	let mintedId: string | undefined;
	let mintedUser: string | undefined;
	let accepted = false;
	const request = async (method: string, route: string, body?: unknown, key?: string): Promise<Response> => {
		callbacks.signal?.throwIfAborted();
		const headers: Record<string, string> = { "X-Neoproxy-CSRF": "1" };
		if (cookie && !key) headers.Cookie = cookie;
		if (key) headers.Authorization = `Bearer ${key}`;
		if (body !== undefined) headers["Content-Type"] = "application/json";
		const response = await fetcher(`${root}${route}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: callbacks.signal,
			redirect: "error",
			credentials: "omit",
		});
		if (!response.ok) {
			const reason =
				response.status === 401
					? "invalid credentials or expired session"
					: response.status === 403
						? "access denied"
						: response.statusText;
			throw new Error(`NeoProxy ${method} ${route}: HTTP ${response.status} (${reason}).`);
		}
		return response;
	};
	try {
		callbacks.onProgress?.("Signing in to NeoProxy; your password and dashboard session will not be stored.");
		const login = await request("POST", "/v8/session", { handle, password });
		cookie = login.headers
			.getSetCookie()
			.map(value => value.match(/^neoproxy_session=[^;]+/)?.[0])
			.find(Boolean);
		if (!cookie) throw new Error("NeoProxy did not issue a dashboard session cookie.");
		const session: unknown = await login.json();
		if (!isRecord(session) || typeof session.userId !== "string")
			throw new Error("Invalid NeoProxy session response.");
		const userId = session.userId;
		let accountIds: string[] | undefined;
		if (session.role === "owner") {
			const response: unknown = await (await request("GET", "/v8/neo/vault")).json();
			if (!isRecord(response) || !Array.isArray(response.accounts))
				throw new Error("Invalid NeoProxy account inventory.");
			const accounts = response.accounts.filter(
				(account): account is Record<string, unknown> =>
					isRecord(account) && typeof account.id === "string" && account.ownerId === userId,
			);
			if (!accounts.length)
				throw new Error("No owned accounts. Ask your administrator to assign a pool before connecting.");
			const selection = await callbacks.onPrompt({
				message: `Select owned accounts for this key, by number separated with commas:\n${accounts.map((account, index) => `${index + 1}. ${account.providerId}: ${account.label}`).join("\n")}`,
			});
			const indices = selection.split(",").map(value => Number(value.trim()) - 1);
			if (
				!selection.trim() ||
				indices.some(index => !Number.isInteger(index) || index < 0 || index >= accounts.length)
			) {
				throw new Error("Select at least one listed owned account; unrestricted owner keys are not allowed.");
			}
			accountIds = [...new Set(indices.map(index => String(accounts[index].id)))];
		}
		const result: unknown = await (
			await request("POST", `/v8/neo/users/${encodeURIComponent(userId)}/keys`, {
				label: "NeoPi",
				...(accountIds ? { accountIds } : {}),
			})
		).json();
		if (
			!isRecord(result) ||
			typeof result.secret !== "string" ||
			!isRecord(result.key) ||
			typeof result.key.id !== "string"
		) {
			throw new Error("Invalid NeoProxy inference-key response.");
		}
		mintedId = result.key.id;
		mintedUser = userId;
		const models: unknown = await (await request("GET", "/v1/models", undefined, result.secret)).json();
		if (!isRecord(models) || !Array.isArray(models.data)) throw new Error("Invalid NeoProxy model catalogue.");
		const config = structuredClone(previous ?? {});
		const providers = (config.providers ??= {});
		// Use the ordinary persisted provider/discovery seam, not a second model catalogue.
		// No key, password, or cookie belongs in this file.
		providers.neoproxy = {
			...providers.neoproxy,
			baseUrl: `${root}/v1`,
			auth: "apiKey",
			discovery: { type: "proxy" },
		};
		delete providers.neoproxy.apiKey;
		await file.save(config, previous);
		accepted = true;
		callbacks.onProgress?.(
			`NeoProxy connected: ${models.data.length} granted model(s). Use /model or /models to select a model or assign a role.`,
		);
		if (models.data.length === 0)
			callbacks.onProgress?.("No models are granted yet; ask your NeoProxy administrator for access.");
		return result.secret;
	} finally {
		// Cleanup must still run after cancellation; no dashboard cookie survives this flow.
		const cleanup = async (method: string, route: string): Promise<void> => {
			try {
				const response = await fetcher(`${root}${route}`, {
					method,
					headers: { Cookie: cookie!, "X-Neoproxy-CSRF": "1" },
					redirect: "error",
					credentials: "omit",
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
			} catch {
				callbacks.onProgress?.(
					`NeoProxy could not finish ${route.endsWith("/session") ? "temporary dashboard logout" : "unused key revocation"}; review active sessions/keys in the dashboard.`,
				);
			}
		};
		if (cookie) {
			if (!accepted && mintedId && mintedUser)
				await cleanup(
					"DELETE",
					`/v8/neo/users/${encodeURIComponent(mintedUser)}/keys/${encodeURIComponent(mintedId)}`,
				);
			await cleanup("DELETE", "/v8/session");
		}
	}
}
