import {
	type Component,
	isKeyRelease,
	type KeybindingsManager,
	type KeyId,
	matchesKey,
	type OverlayHandle,
	type SgrMouseEvent,
	type TUI,
} from "@oh-my-pi/pi-tui";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { SidePanel, SidePanelFullscreenComponent, type SidePanelSection } from "@oh-my-pi/pi-tui/chrome";
import { isLayoutComponent, type LayoutRect, layoutSize } from "@oh-my-pi/pi-tui/components/layout/geometry";
import { getMenuSearchVimMode, MenuKeyReader } from "@oh-my-pi/pi-tui/components/menu-navigation";
import type { Composer, SidePanelDock } from "@oh-my-pi/pi-tui/prompt/composer";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { logger } from "@oh-my-pi/pi-utils";
import { t } from "@oh-my-pi/pi-utils/i18n";
import type { Settings } from "../../config/settings";
import {
	cfgSidebarEnabled,
	cfgSidebarSide,
	cfgSidebarSplitAt,
	cfgSidebarView,
	cfgSidebarWidthMax,
	cfgSidebarWidthMin,
	cfgSidebarWidthRatio,
} from "../settings";

/** What the panel shows: one view at a time. */
export type SidePanelView = "todo" | "agents" | "irc";

/** Right-click cycle order. */
const VIEW_ORDER: readonly SidePanelView[] = ["todo", "agents", "irc"];
const VIEW_KEYS: readonly (readonly [SidePanelView, readonly KeyId[]])[] = [
	["todo", ["t", "alt+t"]],
	["agents", ["a", "alt+a"]],
	["irc", ["i", "alt+i"]],
];
const DIGIT_KEYS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const CHORD_TIMEOUT_MS = 2000;

/** The view and percentage chords share expiry and consume only the next key press. */
class SidebarChord<T> {
	#expires = 0;
	#first: T | undefined;

	start(first: T): void {
		this.#first = first;
		this.#expires = Date.now() + CHORD_TIMEOUT_MS;
	}

	take(data: string): T | undefined {
		if (data.startsWith("\x1b[<") || isKeyRelease(data)) return undefined;
		const first = Date.now() < this.#expires ? this.#first : undefined;
		this.clear();
		return first;
	}

	clear(): void {
		this.#first = undefined;
	}
}

/** A view's section, plus what a click on empty panel space does while it shows. */
export interface SidePanelViewSection extends SidePanelSection {
	clickEmpty?(): void;
	moveControl?(delta: number): void;
	toggleControl?(): void;
	resetControl?(): void;
}

/** What the controller needs from its interactive host. */
export interface SidePanelHost {
	readonly ui: TUI;
	readonly composer: Composer;
	readonly settings: Settings;
	readonly keybindings: KeybindingsManager;
}

/** Content width reserved for the chat column while docked. */
const CHAT_MIN_WIDTH = 60;
/** Columns the composer's ` │ ` divider occupies. */
const DIVIDER_WIDTH = 3;
const RATIO_BOUNDS = { min: 0.1, max: 0.6 } as const;

/**
 * Owns the side panel: resolves the `sidebar.*` settings into dock options for
 * the composer (which alone measures and docks), mounts the section of the
 * active `sidebar.view`, opens the fullscreen form on narrow terminals, and
 * routes inline mouse reports that land outside the chat column. Keyboard
 * focus can move to either form without changing the active transcript.
 */
export class SidePanelController {
	readonly #host: SidePanelHost;
	readonly #panel: SidePanel;
	readonly #views = new Map<SidePanelView, SidePanelViewSection>();
	#mounted: SidePanelViewSection | undefined;
	#fullscreen: OverlayHandle | undefined;
	#fullscreenComponent: SidePanelFullscreenComponent | undefined;
	#previousFocus: Component | null = null;
	readonly #keys: MenuKeyReader;
	readonly #viewChord = new SidebarChord<{ wasOpen: boolean }>();
	readonly #percentChord = new SidebarChord<number>();

	constructor(host: SidePanelHost) {
		this.#host = host;
		this.#keys = new MenuKeyReader(host.keybindings);
		this.#panel = new SidePanel({
			onChange: () => host.ui.requestRender(),
			onSecondaryClick: () => this.cycleView(),
			onEmptyClick: () => this.#mounted?.clickEmpty?.(),
			onInput: data => this.#handlePanelInput(data),
			hints: () => this.#hints(),
		});
	}

	/** Apply settings; called at init and from InteractiveMode's settings-change dispatch. */
	applySettings(): void {
		this.#mountActiveView();
		const enabled = cfgSidebarEnabled.get(this.#host.settings);
		if (!enabled) {
			this.#releaseDockFocus();
			if (!this.fullscreenOpen) this.#panel.pointerLeave();
			this.#host.composer.setSidePanel(undefined);
			return;
		}
		this.#host.composer.setSidePanel(this.#panel, this.#resolveDock());
	}

	/** The view `sidebar.view` selects, shown whenever the panel is. */
	get view(): SidePanelView {
		return cfgSidebarView.get(this.#host.settings);
	}

	/**
	 * The view the last composed frame docked beside the chat, or undefined
	 * when nothing is docked. The transcript hides its own copy of exactly this
	 * view (the todo HUD, the pinned subagents list) for that frame.
	 */
	get dockedView(): SidePanelView | undefined {
		return this.docked ? this.view : undefined;
	}

	/** Whether the last composed frame docked the panel. */
	get docked(): boolean {
		return this.#host.composer.sidePanelDocked;
	}

	get visible(): boolean {
		return this.fullscreenOpen || this.docked;
	}

	get active(): boolean {
		return this.fullscreenActive || this.#host.ui.getFocused() === this.#panel;
	}

	#shouldDock(): boolean {
		return this.#host.ui.terminal.columns >= this.#resolveDock().splitAt;
	}

	/** Open or focus the remembered view immediately; a following t/a/i can switch views. */
	openWithChord(): void {
		const wasOpen = this.fullscreenOpen || (this.#shouldDock() && cfgSidebarEnabled.get(this.#host.settings));
		this.#openAndFocus();
		this.#viewChord.start({ wasOpen });
	}

	handleChordInput(data: string): boolean {
		const pending = this.#viewChord.take(data);
		if (!pending || (this.#host.ui.hasOverlay() && !this.fullscreenActive)) return false;
		for (const [view, keys] of VIEW_KEYS) {
			if (!keys.some(key => matchesKey(data, key))) continue;
			if (pending.wasOpen && view === this.view) this.#closeFocused();
			else {
				this.#selectView(view);
				this.#openAndFocus();
			}
			return true;
		}
		return false;
	}

	#openAndFocus(): void {
		const { ui, settings } = this.#host;
		if (this.fullscreenOpen) {
			ui.requestRender();
			return;
		}
		if (!this.#shouldDock()) {
			this.#releaseDockFocus();
			this.#openFullscreen();
			return;
		}
		if (!cfgSidebarEnabled.get(settings)) {
			cfgSidebarEnabled.set(settings, true);
			this.applySettings();
		}
		if (ui.getFocused() !== this.#panel) {
			this.#previousFocus = ui.getFocused();
			ui.setFocus(this.#panel);
		}
		ui.requestRender();
	}

	#releaseDockFocus(): void {
		const { ui } = this.#host;
		if (ui.getFocused() === this.#panel) ui.setFocus(this.#previousFocus);
		this.#previousFocus = null;
		this.#resetNavigation();
	}

	#closeFocused(): void {
		if (this.fullscreenActive) this.closeFullscreen();
		else if (this.#host.ui.getFocused() === this.#panel) {
			this.#releaseDockFocus();
			cfgSidebarEnabled.set(this.#host.settings, false);
			this.applySettings();
		}
	}

	#resetNavigation(): void {
		this.#keys.reset();
		this.#viewChord.clear();
		this.#percentChord.clear();
		this.#mounted?.resetControl?.();
	}

	#handlePanelInput(data: string): void {
		if (data.startsWith("\x1b[<") || isKeyRelease(data)) return;
		const first = this.#percentChord.take(data);
		const digit = DIGIT_KEYS.findIndex(key => matchesKey(data, key));
		if (digit >= 0) {
			this.#keys.reset();
			if (first === undefined) this.#percentChord.start(digit);
			else this.#panel.scrollToPercent(first * 10 + digit);
			return;
		}
		const action = this.#keys.read(data);
		if (action === undefined || action === "pending") return;
		switch (action.kind) {
			case "cancel":
				this.#closeFocused();
				break;
			case "move":
			case "scroll":
				this.scrollBy(action.delta);
				break;
			case "page":
				this.scrollBy(action.delta * this.#panel.viewportHeight);
				break;
			case "halfPage":
				this.scrollBy(action.delta * Math.max(1, Math.floor(this.#panel.viewportHeight / 2)));
				break;
			case "boundary":
				this.#panel.scrollToPercent(action.edge === "first" ? 0 : 100);
				break;
			case "context":
				this.#mounted?.moveControl?.(action.delta);
				break;
			case "toggle":
			case "confirm":
				this.#mounted?.toggleControl?.();
				break;
		}
	}

	#hints(): readonly string[] {
		if (!this.active) return [];
		const [key] = this.#host.keybindings.getKeys("app.sidebar.toggle");
		const prefix = key === undefined ? t("overlays.side_panel.views_prefix") : `${formatKeyHint(key)} →`;
		return [
			theme.bold(theme.fg("accent", t("overlays.side_panel.views_hint", { prefix }))),
			theme.fg("text", t("overlays.side_panel.navigation_hint")),
			...(getMenuSearchVimMode() ? [theme.fg("text", "j/k · C-u/d · C-e/y · gg/G")] : []),
			...(this.#mounted?.moveControl ? [theme.fg("text", t("overlays.side_panel.filters_hint"))] : []),
		];
	}

	/**
	 * Plain show/hide of the current view: close the fullscreen form if it is
	 * open (whatever the width now is), else flip `sidebar.enabled` on a wide
	 * terminal, else open the fullscreen form. The narrow path never touches
	 * the setting. The `alt+t` chords go through {@link showView}.
	 */
	toggle(): void {
		if (this.fullscreenOpen) {
			this.closeFullscreen();
			return;
		}
		const { ui, settings } = this.#host;
		if (ui.terminal.columns >= this.#resolveDock().splitAt) {
			cfgSidebarEnabled.set(settings, !cfgSidebarEnabled.get(settings));
			this.applySettings();
			return;
		}
		this.#openFullscreen();
	}

	/**
	 * An `alt+t` chord: show `view`. From hidden it opens the panel on that
	 * view (docked when wide, fullscreen when narrow); with another view shown
	 * it switches; with `view` already shown it hides the panel.
	 */
	showView(view: SidePanelView): void {
		const { ui, settings } = this.#host;
		if (this.fullscreenOpen) {
			if (view === this.view) this.closeFullscreen();
			else this.#selectView(view);
			return;
		}
		if (ui.terminal.columns >= this.#resolveDock().splitAt) {
			const hide = cfgSidebarEnabled.get(settings) && view === this.view;
			this.#selectView(view);
			cfgSidebarEnabled.set(settings, !hide);
			this.applySettings();
			return;
		}
		this.#selectView(view);
		this.#openFullscreen();
	}

	/** Right-click in the panel: the next view in Todo → Agents → IRC order. */
	cycleView(): void {
		const index = VIEW_ORDER.indexOf(this.view);
		this.#selectView(VIEW_ORDER[(index + 1) % VIEW_ORDER.length]!);
	}

	#selectView(view: SidePanelView): void {
		if (view === this.view) return;
		cfgSidebarView.set(this.#host.settings, view);
		this.#mountActiveView();
	}

	/** Keep exactly the active view's section registered with the panel. */
	#mountActiveView(): void {
		const section = this.#views.get(this.view);
		if (section === this.#mounted) return;
		if (this.#mounted) {
			this.#panel.pointerLeave();
			this.#panel.unregister(this.#mounted.id);
		}
		this.#mounted = section;
		this.#panel.scrollTo(0);
		if (section) this.#panel.register(section);
	}

	#openFullscreen(): void {
		const { ui } = this.#host;
		const component = new SidePanelFullscreenComponent({
			panel: this.#panel,
			rows: () => ui.terminal.rows,
		});
		this.#fullscreenComponent = component;
		this.#fullscreen = ui.showOverlay(component, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
			mouseTracking: true,
		});
	}

	/** Idempotent: hide exactly the controller's fullscreen overlay (if any) and clear its handle. */
	closeFullscreen(): void {
		const handle = this.#fullscreen;
		this.#fullscreen = undefined;
		this.#fullscreenComponent = undefined;
		this.#panel.pointerLeave();
		this.#resetNavigation();
		handle?.hide();
	}

	get fullscreenOpen(): boolean {
		return this.#fullscreen !== undefined;
	}

	/**
	 * Whether the fullscreen form is open and is the active overlay (holds
	 * focus). A dialog stacked above it keeps its own keys, the toggle included.
	 */
	get fullscreenActive(): boolean {
		return this.#fullscreenComponent !== undefined && this.#host.ui.getFocused() === this.#fullscreenComponent;
	}

	scrollBy(delta: number): void {
		this.#panel.scrollBy(delta);
	}

	/** Register the section `view` shows (replacing an earlier one); mounted at once when `view` is active. */
	registerView(view: SidePanelView, section: SidePanelViewSection): void {
		const previous = this.#views.get(view);
		this.#views.set(view, section);
		if (previous !== undefined && previous === this.#mounted) {
			this.#panel.unregister(previous.id);
			this.#mounted = undefined;
		}
		this.#mountActiveView();
	}

	/**
	 * Inline mouse (`tui.mouse`): true when the report landed on the panel,
	 * divider, or pad and was consumed; false for the chat column or when no
	 * docked frame is on screen, so row routing continues.
	 */
	routeInlineMouse(event: SgrMouseEvent): boolean {
		const { ui, composer } = this.#host;
		const viewport = ui.getMutableViewport();
		const geometry = composer.sidePanelGeometry();
		// An empty published viewport (resize, alt screen, deferred paint) means
		// the painted rows predate the geometry: route nothing.
		if (geometry === undefined || viewport.length === 0) return false;
		const local = event.row - viewport.top;
		if (local < 0 || local >= viewport.length) return false;
		if (withinColumns(geometry.chatRect, event.col)) {
			if (event.leftClick && ui.getFocused() === this.#panel) {
				this.#releaseDockFocus();
				ui.requestRender();
			}
			this.#panel.pointerLeave();
			return false;
		}
		// Leaving the chat column drops the hovered card's band. The consumed
		// event reaches no other repaint, so repaint here — only when a band
		// was actually showing, never for plain motion over the panel.
		if (composer.hoveredClickId !== undefined) {
			composer.setHoveredClickId(undefined);
			ui.requestRender();
		}
		if (withinColumns(geometry.panelRect, event.col)) {
			this.#panel.routeMouse(event, local - geometry.panelRect.row, event.col - geometry.panelRect.col);
		} else {
			// Divider or pad: no row is under the pointer.
			this.#panel.pointerLeave();
		}
		return true;
	}

	/** Theme/glyph change: invalidate the panel and its sections. */
	invalidate(): void {
		this.#panel.invalidate();
	}

	/**
	 * Teardown, after the TUI's stop flush has retired the tail at the docked
	 * width: undock without a history refresh (a quit must never clear
	 * scrollback) and without requesting a render.
	 */
	dispose(): void {
		this.closeFullscreen();
		this.#releaseDockFocus();
		this.#panel.dispose();
		// Sections of hidden views are not registered with the panel; release them too.
		for (const section of this.#views.values()) {
			if (section !== this.#mounted && isLayoutComponent(section.content)) section.content.dispose?.();
		}
		this.#host.composer.setSidePanel(undefined, undefined, { refreshHistory: false });
	}

	/** Dock options from settings, with out-of-range values warned once and replaced by defaults. */
	#resolveDock(): SidePanelDock {
		const settings = this.#host.settings;
		let ratio = cfgSidebarWidthRatio.get(settings);
		if (ratio < RATIO_BOUNDS.min || ratio > RATIO_BOUNDS.max) {
			this.#warnInvalid(cfgSidebarWidthRatio.id, ratio, `outside [${RATIO_BOUNDS.min}, ${RATIO_BOUNDS.max}]`);
			ratio = cfgSidebarWidthRatio.default;
		}
		// Whole columns, normalized once with the helper SplitPane itself uses,
		// so the toggle's wide/narrow decision and the split's own eligibility
		// read the same numbers (60.9 must not demand 124 columns here while the
		// split docks at 123).
		let min = layoutSize(cfgSidebarWidthMin.get(settings));
		let max = layoutSize(cfgSidebarWidthMax.get(settings));
		// Each bound must be a positive column count on its own: SplitPane
		// normalizes a non-positive one to 0, which passes min <= max yet leaves
		// the panel nothing but its divider.
		if (min < 1 || max < 1) {
			this.#warnInvalid(
				cfgSidebarWidthMin.id,
				{ min, max },
				"sidebar.width.min and sidebar.width.max must be positive",
			);
			min = cfgSidebarWidthMin.default;
			max = cfgSidebarWidthMax.default;
		} else if (min > max) {
			this.#warnInvalid(cfgSidebarWidthMin.id, { min, max }, "sidebar.width.min exceeds sidebar.width.max");
			min = cfgSidebarWidthMin.default;
			max = cfgSidebarWidthMax.default;
		}
		let splitAt = layoutSize(cfgSidebarSplitAt.get(settings));
		const smallest = min + CHAT_MIN_WIDTH + DIVIDER_WIDTH;
		if (splitAt < smallest) {
			this.#warnInvalid(cfgSidebarSplitAt.id, splitAt, `below the ${smallest} columns a dock needs`);
			// The default may be too small for custom minimums as well; the
			// threshold must admit both panes, or a wide toggle would enable a
			// dock the split can never show and never offer the fullscreen form.
			splitAt = Math.max(cfgSidebarSplitAt.default, smallest);
		}
		return {
			side: cfgSidebarSide.get(settings),
			width: { ratio, min, max },
			splitAt,
			chatMinWidth: CHAT_MIN_WIDTH,
		};
	}

	/** Warn once per offending value, through the settings instance's warn-once diagnostics. */
	#warnInvalid(id: string, value: unknown, reason: string): void {
		const warned = this.#host.settings.warnState.invalid;
		if (warned.has(id) && Bun.deepEquals(warned.get(id), value)) return;
		warned.set(id, value);
		logger.warn("Settings: ignoring out-of-range value, using the default", { setting: id, value, reason });
	}
}

function withinColumns(rect: LayoutRect, col: number): boolean {
	return col >= rect.col && col < rect.col + rect.width;
}
