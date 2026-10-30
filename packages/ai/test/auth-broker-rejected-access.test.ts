import { afterEach, describe, expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { pinnedCredential } from "../src/switch/credential";

const PROVIDER = "unit-broker-rejected-access";
const SOURCE = "auth-broker-rejected-access-test";
const HOUR_MS = 60 * 60_000;

describe("broker rejected access recovery", () => {
	let tokenServer: Bun.Server<undefined> | undefined;
	let broker: AuthBrokerServerHandle | undefined;
	let store: SqliteAuthCredentialStore | undefined;
	const storages: AuthStorage[] = [];
	const remotes: RemoteAuthCredentialStore[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const storage of storages.splice(0)) storage.close();
		for (const remote of remotes.splice(0)) remote.close();
		await broker?.close();
		tokenServer?.stop(true);
		store?.close();
		unregisterOAuthProviders(SOURCE);
	});

	for (const mode of ["refresh-by-id", "pool", "override", "switch", "expiry"] as const) {
		test(`${mode}: coalesces concurrent refreshes and preserves newer tokens`, async () => {
			let exchanges = 0;
			const refreshTokens: string[] = [];
			const concurrentRecovery = Promise.withResolvers<void>();
			tokenServer = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					const form = new URLSearchParams(await request.text());
					refreshTokens.push(form.get("refresh_token") ?? "");
					exchanges += 1;
					const mint = exchanges;
					if (mint === 2 || (mode === "expiry" && mint === 1)) await concurrentRecovery.promise;
					return Response.json({
						access: `fake-access-${mint}`,
						refresh: `fake-refresh-${mint}`,
						expires: Date.now() + HOUR_MS,
					});
				},
			});
			const tokenUrl = tokenServer.url;
			registerOAuthProvider({
				id: PROVIDER,
				name: "Rejected Access Test",
				sourceId: SOURCE,
				async login() {
					throw new Error("test does not log in");
				},
				async refreshToken(credential, signal): Promise<OAuthCredentials> {
					const response = await fetch(tokenUrl, {
						method: "POST",
						body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential.refresh }),
						signal,
					});
					return (await response.json()) as OAuthCredentials;
				},
				getApiKey: credential => credential.access,
			});
			store = new SqliteAuthCredentialStore(new Database(":memory:"));
			await store.saveOAuth(PROVIDER, {
				access: "fake-access-0",
				refresh: "fake-refresh-0",
				expires: mode === "expiry" ? 0 : Date.now() + HOUR_MS,
				accountId: "target-account",
			});
			await store.saveOAuth(PROVIDER, {
				access: "sibling-access",
				refresh: "sibling-refresh",
				expires: Date.now() + HOUR_MS,
				accountId: "sibling-account",
			});
			const brokerStorage = new AuthStorage(store);
			storages.push(brokerStorage);
			await brokerStorage.credentials.reload();
			broker = startAuthBroker({
				storage: brokerStorage,
				bind: "127.0.0.1:0",
				bearerTokens: ["fake-broker-bearer"],
				disableRefresher: true,
			});
			const client = new AuthBrokerClient({ url: broker.url, token: "fake-broker-bearer" });
			const id = store.listAuthCredentials(PROVIDER)[0]!.id;
			const sibling = store.listAuthCredentials(PROVIDER)[1]!;
			const expiredSnapshot = mode === "expiry" ? await client.fetchSnapshot() : undefined;
			if (mode !== "expiry") {
				await client.refreshCredential(id);
				expect(exchanges).toBe(1);
			}
			const snapshot = expiredSnapshot ?? (await client.fetchSnapshot());
			if (snapshot.status !== 200) throw new Error("expected broker snapshot");
			const consumers = await Promise.all(
				[0, 1, 2].map(async () => {
					const remote = new RemoteAuthCredentialStore({
						client: new AuthBrokerClient({ url: broker!.url, token: "fake-broker-bearer" }),
						initialSnapshot: snapshot.snapshot,
						streamSnapshots: false,
					});
					remotes.push(remote);
					const storage = new AuthStorage(remote, {
						refreshOAuthCredential: mode === "override" ? remote.refreshOAuthCredential.bind(remote) : undefined,
					});
					storages.push(storage);
					await storage.credentials.reload();
					if (mode === "pool" || mode === "override") {
						// Recovery follows a request, so retain that request's account affinity.
						expect(await storage.keys.get(PROVIDER, "consumer", { accountIds: ["target-account"] })).toBe(
							"fake-access-1",
						);
					}
					return storage;
				}),
			);
			let recoveries = 0;
			const refresh = brokerStorage.oauth.refresh.bind(brokerStorage.oauth);
			vi.spyOn(brokerStorage.oauth, "refresh").mockImplementation((credentialId, signal, options) => {
				recoveries += 1;
				if (recoveries === 2) concurrentRecovery.resolve();
				return refresh(credentialId, signal, options);
			});
			const recover = async (storage: AuthStorage, rejectedAccess: string) => {
				if (mode === "expiry") {
					return storage.keys.get(PROVIDER, "consumer", { accountIds: ["target-account"] });
				}
				if (mode === "switch") {
					const fingerprint = await storage.keys.fingerprintPinned(id, PROVIDER);
					if (!fingerprint) throw new Error("missing pinned fingerprint");
					const pinned = await pinnedCredential(
						storage,
						{ provider: PROVIDER, credentialId: id, fingerprint },
						"fake-model",
						"consumer",
						new AbortController().signal,
					);
					if (!pinned) throw new Error("missing pinned credential");
					const resolved = await pinned.resolver({
						lastChance: false,
						error: Object.assign(new Error("fake rejected token"), { status: 401 }),
						previousKey: rejectedAccess,
					});
					return typeof resolved === "string" ? resolved : resolved?.apiKey;
				}
				if (mode === "refresh-by-id") {
					const entry = await storage.oauth.refresh(id, undefined, { reason: "auth-recovery", rejectedAccess });
					return entry.credential.type === "oauth" ? entry.credential.access : undefined;
				}
				return storage.keys.get(PROVIDER, "consumer", {
					accountIds: ["target-account"],
					forceRefresh: true,
					refreshReason: "auth-recovery",
					rejectedAccessToken: rejectedAccess,
				});
			};
			if (mode === "expiry") {
				const usageRefresh = brokerStorage.keys.get(PROVIDER, "usage", { accountIds: ["target-account"] });
				const lateRefreshes = consumers.map(async () => {
					const result = await client.refreshCredential(id, undefined, "expiry");
					return result.entry.credential.type === "oauth" ? result.entry.credential.access : undefined;
				});
				const ordinaryRefreshes = consumers.map(storage => recover(storage, "fake-access-0"));
				expect(await Promise.all([usageRefresh, ...lateRefreshes, ...ordinaryRefreshes])).toEqual(
					Array(7).fill("fake-access-1"),
				);
				// A gateway refresh arriving after that single flight must reuse it too.
				const delayed = await client.refreshCredential(id, undefined, "expiry");
				expect(delayed.entry.credential).toMatchObject({ access: "fake-access-1" });
				expect(exchanges).toBe(1);
				expect(store.listAuthCredentials(PROVIDER)[1]).toEqual(sibling);
				return;
			}
			expect(await Promise.all(consumers.map(storage => recover(storage, "fake-access-1")))).toEqual([
				"fake-access-2",
				"fake-access-2",
				"fake-access-2",
			]);
			expect(exchanges).toBe(2);
			expect(refreshTokens).toEqual(["fake-refresh-0", "fake-refresh-1"]);
			expect(await recover(consumers[0]!, "fake-access-0")).toBe("fake-access-2");
			expect(exchanges).toBe(2);
			expect(store.listAuthCredentials(PROVIDER)[1]).toEqual(sibling);
		});
	}
});
