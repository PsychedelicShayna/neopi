import { describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	buildTuiBuiltinSlashCommands,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { buildNamedToolChoice } from "@oh-my-pi/pi-coding-agent/utils/tool-choice";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui";

function createRuntimeHarness(overrides?: { setForcedToolChoice?: (toolName: string) => void }) {
	const setForcedToolChoice = vi.fn(overrides?.setForcedToolChoice ?? ((_toolName: string) => {}));
	const getActiveToolNames = vi.fn(() => ["read", "review", "write"]);
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();

	const ctx = {
		editor: { setText } as unknown as InteractiveModeContext["editor"],
		session: { getActiveToolNames, setForcedToolChoice } as unknown as InteractiveModeContext["session"],
		showStatus,
		showError,
	} as unknown as InteractiveModeContext;

	return {
		runtime: {
			ctx,
		},
		getActiveToolNames,
		setForcedToolChoice,
		setText,
		showStatus,
		showError,
	};
}

describe("/force slash command", () => {
	it("completes live tool names after both separators and leaves the prompt open", async () => {
		const h = createRuntimeHarness();
		const commands = buildTuiBuiltinSlashCommands(h.runtime).filter(command => command.name === "force");
		const provider = new CombinedAutocompleteProvider([...commands], process.cwd());
		for (const input of ["/force re", "/force:re"]) {
			const suggestions = await provider.getSuggestions([input], 0, input.length);
			expect(suggestions?.items.map(item => item.label)).toEqual(["read", "review"]);
		}

		h.getActiveToolNames.mockReturnValue(["review"]);
		const draft = "/force:re";
		const suggestions = await provider.getSuggestions([draft], 0, draft.length);
		expect(suggestions?.items.map(item => item.label)).toEqual(["review"]);
		const item = suggestions?.items[0];
		if (!suggestions || !item) throw new Error("Missing /force tool completion");
		expect(item.submitsCommand).toBe(false);
		expect(provider.applyCompletion([draft], 0, draft.length, item, suggestions.prefix).lines).toEqual([
			"/force:review ",
		]);
		const prompt = "/force:review finish the report";
		expect(await provider.getSuggestions([prompt], 0, prompt.length)).toBeNull();
	});

	it("forces the next round tool with colon syntax", async () => {
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/force:write", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setForcedToolChoice).toHaveBeenCalledWith("write");
		expect(harness.showStatus).toHaveBeenCalledWith("Next turn forced to use write.");
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("shows usage when tool name is missing", async () => {
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/force", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setForcedToolChoice).not.toHaveBeenCalled();
		expect(harness.showError).toHaveBeenCalledWith("Usage: /force:<tool-name> [prompt]");
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("returns remaining prompt text when provided after tool name", async () => {
		const harness = createRuntimeHarness();

		const result = await executeBuiltinSlashCommand("/force:write fix the tests", harness.runtime);

		expect(result).toBe("fix the tests");
		expect(harness.setForcedToolChoice).toHaveBeenCalledWith("write");
		expect(harness.showStatus).toHaveBeenCalledWith("Next turn forced to use write.");
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("forces tool with space syntax", async () => {
		const harness = createRuntimeHarness();

		const result = await executeBuiltinSlashCommand("/force write", harness.runtime);

		expect(result).toBe(true);
		expect(harness.setForcedToolChoice).toHaveBeenCalledWith("write");
	});

	it("returns remaining prompt with space syntax", async () => {
		const harness = createRuntimeHarness();

		const result = await executeBuiltinSlashCommand("/force write fix the tests", harness.runtime);

		expect(result).toBe("fix the tests");
		expect(harness.setForcedToolChoice).toHaveBeenCalledWith("write");
	});

	it("surfaces session validation errors", async () => {
		const harness = createRuntimeHarness({
			setForcedToolChoice: () => {
				throw new Error('Tool "write" is not currently active.');
			},
		});

		const handled = await executeBuiltinSlashCommand("/force:write", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showError).toHaveBeenCalledWith('Tool "write" is not currently active.');
		expect(harness.showStatus).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("builds a named Ollama choice for local forced tools", () => {
		const model = buildModel({
			id: "ggml-org/gemma-3-1b-it/GGUF",
			name: "Gemma 3 1B",
			api: "ollama-chat",
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 8_192,
		}) satisfies Model<"ollama-chat">;

		expect(buildNamedToolChoice("write", model)).toEqual({ type: "function", name: "write" });
	});

	it("builds a named function choice for OpenRouter models", () => {
		// OpenRouter used to be modelled as openai-completions and got this choice; since
		// it became its own api, /force refused every OpenRouter model.
		const model = buildModel({
			id: "openai/gpt-5",
			name: "GPT-5 (OpenRouter)",
			api: "openrouter",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		}) satisfies Model<"openrouter">;

		expect(buildNamedToolChoice("write", model)).toEqual({ type: "function", name: "write" });
	});

	it("does not report a forced choice for an OpenRouter model that drops it", () => {
		// supportsToolChoice: false makes both OpenAI transports drop tool_choice, so a
		// named choice here would let /force claim a force that never reaches the wire.
		const model = buildModel({
			id: "amazon/nova-lite-v1",
			name: "Nova Lite (OpenRouter)",
			api: "openrouter",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 300_000,
			maxTokens: 5_120,
			compat: { supportsToolChoice: false },
		}) satisfies Model<"openrouter">;

		expect(buildNamedToolChoice("write", model)).toBeUndefined();
	});

	it("reports forcing as unsupported on hosts that only accept auto tool_choice", () => {
		// api.meta.ai rejects every tool_choice except "auto", so the provider rules omit
		// the field; a named force would be dropped on the wire instead of honored.
		for (const provider of ["meta", "muse-code"]) {
			const model = buildModel(seedModels<"openai-responses">(provider)[0]!);
			expect(buildNamedToolChoice("write", model)).toBeUndefined();
		}
	});
});
