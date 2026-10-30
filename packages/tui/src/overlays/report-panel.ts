import type { TspText } from "@oh-my-pi/pi-wire";
import { OverlayPanel } from "../chrome/overlay-box";
import { editorKey } from "../chrome/keybinding-hints";
import { Ellipsis } from "../index";
import { ScrollView } from "../components/scroll-view";
import { MenuKeyReader, menuScrollBy } from "../components/menu-navigation";
import { Spacer } from "../components/spacer";
import { MenuHelp, MenuHints, menuHintLines } from "../components/menu-hints";
import { routeSgrMouseInput } from "../mouse";
import { actionBar, actionButton } from "../native/overlay";
import { col } from "../native/describe";
import type { NativeNode, NativeScroll, NativeUiEvent } from "../native/node";
import { theme } from "../theme/theme";
import type { Component } from "../tui";

/** Options of a {@link ReportPanel}. */
export interface ReportPanelOptions {
	/** Plain title: the text-mode border title, and the native sheet head unless {@link head} is given. */
	readonly title: string;
	/** Styled native sheet head. */
	readonly head?: TspText;
	/** The read-only report; it draws no frame or title of its own. */
	readonly body: Component;
	/**
	 * Display form of the key that dismisses the report while it sits above the
	 * editor (the editor's interrupt key, which routes to it). Once the panel
	 * holds focus ({@link ReportPanel.holdFocus}) the hint shows the key its own
	 * input closes on instead.
	 */
	readonly closeKey: string;
	/** The focused panel (native sheet, text-mode full-screen page) closes on Esc / its Close button: this runs. */
	readonly onClose: () => void;
	/**
	 * Most rows the text-mode panel may take, borders included (the screen rows
	 * left above the editor); a taller report scrolls inside it. `undefined`
	 * leaves it uncapped.
	 */
	readonly maxRows?: () => number | undefined;
}

/** Text-mode rows around the scrolled body: the borders, two spacers and the footer. */
const TEXT_CHROME_ROWS = 5;

/**
 * A read-only command report (`/changelog`, `/context`, `/tools`, …).
 *
 * Text mode draws a titled box with the body and an Esc hint: above the editor
 * like the `/btw` panel while it fits there (the editor keeps focus and its
 * Esc takes it away), or as a full-screen page on the alternate screen when it
 * is taller, whose body scrolls on the arrow/page/Home/End keys and the wheel.
 * Natively it is a sheet like `/usage`: a centred `lg` glass sheet titled by
 * the report whose body the terminal scrolls (wheel, and the same keys
 * forwarded as scroll requests), then a Close button; Esc closes it.
 */
export class ReportPanel extends OverlayPanel {
	readonly nativeOverlay: NonNullable<Component["nativeOverlay"]>;
	readonly #body: Component;
	readonly #onClose: () => void;
	readonly #maxRows: (() => number | undefined) | undefined;
	readonly #view: ScrollView;
	readonly #footer: MenuHints;
	#closeHint: string;
	#bodyRows = 0;
	#scroll: NativeScroll | undefined;
	#native: { scroll: NativeScroll | undefined; node: NativeNode } | undefined;
	readonly #keys = new MenuKeyReader();
	readonly #help = new MenuHelp("jk gg/G C-u d e y");
	#overflows = false;

	constructor(options: ReportPanelOptions) {
		super(options.title, "omp.overlay.report");
		this.nativeOverlay = {
			role: "omp.overlay.report",
			size: "lg",
			anchor: "center",
			head: options.head ?? options.title,
		};
		this.#body = options.body;
		this.#onClose = options.onClose;
		this.#maxRows = options.maxRows;
		this.#closeHint = `${options.closeKey} to close`;
		this.#view = new ScrollView(options.body, {
			height: 0,
			scrollbar: "auto",
			ellipsis: Ellipsis.Omit,
			theme: { track: text => theme.fg("dim", text), thumb: text => theme.fg("accent", text) },
		});
		this.#footer = new MenuHints(
			() =>
				`${this.#overflows ? `${editorKey("tui.select.pageUp")}/${editorKey("tui.select.pageDown")} scroll · ` : ""}${this.#closeHint} · ? help`,
			text => theme.fg("muted", text),
			"jk gg/G C-u d e y",
		);
		this.addChild(new Spacer(1));
		this.addChild(this.#view);
		this.addChild(new Spacer(1));
		this.addChild(this.#footer);
	}

	/**
	 * The panel is shown with focus (native sheet, text-mode full-screen page):
	 * its own {@link handleInput} closes it, so the hint names that key.
	 */
	holdFocus(): void {
		this.#closeHint = `${editorKey("tui.select.cancel")} to close`;
	}

	navigationSnapshot(): unknown {
		return this.#view.navigationSnapshot();
	}

	restoreNavigation(snapshot: unknown): void {
		this.#view.restoreNavigation(snapshot);
		this.#keys.reset();
		this.#scroll = undefined;
		this.#native = undefined;
	}

	/**
	 * Text mode: cap the box to {@link ReportPanelOptions.maxRows}, scrolling a
	 * taller body. The cap is a hard limit: when a resize leaves fewer rows than
	 * the box's chrome needs, its bottom (the hint and closing border) is cut
	 * rather than spilling over the editor.
	 */
	override render(width: number): readonly string[] {
		const innerWidth = Math.max(1, width - 4);
		const rows = this.#body.render(innerWidth).length;
		const cap = this.#maxRows?.();
		const footerRows = menuHintLines(
			`${editorKey("tui.select.pageUp")}/${editorKey("tui.select.pageDown")} scroll · ${this.#closeHint} · ? help`,
			innerWidth,
			"jk gg/G C-u d e y",
		).length;
		const bodyMax = cap === undefined ? rows : Math.max(1, cap - TEXT_CHROME_ROWS - footerRows + 1);
		const overflows = rows > bodyMax;
		this.#bodyRows = Math.min(rows, bodyMax);
		this.#view.setHeight(this.#bodyRows);
		this.#overflows = overflows;
		const lines = super.render(width);
		return this.#help.render(
			cap !== undefined && lines.length > cap ? lines.slice(0, Math.max(0, cap)) : lines,
			width,
		);
	}

	/** Text mode: rows the whole box takes at `width` when nothing caps it. */
	heightAt(width: number): number {
		const innerWidth = Math.max(1, width - 4);
		return this.#body.render(innerWidth).length + TEXT_CHROME_ROWS + this.#footer.render(innerWidth).length - 1;
	}

	/**
	 * The sheet body (the overlay is the frame, and its body the scroller): the
	 * report as `omp.report.body`, which the terminal sets on the reading
	 * measure, then Close (Esc) as the sheet's footer.
	 */
	override describe(): NativeNode {
		if (this.#help.open) return this.#help.describe();
		const scroll = this.#scroll;
		if (this.#native && this.#native.scroll === scroll) return this.#native.node;
		const body: NativeNode = { ...col([this.#body], { role: "omp.report.body" }), key: "body", scroll };
		const node = col([body, actionBar([null, actionButton("Close", "close", { keys: "escape" })])], { gap: "md" });
		this.#native = { scroll, node };
		return node;
	}

	override invalidate(): void {
		this.#native = undefined;
		super.invalidate();
	}

	/**
	 * Focused (the native sheet, or the text-mode full-screen page): Esc closes;
	 * the arrow, page, Home and End keys and the wheel scroll the body.
	 */
	handleInput(data: string): void {
		if (this.#help.handleInput(data)) return;
		if (
			routeSgrMouseInput(data, event => {
				if (event.wheel === null) return false;
				this.#view.scroll(event.wheel * 3);
				return true;
			})
		) {
			return;
		}
		const action = this.#keys.read(data);
		if (!action || action === "pending") return;
		if (action.kind === "cancel") return this.#onClose();
		if (!this.#view.handleMenuAction(action)) return;
		const by = menuScrollBy(action);
		if (by) this.#scroll = { by, n: (this.#scroll?.n ?? 0) + 1 };
	}

	/** Close runs what Esc runs. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#help.open) {
			if (event.type === "action") this.#help.handleInput("\x1b");
			return;
		}
		if (event.type === "action" && event.act === "close") this.#onClose();
	}
}
