import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { afterEach, beforeAll, describe, expect, it, vi, beforeEach } from "bun:test";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { TUI } from "@oh-my-pi/pi-tui";
import { HookSelectorComponent } from "@oh-my-pi/pi-tui/overlays/hook-selector";
import { Settings } from "../src/config/settings";
import type { ExtensionUIDialogOptions, ExtensionUISelectItem } from "../src/extensibility/extensions";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { ToolSession } from "../src/tools";
import { AskTool, type AskToolInput } from "../src/tools/ask";
import { type AskToolDetails } from "@oh-my-pi/pi-tui/tools/ask";

type AskExecutionResult = AgentToolResult<AskToolDetails>;
type AskSelect = (
	title: string,
	options: ExtensionUISelectItem[],
	dialogOptions?: ExtensionUIDialogOptions,
) => Promise<string | undefined>;

const DB_QUESTIONS: AskToolInput["questions"] = [
	{
		id: "db",
		question: "Which database?",
		options: [{ label: "SQLite" }, { label: "Postgres" }],
		recommended: 1,
	},
];

async function drainMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function createAskTool(): AskTool {
	return new AskTool({
		hasUI: true,
		settings: Settings.isolated({ "ask.timeout": 0.01, "ask.notify": "off", "speech.enabled": false }),
		getPlanModeState: () => ({ enabled: false }),
	} as unknown as ToolSession);
}

function selectContext(select: AskSelect, extra: Record<string, unknown> = {}) {
	const abort = vi.fn();
	const context = {
		hasUI: true,
		ui: { select, input: vi.fn(), editor: vi.fn(), ...extra },
		abort,
	} as unknown as AgentToolContext;
	return { context, abort };
}

function runAsk(questions: AskToolInput["questions"], context: AgentToolContext) {
	const outcome: { result?: AskExecutionResult; rejection?: unknown } = {};
	void createAskTool()
		.execute("ask-timeout", { questions }, undefined, undefined, context)
		.then(
			value => {
				outcome.result = value;
			},
			error => {
				outcome.rejection = error;
			},
		);
	return outcome;
}

describe("AskTool timeout", () => {
	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("submits the recommended option when the selector does not settle", async () => {
		vi.useFakeTimers();
		const select = vi.fn<AskSelect>(() => Promise.withResolvers<string | undefined>().promise);
		const { context, abort } = selectContext(select);
		const outcome = runAsk(DB_QUESTIONS, context);

		await drainMicrotasks();
		vi.advanceTimersByTime(10);
		await drainMicrotasks();

		expect(outcome.rejection).toBeUndefined();
		expect(outcome.result?.details?.selectedOptions).toEqual(["Postgres"]);
		expect(outcome.result?.details?.timedOut).toBe(true);
		expect(abort).not.toHaveBeenCalled();
	});

	it("honors selector timeout resets before using the fallback timeout", async () => {
		vi.useFakeTimers();
		let selector: HookSelectorComponent | undefined;
		const select = vi.fn<AskSelect>(
			(title, options, dialogOptions) =>
				new Promise(resolve => {
					selector = new HookSelectorComponent(title, options, resolve, () => resolve(undefined), {
						...dialogOptions,
						tui: { requestRender: vi.fn() } as unknown as TUI,
					});
				}),
		);
		const { context, abort } = selectContext(select);
		const outcome = runAsk(DB_QUESTIONS, context);

		try {
			await drainMicrotasks();
			if (!selector) throw new Error("Ask did not present its selector");

			vi.advanceTimersByTime(9);
			selector.handleInput("j");
			vi.advanceTimersByTime(9);
			await drainMicrotasks();
			expect(outcome.result).toBeUndefined();

			vi.advanceTimersByTime(1);
			await drainMicrotasks();
			expect(outcome.rejection).toBeUndefined();
			expect(outcome.result?.details?.selectedOptions).toEqual(["Postgres"]);
			expect(outcome.result?.details?.timedOut).toBe(true);
			expect(abort).not.toHaveBeenCalled();
		} finally {
			selector?.dispose();
		}
	});

	it("does not run the fallback timeout while the selector is queued", async () => {
		vi.useFakeTimers();
		let startTimeout: (() => void) | undefined;
		const select = vi.fn<AskSelect>((_title, _options, dialogOptions) => {
			startTimeout = dialogOptions?.onTimeoutStart;
			return Promise.withResolvers<string | undefined>().promise;
		});
		const { context, abort } = selectContext(select, { timeoutStartsOnPresentation: true });
		const outcome = runAsk(DB_QUESTIONS, context);

		await drainMicrotasks();
		expect(startTimeout).toBeDefined();

		vi.advanceTimersByTime(10);
		await drainMicrotasks();

		expect(outcome.result).toBeUndefined();

		startTimeout?.();
		vi.advanceTimersByTime(10);
		await drainMicrotasks();

		expect(outcome.rejection).toBeUndefined();
		expect(outcome.result?.details?.timedOut).toBe(true);
		expect(abort).not.toHaveBeenCalled();
	});

	it("keeps an answered question when a later question times out", async () => {
		vi.useFakeTimers();
		const select = vi
			.fn<AskSelect>((_title, _options, dialogOptions) => {
				dialogOptions?.onTimeoutStart?.();
				return Promise.withResolvers<string | undefined>().promise;
			})
			.mockImplementationOnce(async () => "SQLite");
		const { context, abort } = selectContext(select);
		const outcome = runAsk(
			[
				...DB_QUESTIONS,
				{
					id: "auth",
					question: "Which auth?",
					options: [{ label: "JWT" }, { label: "OAuth" }],
					recommended: 0,
				},
			],
			context,
		);

		await drainMicrotasks();
		await drainMicrotasks();
		vi.advanceTimersByTime(10);
		await drainMicrotasks();
		await drainMicrotasks();

		expect(outcome.rejection).toBeUndefined();
		expect(
			outcome.result?.details?.results?.map(({ id, selectedOptions, timedOut }) => ({
				id,
				selectedOptions,
				timedOut,
			})),
		).toEqual([
			{ id: "db", selectedOptions: ["SQLite"], timedOut: undefined },
			{ id: "auth", selectedOptions: ["JWT"], timedOut: true },
		]);
		expect(abort).not.toHaveBeenCalled();
	});
});

let previousVimMode: boolean;
beforeEach(() => {
	previousVimMode = getMenuSearchVimMode();
	setMenuSearchVimMode(true);
});
afterEach(() => {
	setMenuSearchVimMode(previousVimMode);
});
