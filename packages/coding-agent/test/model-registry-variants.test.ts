import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Model, ServiceTier } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

async function payload(model: Model, serviceTier?: ServiceTier): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
	const stream = streamOpenAICodexResponses(
		model as Model<"openai-codex-responses">,
		{
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		},
		{
			apiKey: token,
			signal: AbortSignal.abort(),
			serviceTier,
			onPayload: value => {
				body = value as Record<string, unknown>;
			},
		},
	);
	await stream.result();
	if (!body) throw new Error("Codex request payload was not constructed");
	return body;
}

test("plain Codex selectors keep tier/window policy through role resolution and offline reload without affecting another assignment", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "npi-variants-"));
	const auth = await AuthStorage.create(":memory:");
	try {
		const scope = Settings.isolated({ extendedContext: false });
		const configPath = path.join(directory, "models.yml");
		const registry = new ModelRegistry(auth, configPath, { settings: scope });
		const primary = registry.find("openai-codex", "gpt-6-astra")!;
		const chosen = resolveModelRoleValue("openai-codex/gpt-6-astra-fast-900k:high", registry.getAll());
		const variant = chosen?.model;
		if (!variant) throw new Error("Expected exact variant selector to resolve");
		expect(variant.id).toBe("gpt-6-astra-fast-900k");
		expect(chosen?.thinkingLevel).toBe("high");
		expect(variant.contextWindow).toBe(922_000);
		expect(registry.fitContextWindow(variant, scope)).toBe(variant);
		expect(primary.contextWindow).toBe(272_000);
		const [fast, ordinary] = await Promise.all([payload(variant, "flex"), payload(primary)]);
		expect(fast.model).toBe("gpt-6-astra");
		expect(fast.service_tier).toBe("priority");
		expect(ordinary.model).toBe("gpt-6-astra");
		expect(ordinary.service_tier).toBeUndefined();
		const extended = registry.find("openai-codex", "gpt-6-astra-900k")!;
		expect((await payload(extended, "priority")).service_tier).toBeUndefined();
		const reloaded = new ModelRegistry(auth, configPath, { settings: scope });
		const restored = reloaded.find("openai-codex", variant.id)!;
		expect(restored.codexVariant).toEqual(variant.codexVariant);
		expect(restored.contextWindow).toBe(922_000);
		const largerScope = Settings.isolated({ extendedContext: true });
		const larger = new ModelRegistry(auth, configPath, { settings: largerScope });
		const standardFast = larger.find("openai-codex", "gpt-6-astra-fast")!;
		expect(standardFast.contextWindow).toBe(272_000);
		expect(larger.fitContextWindow(standardFast, largerScope)).toBe(standardFast);
	} finally {
		auth.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
