/**
 * Voice filter picker shown while a Ctrl+Space xAI recording is running.
 *
 * Recording never waits on it. Untouched, it counts down and closes on its
 * default (the first item, "None"), like a bootloader menu. Any navigation —
 * arrows, Tab/Shift+Tab, paging, or type-to-search — cancels the countdown and
 * the picker stays open with the chosen filter until Enter, Escape, or the end
 * of the recording. Ctrl+Space still reaches the recorder.
 */
import { CountdownTimer } from "../chrome/countdown-timer";
import { OverlayPanel } from "../chrome/overlay-box";
import { type SelectItem, SelectList } from "../components/select-list";
import { getKeybindings } from "../keybindings";
import { matchesKey } from "../keys";
import { getSelectListTheme } from "../theme/theme";
import type { TUI } from "../tui";

/** Visible rows; more filters scroll instead of growing the popup. */
export const VOICE_FILTER_PICKER_ROWS = 6;

const TITLE = "Voice filter";
const STICKY_HINT = "Enter keep · Esc none · Ctrl+Space stop";
const SELECT_DOWN = "\x1b[B";
const SELECT_UP = "\x1b[A";

export interface VoiceFilterPickerOptions {
	/** Picker rows; the first is the default applied on timeout. */
	items: SelectItem[];
	timeoutMs: number;
	tui?: TUI;
	/** Called exactly once with the chosen item value, or undefined for Escape. */
	onDecide(value: string | undefined): void;
	/** Ctrl+Space pressed while the picker holds focus. */
	onToggleRecording(): void;
}

export class VoiceFilterPickerComponent extends OverlayPanel {
	readonly #list: SelectList;
	readonly #options: VoiceFilterPickerOptions;
	#countdown: CountdownTimer | undefined;
	#decided = false;

	constructor(options: VoiceFilterPickerOptions) {
		super(TITLE);
		this.#options = options;
		this.#list = new SelectList(options.items, VOICE_FILTER_PICKER_ROWS, getSelectListTheme());
		this.#list.onSelect = item => this.#decide(item.value);
		this.#list.onCancel = () => this.#decide(undefined);
		this.addChild(this.#list);
		if (options.timeoutMs > 0) {
			this.#countdown = new CountdownTimer(
				options.timeoutMs,
				options.tui,
				seconds => (this.title = `${TITLE} (${seconds}s) · ↑↓/Tab choose`),
				() => this.#decide(options.items[0]?.value),
			);
		} else {
			this.title = `${TITLE} · ${STICKY_HINT}`;
		}
	}

	/** Whether a choice was made or the picker closed. */
	get decided(): boolean {
		return this.#decided;
	}

	/** Currently highlighted value. */
	get selectedValue(): string | undefined {
		return this.#list.getSelectedItem()?.value;
	}

	/** Close on the current highlight (the recording ended). */
	finish(): void {
		this.#decide(this.selectedValue);
	}

	handleInput(keyData: string): void {
		if (this.#decided) return;
		if (getKeybindings().matches(keyData, "app.stt.toggle")) {
			this.#options.onToggleRecording();
			return;
		}
		const isConfirmOrCancel =
			getKeybindings().matches(keyData, "tui.select.confirm") ||
			getKeybindings().matches(keyData, "tui.select.cancel") ||
			keyData === "\n";
		if (!isConfirmOrCancel) this.#stick();
		if (matchesKey(keyData, "tab")) {
			this.#list.handleInput(SELECT_DOWN);
		} else if (matchesKey(keyData, "shift+tab")) {
			this.#list.handleInput(SELECT_UP);
		} else {
			this.#list.handleInput(keyData);
		}
		this.#options.tui?.requestRender();
	}

	/** Navigation shows intent: stop the countdown and keep the picker open. */
	#stick(): void {
		if (!this.#countdown) return;
		this.#countdown.dispose();
		this.#countdown = undefined;
		this.title = `${TITLE} · ${STICKY_HINT}`;
	}

	#decide(value: string | undefined): void {
		if (this.#decided) return;
		this.#decided = true;
		this.#countdown?.dispose();
		this.#countdown = undefined;
		this.#options.onDecide(value);
	}

	override dispose(): void {
		this.#countdown?.dispose();
		this.#countdown = undefined;
		super.dispose();
	}
}
