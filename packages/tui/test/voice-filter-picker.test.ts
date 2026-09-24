import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { VoiceFilterPickerComponent } from "@oh-my-pi/pi-tui/overlays/voice-filter-picker";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ITEMS = [
	{ value: "", label: "None" },
	{ value: "/f/concise.md", label: "concise" },
	{ value: "/f/promptify.md", label: "promptify" },
];
const TIMEOUT_MS = 5_000;
const DOWN = "\x1b[B";

describe("VoiceFilterPickerComponent", () => {
	beforeAll(async () => {
		await initTheme();
		setKeybindings(KeybindingsManager.inMemory());
	});

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function makePicker() {
		const onDecide = vi.fn<(value: string | undefined) => void>();
		const onToggleRecording = vi.fn();
		const picker = new VoiceFilterPickerComponent({
			items: ITEMS,
			timeoutMs: TIMEOUT_MS,
			onDecide,
			onToggleRecording,
		});
		return { picker, onDecide, onToggleRecording };
	}

	it("falls back to the default entry when left untouched", () => {
		const { onDecide } = makePicker();
		vi.advanceTimersByTime(TIMEOUT_MS - 1);
		expect(onDecide).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onDecide).toHaveBeenCalledTimes(1);
		expect(onDecide).toHaveBeenCalledWith("");
	});

	it("stays open past the timeout once navigated, then closes on the highlighted filter", () => {
		const { picker, onDecide } = makePicker();
		picker.handleInput("\t");
		picker.handleInput(DOWN);
		vi.advanceTimersByTime(TIMEOUT_MS * 3);
		expect(onDecide).not.toHaveBeenCalled();
		expect(picker.selectedValue).toBe("/f/promptify.md");
		picker.finish();
		expect(onDecide).toHaveBeenCalledTimes(1);
		expect(onDecide).toHaveBeenCalledWith("/f/promptify.md");
	});

	it("passes Ctrl+Space to the recorder without deciding or stopping the countdown", () => {
		const { picker, onDecide, onToggleRecording } = makePicker();
		picker.handleInput("\x00");
		expect(onToggleRecording).toHaveBeenCalledTimes(1);
		expect(onDecide).not.toHaveBeenCalled();
		vi.advanceTimersByTime(TIMEOUT_MS);
		expect(onDecide).toHaveBeenCalledTimes(1);
		expect(onDecide).toHaveBeenCalledWith("");
	});

	it("decides None on Escape even after choosing a filter", () => {
		const { picker, onDecide } = makePicker();
		picker.handleInput(DOWN);
		picker.handleInput("\x1b");
		expect(onDecide).toHaveBeenCalledTimes(1);
		expect(onDecide).toHaveBeenCalledWith(undefined);
	});
});
