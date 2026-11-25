import {
	type Component,
	isKeyRelease,
	type KeybindingsManager,
	matchesKey,
	type OverlayHandle,
	isRightPress,
	type SgrMouseEvent,
	type TUI,
} from "@oh-my-pi/pi-tui";
import { SidePanel, SidePanelFullscreenComponent, type SidePanelSection } from "@oh-my-pi/pi-tui/chrome";
import { isLayoutComponent, type LayoutRect, layoutSize } from "@oh-my-pi/pi-tui/components/layout/geometry";
import { MenuHelp } from "@oh-my-pi/pi-tui/components/menu-hints";
import { applyMenuMotion, MenuKeyReader } from "@oh-my-pi/pi-tui/components/menu-navigation";
import type { Composer, SidePanelDock } from "@oh-my-pi/pi-tui/prompt/composer";
import { compositeLineAt } from "@oh-my-pi/pi-tui/render/composite";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { logger } from "@oh-my-pi/pi-utils";
import { t } from "@oh-my-pi/pi-utils/i18n";
import type { Settings } from "../../config/settings";
import {
	cfgSidebarEnabled,
	cfgSidebarSide,
	cfgSidebarSplitAt,
	cfgSidebarView,
	cfgSidebarWidthColumns,
	cfgSidebarWidthMax,
	cfgSidebarWidthMin,
	cfgSidebarWidthRatio,
} from "../settings";

/** What the panel shows: one view at a time. */
export type SidePanelView = "todo" | "agents" | "irc";

/** Tab / Shift+Tab and right-click cycle order. */
const VIEW_ORDER: readonly SidePanelView[] = ["todo", "agents", "irc"];
const DIGIT_KEYS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const CHORD_TIMEOUT_MS = 2000;

/** The two-digit percentage jump: the first digit waits briefly for the second. */
class PercentChord {
	#expires = 0;
	#first: number | undefined;

	start(first: number): void {
		this.#first = first;
		this.#expires = Date.now() + CHORD_TIMEOUT_MS;
	}

	take(): number | undefined {
		const first = Date.now() < this.#expires ? this.#first : undefined;
		this.clear();
		return first;
	}

	clear(): void {
		this.#first = undefined;
	}
}

/** A single printable key a view offers on its selected row, shown in the panel's key line. */
export interface SidePanelViewAction {
	readonly key: string;
	readonly label: string;
	run(): void;
}

interface SidePanelViewPopup {
	renderPopup(rowBudget: number): { title: string; rows: readonly string[]; firstRow: number };
	activatePopupRow(row: number): void;
}

/**
 * A view's section plus its keyboard surface. Views without a selection let
 * Up/Down scroll the panel instead.
 */
export interface SidePanelViewSection extends SidePanelSection {
	/** A click on panel space no row claims. */
	clickEmpty?(): void;
	/** Move the keyboard selection; false when the view has nothing to select. */
	moveSelection?(delta: number): boolean;
	/** Select the first or last row; false when the view has nothing to select. */
	selectEdge?(edge: "first" | "last"): boolean;
	clearSelection?(): void;
	/** Right / `l` / Enter: open the selected row in its dedicated viewer. */
	expand?(): void;
	/** The view's own keys; listed in the key line while the panel has focus. */
	actions?(): readonly SidePanelViewAction[];
	/** A view-owned mode (such as filter editing) that reads keys before panel navigation; true when consumed. */
	handleModeInput?(data: string, keys: MenuKeyReader, popupFits: boolean): boolean;
	/** Leave any view-owned mode. */
	resetMode?(): void;
	/** The view's floating popup; undefined while closed. */
	readonly popup?: SidePanelViewPopup | undefined;
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
/** Narrowest width a divider drag leaves the panel. */
const DRAG_MIN_WIDTH = 20;

/**
 * Owns the side panel: resolves the `sidebar.*` settings into dock options for
 * the composer (which alone measures and docks), mounts the section of the
 * active `sidebar.view`, opens the fullscreen form on narrow terminals, and
 * routes inline mouse reports that land outside the chat column. Keyboard
 * focus moves between the transcript and either form without changing the
 * active transcript.
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
	readonly #percentChord = new PercentChord();
	readonly #help: MenuHelp;
	#popupFits = false;
	#popupHit: { popup: SidePanelViewPopup; rect: LayoutRect; firstRow: number } | undefined;
	/** A divider drag in progress: the live panel width, and whether the pointer has moved it. */
	#drag: { width: number; moved: boolean } | undefined;

	constructor(host: SidePanelHost) {
		this.#host = host;
		this.#keys = new MenuKeyReader(host.keybindings);
		this.#help = new MenuHelp(undefined, () => t("overlays.side_panel.help"), this.#keys);
		this.#panel = new SidePanel({
			onChange: () => host.ui.requestRender(),
			onSecondaryClick: () => this.cycleView(1),
			onEmptyClick: () => this.#mounted?.clickEmpty?.(),
			onInput: data => this.#handlePanelInput(data),
			hints: () => this.#hints(),
			overlay: (lines, width) => this.#paintOverlay(lines, width),
			overlayMouse: (event, line, col) => this.#routeOverlayMouse(event, line, col),
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

	/** Whether the panel holds keyboard focus (docked) or is the active fullscreen overlay. */
	get active(): boolean {
		return this.fullscreenActive || this.#host.ui.getFocused() === this.#panel;
	}

	#shouldDock(): boolean {
		return this.#host.ui.terminal.columns >= this.#resolveDock().splitAt;
	}

	/**
	 * `app.sidebar.toggle` (Alt+T): open the panel with focus; with the panel
	 * open, move focus between it and the transcript. The narrow fullscreen
	 * form covers the transcript, so there returning focus closes it.
	 */
	toggleFocus(): void {
		if (this.fullscreenActive) {
			this.closeFullscreen();
			return;
		}
		if (this.#host.ui.getFocused() === this.#panel) {
			this.focusTranscript();
			return;
		}
		this.#openAndFocus();
	}

	/** Return keyboard focus to the transcript, leaving a docked panel open. */
	focusTranscript(): void {
		if (this.fullscreenActive) {
			this.closeFullscreen();
			return;
		}
		if (this.#host.ui.getFocused() !== this.#panel) return;
		this.#releaseDockFocus();
		this.#host.ui.requestRender();
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
		this.#focusDock();
	}

	#focusDock(): void {
		const { ui } = this.#host;
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

	/** `q`: close the panel (dock or fullscreen form) and return focus to the transcript. */
	close(): void {
		if (this.fullscreenOpen) {
			this.closeFullscreen();
			return;
		}
		this.#releaseDockFocus();
		if (!cfgSidebarEnabled.get(this.#host.settings)) return;
		cfgSidebarEnabled.set(this.#host.settings, false);
		this.applySettings();
	}

	#resetNavigation(): void {
		this.#keys.reset();
		if (this.#help.open) this.#help.handleInput("\x1b");
		this.#percentChord.clear();
		this.#mounted?.resetMode?.();
		this.#popupHit = undefined;
		this.#mounted?.clearSelection?.();
	}

	#handlePanelInput(data: string): void {
		if (data.startsWith("\x1b[<") || isKeyRelease(data)) return;
		const view = this.#mounted;
		if (this.#help.handleInput(data)) {
			this.#host.ui.requestRender();
			return;
		}
		if (view?.handleModeInput?.(data, this.#keys, this.#popupFits)) return;
		const first = this.#percentChord.take();
		const digit = DIGIT_KEYS.findIndex(key => matchesKey(data, key));
		if (digit >= 0) {
			this.#keys.reset();
			if (first === undefined) this.#percentChord.start(digit);
			else {
				view?.clearSelection?.();
				this.#panel.scrollToPercent(first * 10 + digit);
			}
			return;
		}
		if (data === "q") {
			this.#keys.reset();
			this.close();
			return;
		}
		const action = view?.actions?.().find(candidate => candidate.key === data);
		if (action) {
			this.#keys.reset();
			action.run();
			return;
		}
		const nav = this.#keys.read(data);
		if (nav === undefined || nav === "pending") return;
		switch (nav.kind) {
			case "cancel":
				this.focusTranscript();
				break;
			case "move":
				if (!view?.moveSelection?.(nav.delta)) this.scrollBy(nav.delta);
				break;
			case "boundary":
				if (!view?.selectEdge?.(nav.edge)) this.#panel.scrollToPercent(nav.edge === "first" ? 0 : 100);
				break;
			case "scroll":
				this.scrollBy(nav.delta);
				break;
			case "page":
			case "halfPage": {
				if (view?.itemIdAtRow && view.moveSelection) {
					applyMenuMotion(
						nav,
						{
							move: delta => view.moveSelection?.(delta) ?? false,
							moveToBoundary: edge => view.selectEdge?.(edge) ?? false,
						},
						{
							visibleItems: this.#panel.visibleItems(view),
							scroll: delta => this.scrollBy(delta),
							reveal: () => this.#panel.revealSelection(),
						},
					);
				} else {
					const height = this.#panel.viewportHeight;
					this.scrollBy(nav.delta * (nav.kind === "page" ? height : Math.max(1, Math.floor(height / 2))));
				}
				break;
			}
			case "horizontal":
				if (nav.delta < 0) this.focusTranscript();
				else view?.expand?.();
				break;
			case "confirm":
				view?.expand?.();
				break;
			case "context":
				this.cycleView(nav.delta);
				break;
		}
	}

	/** The panel's own keys only; navigation is the harness-wide menu keymap, behind `?`. */
	#hints(): readonly string[] {
		if (!this.active) return [];
		const actions = this.#mounted?.actions?.() ?? [];
		const parts = actions.map(action => `${theme.fg("accent", action.key)} ${theme.fg("dim", action.label)}`);
		parts.push(`${theme.fg("accent", "?")} ${theme.fg("dim", t("overlays.side_panel.action.help"))}`);
		return [parts.join(theme.fg("dim", " · "))];
	}

	/** The help card or the mounted view's popup, painted over the finished panel rows. */
	#paintOverlay(lines: readonly string[], width: number): readonly string[] {
		this.#popupHit = undefined;
		this.#popupFits = width >= 8 && lines.length >= 3;
		if (this.#help.open) return this.#help.render(lines, width);
		const popup = this.#mounted?.popup;
		if (!popup || !this.#popupFits) return lines;
		const { title: label, rows, firstRow } = popup.renderPopup(lines.length - 2);
		const inner = Math.min(width - 4, Math.max(visibleWidth(label) + 2, ...rows.map(row => visibleWidth(row))));
		const boxWidth = inner + 4;
		const border = (text: string) => theme.fg("border", text);
		const title = truncateToWidth(` ${label} `, boxWidth - 2);
		const box = [
			border(`┌${title}${"─".repeat(Math.max(0, boxWidth - 2 - visibleWidth(title)))}┐`),
			...rows.map(row => {
				const fitted = truncateToWidth(row, inner);
				return `${border("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${border("│")}`;
			}),
			border(`└${"─".repeat(boxWidth - 2)}┘`),
		];
		const result = [...lines];
		const top = Math.max(0, result.length - box.length - 2);
		const left = Math.max(0, Math.floor((width - boxWidth) / 2));
		this.#popupHit = {
			popup,
			rect: { row: top + 1, col: left + 1, height: rows.length, width: boxWidth - 2 },
			firstRow,
		};
		for (let i = 0; i < box.length; i++) {
			result[top + i] = compositeLineAt(result[top + i]!, box[i]!, left, boxWidth, width);
		}
		return result;
	}

	#routeOverlayMouse(event: SgrMouseEvent, line: number, col: number): boolean {
		if (this.#help.open) return true;
		const popup = this.#mounted?.popup;
		if (!popup) return false;
		const hit = this.#popupHit;
		if (event.leftClick && hit?.popup === popup) {
			const { rect } = hit;
			if (line >= rect.row && line < rect.row + rect.height && withinColumns(rect, col)) {
				popup.activatePopupRow(hit.firstRow + line - rect.row);
			}
		}
		return true;
	}

	/**
	 * Plain show/hide of the current view without moving focus (the
	 * keybinding-free action entry point): close the fullscreen form if it is
	 * open, else flip `sidebar.enabled` on a wide terminal, else open the
	 * fullscreen form. The narrow path never touches the setting.
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

	/** Show `view`, opening the panel (docked when wide, fullscreen when narrow) if it is hidden. */
	showView(view: SidePanelView): void {
		this.#selectView(view);
		if (this.fullscreenOpen) return;
		if (!this.#shouldDock()) {
			this.#openFullscreen();
			return;
		}
		if (cfgSidebarEnabled.get(this.#host.settings)) return;
		cfgSidebarEnabled.set(this.#host.settings, true);
		this.applySettings();
	}

	/** Tab / Shift+Tab or right-click: the next or previous view in Todo → Agents → IRC order. */
	cycleView(delta: number): void {
		const index = VIEW_ORDER.indexOf(this.view);
		const count = VIEW_ORDER.length;
		this.#selectView(VIEW_ORDER[(index + delta + count) % count]!);
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
		if (this.#drag !== undefined && this.#continueDrag(event)) return true;
		const viewport = ui.getMutableViewport();
		const geometry = composer.sidePanelGeometry();
		// An empty published viewport (resize, alt screen, deferred paint) means
		// the painted rows predate the geometry: route nothing.
		if (geometry === undefined || viewport.length === 0) return false;
		const local = event.row - viewport.top;
		if (local < 0 || local >= viewport.length) return false;
		if (event.col >= geometry.dividerCol && event.col < geometry.dividerCol + DIVIDER_WIDTH) {
			if (event.leftClick) this.#drag = { width: geometry.panelRect.width, moved: false };
			else if (isRightPress(event) && cfgSidebarWidthColumns.get(this.#host.settings) !== 0) {
				// Right-click on the divider returns to the ratio-based width.
				cfgSidebarWidthColumns.set(this.#host.settings, 0);
				this.applySettings();
			}
		}
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
			// A left click anywhere in the panel also gives it keyboard focus.
			if (event.leftClick && ui.getFocused() !== this.#panel && !ui.hasOverlay()) this.#focusDock();
			this.#panel.routeMouse(event, local - geometry.panelRect.row, event.col - geometry.panelRect.col);
		} else {
			// Divider or pad: no row is under the pointer.
			this.#panel.pointerLeave();
		}
		return true;
	}

	/**
	 * A left press on the divider started a drag: follow the pointer with a live
	 * width and keep it as `sidebar.width.columns` on release. Motion and the
	 * release are consumed wherever the pointer is. Any other report means the
	 * release was lost (it happened outside the terminal): the drag ends and the
	 * report routes normally (false).
	 */
	#continueDrag(event: SgrMouseEvent): boolean {
		const drag = this.#drag!;
		const geometry = this.#host.composer.sidePanelGeometry();
		if (!event.motion || event.release || (event.button & 3) !== 0 || geometry === undefined) {
			this.#drag = undefined;
			if (drag.moved && geometry !== undefined) cfgSidebarWidthColumns.set(this.#host.settings, drag.width);
			if (drag.moved) this.applySettings();
			return event.release;
		}
		const columns = this.#host.ui.terminal.columns;
		// The divider is ` │ `: its bar follows the pointer.
		const wanted = geometry.side === "right" ? columns - event.col - 2 : event.col - 1;
		const width = Math.max(DRAG_MIN_WIDTH, Math.min(columns - CHAT_MIN_WIDTH - DIVIDER_WIDTH, wanted));
		if (width !== drag.width) {
			drag.width = width;
			drag.moved = true;
			this.applySettings();
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
		const dragged = this.#drag?.moved ? this.#drag.width : layoutSize(cfgSidebarWidthColumns.get(settings));
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
		// A dragged width replaces the ratio and bounds; the split still leaves the chat its minimum.
		const width =
			dragged > 0 ? { fixed: Math.max(DRAG_MIN_WIDTH, dragged), min: DRAG_MIN_WIDTH } : { ratio, min, max };
		return {
			side: cfgSidebarSide.get(settings),
			width,
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
