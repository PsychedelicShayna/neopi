import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { pinnedCredential } from "../src/switch/credential";

const PROVIDER = "openai-codex";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const ACCOUNT = "mock-pinned-codex-account";
const FAKE_REFRESH = "fake-refresh-never-valid-at-provider";
const NEXT_ACCESS = "fake-access-from-loopback";
const NEXT_REFRESH = "fake-refresh-from-loopback";

// Every case starts with an empty database; no broker or real credentials are used.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(expired: boolean) {
	const scratch = path.join(os.homedir(), ".cache/npi-canary");
	await fs.mkdir(scratch, { recursive: true });
	const dir = await fs.mkdtemp(path.join(scratch, "pinned-oauth-refresh-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const databasePath = path.join(dir, "agent.db");
	const store = await SqliteAuthCredentialStore.open(databasePath);
	const storage = new AuthStorage(store, {
		usageProviderResolver: () => undefined,
		rankingStrategyResolver: () => undefined,
	});
	cleanups.push(() => storage.close());
	await storage.credentials.set(PROVIDER, [
		{
			type: "oauth",
			access: "fake-rejected-access",
			refresh: FAKE_REFRESH,
			expires: expired ? Date.now() - 60_000 : Date.now() + 3_600_000,
			accountId: ACCOUNT,
			email: "fixture@example.invalid",
		},
		{
			type: "oauth",
			access: "fake-sibling-access",
			refresh: "fake-sibling-refresh",
			expires: Date.now() + 3_600_000,
			accountId: "mock-sibling-account",
			email: "sibling@example.invalid",
		},
	]);
	const rows = store.listAuthCredentials(PROVIDER);
	const row = rows.find(entry => entry.credential.type === "oauth" && entry.credential.accountId === ACCOUNT);
	const sibling = rows.find(entry => entry.id !== row?.id);
	if (!row || !sibling) throw new Error("missing fixture credentials");
	const fingerprint = await storage.keys.fingerprintPinned(row.id, PROVIDER);
	if (!fingerprint) throw new Error("missing fixture fingerprint");
	const requests: Array<{ method: string; path: string; contentType: string | null; form: Record<string, string> }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push({
				method: request.method,
				path: new URL(request.url).pathname,
				contentType: request.headers.get("content-type"),
				form: Object.fromEntries(new URLSearchParams(await request.text())),
			});
			return Response.json({ access_token: NEXT_ACCESS, refresh_token: NEXT_REFRESH, expires_in: 3600 });
		},
	});
	cleanups.push(() => server.stop(true));
	const originalFetch = globalThis.fetch;
	const blocked: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				// Only this synthetic exchange can reach the network, redirected to loopback.
				if (url !== TOKEN_URL) {
					blocked.push(url);
					throw new Error(`Unexpected network request blocked: ${url}`);
				}
				return originalFetch(new URL("/oauth/token", server.url), init);
			},
			{ preconnect: originalFetch.preconnect },
		),
	);
	return {
		storage,
		row,
		fingerprint,
		requests,
		async assertRotated() {
			expect(requests).toEqual([
				{
					method: "POST",
					path: "/oauth/token",
					contentType: "application/x-www-form-urlencoded",
					form: {
						grant_type: "refresh_token",
						client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
						refresh_token: FAKE_REFRESH,
					},
				},
			]);
			expect(blocked).toEqual([]);
			// Read through a separate connection to prove durable same-row rotation.
			const reader = await SqliteAuthCredentialStore.open(databasePath);
			try {
				const persisted = reader.listAuthCredentials(PROVIDER);
				expect(persisted).toHaveLength(2);
				expect(persisted.find(entry => entry.id === row.id)).toMatchObject({
					id: row.id,
					credential: { type: "oauth", access: NEXT_ACCESS, refresh: NEXT_REFRESH, accountId: ACCOUNT },
				});
				expect(persisted.find(entry => entry.id === sibling.id)).toEqual(sibling);
			} finally {
				reader.close();
			}
		},
	};
}

test("expired pinned OAuth returns the rotated token without changing its sibling", async () => {
	const f = await fixture(true);
	const key = await f.storage.keys.getPinned(f.row.id, "expired-pin", {
		expectedProvider: PROVIDER,
		expectedFingerprint: f.fingerprint,
		modelId: "gpt-5.5",
		forceRefresh: true,
	});
	expect(key).toBe(NEXT_ACCESS);
	await f.assertRotated();
});

test("switch-bound 401 recovery rotates the same credential without using its sibling", async () => {
	const f = await fixture(false);
	const binding = { provider: PROVIDER, credentialId: f.row.id, fingerprint: f.fingerprint };
	const credential = await pinnedCredential(f.storage, binding, "gpt-5.5", "recover-pin", new AbortController().signal);
	if (!credential) throw new Error("missing pinned credential");
	expect(credential.initial).toBe("fake-rejected-access");
	expect(f.requests).toHaveLength(0);
	const recovered = await credential.resolver({
		error: Object.assign(new Error("401 authentication_error"), { status: 401 }),
		lastChance: false,
	});
	expect(recovered).toEqual({ apiKey: NEXT_ACCESS, credentialId: f.row.id });
	await f.assertRotated();
});
