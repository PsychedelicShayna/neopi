import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageFetchParams, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { formatUsageJson, prepareUsageView } from "@oh-my-pi/pi-coding-agent/cli/usage-cli";
import {
	type RpcInputFrameDeps,
	RpcInputDispatcher,
	type PendingExtensionRequest,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import {
	getRpcUsage,
	RpcUsageUnavailableError,
	type RpcUsageSource,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-usage";

const CODEX_ACCOUNTS = [
	{ email: "alice@example.com", accountId: "acct-alice-1" },
	{ email: "alan@example.com", accountId: "acct-alan-2" },
];

/** Usage upstream test double: records every fetch and can hold fetches open. */
class UsageUpstream {
	calls: string[] = [];
	hold: PromiseWithResolvers<void> | undefined;

	provider(id: string): UsageProvider {
		return {
			id,
			fetchUsage: async (params: UsageFetchParams) => {
				const account = params.credential.accountId ?? "api-key";
				this.calls.push(`${params.provider}:${account}`);
				if (this.hold) await this.hold.promise;
				return usageReport(params.provider, params.credential.email, params.credential.accountId);
			},
		};
	}
}

function usageReport(provider: string, email: string | undefined, accountId: string | undefined): UsageReport {
	return {
		provider,
		fetchedAt: Date.now(),
		limits: [
			{
				id: `${provider}:5h`,
				label: "5 Hour",
				scope: { provider, accountId, windowId: "5h" },
				window: { id: "5h", label: "5 Hour" },
				amount: { used: 40, limit: 100, unit: "percent" },
				status: "ok",
			},
		],
		metadata: email ? { email, accountId, plan: "pro" } : { plan: "key" },
		raw: { upstreamBody: "provider-specific payload" },
	};
}

const responseFor = (command: RpcCommand, data: object): RpcResponse =>
	({ id: command.id, type: "response", command: command.type, success: true, data }) as RpcResponse;

describe("get_usage", () => {
	let upstream: UsageUpstream;
	let storage: AuthStorage;
	let source: RpcUsageSource;

	beforeEach(async () => {
		upstream = new UsageUpstream();
		const providers = new Map([
			["openai-codex", upstream.provider("openai-codex")],
			["zai", upstream.provider("zai")],
		]);
		storage = await AuthStorage.create(":memory:", { usageProviderResolver: id => providers.get(id) });
		await storage.credentials.set(
			"openai-codex",
			CODEX_ACCOUNTS.map(({ email, accountId }) => ({
				type: "oauth" as const,
				access: `access-${accountId}`,
				refresh: `refresh-${accountId}`,
				expires: Date.now() + 3_600_000,
				email,
				accountId,
			})),
		);
		await storage.credentials.set("zai", { type: "api_key", key: "zai-key" });
		// Same wiring as AgentSession.fetchUsageReports: the storage's cached, coalesced fetch.
		source = { authStorage: storage, fetchUsageReports: () => storage.usage.reports() };
	});

	afterEach(() => {
		storage.close();
	});

	test("reports match the `npi usage --json` reports built from the same storage", async () => {
		for (const options of [{}, { provider: "OpenAI-Codex" }, { redact: true }, { provider: "zai", redact: true }]) {
			const rpc = await getRpcUsage(source, options);
			const cli = formatUsageJson(await prepareUsageView(storage, (await storage.usage.reports()) ?? [], options));
			expect(rpc.reports).toEqual(cli.reports);
		}
		// Both paths read the cache the first call filled.
		expect(upstream.calls).toHaveLength(3);
	});

	test("drops the provider-specific raw payload", async () => {
		const { reports } = await getRpcUsage(source, {});
		expect(reports).toHaveLength(3);
		for (const report of reports) expect("raw" in report).toBe(false);
	});

	test("provider filters to that provider; an unknown provider yields no reports", async () => {
		const codex = await getRpcUsage(source, { provider: "openai-codex" });
		expect(codex.reports.map(report => report.provider)).toEqual(["openai-codex", "openai-codex"]);

		const unknown = await getRpcUsage(source, { provider: "no-such-provider" });
		expect(unknown.reports).toEqual([]);
	});

	test("redact masks every account identifier, keeping colliding accounts distinguishable", async () => {
		const { reports } = await getRpcUsage(source, { provider: "openai-codex", redact: true });
		const serialized = JSON.stringify(reports);
		for (const { email, accountId } of CODEX_ACCOUNTS) {
			expect(serialized).not.toContain(email);
			expect(serialized).not.toContain(accountId);
		}
		const emails = reports.map(report => report.metadata?.email);
		expect(new Set(emails).size).toBe(2);
		for (const email of emails) expect(email).toMatch(/^al\*/);
	});

	test("refresh invalidates the cache so the next fetch goes upstream", async () => {
		await getRpcUsage(source, {});
		await getRpcUsage(source, {});
		expect(upstream.calls).toHaveLength(3);

		await getRpcUsage(source, { refresh: true });
		expect(upstream.calls).toHaveLength(6);
	});

	test("refresh with a provider refetches only that provider", async () => {
		await getRpcUsage(source, {});
		upstream.calls = [];

		await getRpcUsage(source, { provider: "zai", refresh: true });
		expect(upstream.calls).toEqual(["zai:api-key"]);
	});

	test("a failed fetch reports each covered provider with no limits and a note", async () => {
		const failing: RpcUsageSource = {
			authStorage: storage,
			fetchUsageReports: () => Promise.reject(new Error("broker unreachable")),
		};
		const all = await getRpcUsage(failing, {});
		expect(all.reports.map(report => report.provider).sort()).toEqual(["openai-codex", "zai"]);
		for (const report of all.reports) {
			expect(report.limits).toEqual([]);
			expect(report.notes).toEqual(["Usage fetch failed: broker unreachable"]);
		}

		const one = await getRpcUsage(failing, { provider: "zai" });
		expect(one.reports.map(report => report.provider)).toEqual(["zai"]);
	});

	test("fails with usage_unavailable when auth storage is not initialized", async () => {
		const unwired = getRpcUsage({ authStorage: undefined, fetchUsageReports: async () => null }, {});
		await expect(unwired).rejects.toBeInstanceOf(RpcUsageUnavailableError);
		await expect(unwired).rejects.toMatchObject({ code: "usage_unavailable" });

		const noReporter = getRpcUsage({ authStorage: storage, fetchUsageReports: async () => null }, {});
		await expect(noReporter).rejects.toMatchObject({ code: "usage_unavailable" });
	});

	describe("dispatch", () => {
		const makeDispatcher = (ready?: Promise<void>) => {
			const outputs: RpcResponse[] = [];
			const deps: RpcInputFrameDeps = {
				handleCommand: async command => {
					if (command.type === "get_usage") return responseFor(command, await getRpcUsage(source, command));
					return responseFor(command, { agentInvoked: true });
				},
				output: obj => {
					outputs.push(obj as RpcResponse);
				},
				errorResponse: (id, command, message) => ({
					id,
					type: "response",
					command,
					success: false,
					error: message,
				}),
				pendingExtensionRequests: new Map<string, PendingExtensionRequest>(),
				onHostToolResult: () => {},
				onHostToolUpdate: () => {},
				onHostUriResult: () => {},
			};
			return { dispatcher: new RpcInputDispatcher({ deps, ready }), outputs };
		};
		const waitForResponse = async (outputs: RpcResponse[], id: string) => {
			while (!outputs.some(frame => frame.id === id)) await Bun.sleep(1);
		};

		test("a prompt sent while get_usage waits on a slow provider is answered first", async () => {
			upstream.hold = Promise.withResolvers<void>();
			const { dispatcher, outputs } = makeDispatcher();

			dispatcher.dispatch({ id: "usage-1", type: "get_usage" });
			dispatcher.dispatch({ id: "prompt-1", type: "prompt", message: "hi" });
			await waitForResponse(outputs, "prompt-1");
			expect(outputs.map(frame => frame.id)).toEqual(["prompt-1"]);

			upstream.hold.resolve();
			await waitForResponse(outputs, "usage-1");
			expect(outputs.map(frame => frame.id)).toEqual(["prompt-1", "usage-1"]);
		});

		test("back-to-back get_usage commands share one upstream fetch", async () => {
			upstream.hold = Promise.withResolvers<void>();
			const { dispatcher, outputs } = makeDispatcher();

			dispatcher.dispatch({ id: "usage-1", type: "get_usage" });
			dispatcher.dispatch({ id: "usage-2", type: "get_usage", provider: "zai" });
			while (upstream.calls.length < 3) await Bun.sleep(1);
			upstream.hold.resolve();
			await Promise.all([waitForResponse(outputs, "usage-1"), waitForResponse(outputs, "usage-2")]);

			expect(upstream.calls.sort()).toEqual([
				"openai-codex:acct-alan-2",
				"openai-codex:acct-alice-1",
				"zai:api-key",
			]);
			const second = outputs.find(frame => frame.id === "usage-2");
			expect(second).toMatchObject({ success: true, data: { reports: [{ provider: "zai" }] } });
		});

		test("get_usage waits for the startup gate", async () => {
			const startup = Promise.withResolvers<void>();
			const { dispatcher, outputs } = makeDispatcher(startup.promise);

			dispatcher.dispatch({ id: "usage-1", type: "get_usage" });
			await Bun.sleep(5);
			expect(upstream.calls).toEqual([]);
			expect(outputs).toEqual([]);

			startup.resolve();
			await waitForResponse(outputs, "usage-1");
			expect(outputs.map(frame => frame.id)).toEqual(["usage-1"]);
		});
	});
});
