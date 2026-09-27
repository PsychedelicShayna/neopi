import type { KeybindingsManager, OverlayHandle, SgrMouseEvent, TUI } from "@oh-my-pi/pi-tui";
import { SidePanel, SidePanelFullscreenComponent, type SidePanelSection } from "@oh-my-pi/pi-tui/chrome";
import type { LayoutRect } from "@oh-my-pi/pi-tui/components/layout/geometry";
import type { Composer, SidePanelDock } from "@oh-my-pi/pi-tui/prompt/composer";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import {
	cfgSidebarEnabled,
	cfgSidebarSide,
	cfgSidebarSplitAt,
	cfgSidebarWidthMax,
	cfgSidebarWidthMin,
	cfgSidebarWidthRatio,
} from "../settings";

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
 * the composer (which alone measures and docks), opens the fullscreen form on
 * narrow terminals, and routes inline mouse reports that land outside the chat
 * column. Display-only: the panel never takes keyboard focus.
 */
export class SidePanelController {
	readonly #host: SidePanelHost;
	readonly #panel: SidePanel;
	#fullscreen: OverlayHandle | undefined;
	#fullscreenComponent: SidePanelFullscreenComponent | undefined;

	constructor(host: SidePanelHost) {
		this.#host = host;
		this.#panel = new SidePanel({ onChange: () => host.ui.requestRender() });
	}

	/** Apply settings; called at init and from InteractiveMode's settings-change dispatch. */
	applySettings(): void {
		const enabled = cfgSidebarEnabled.get(this.#host.settings);
		if (!enabled) {
			this.#host.composer.setSidePanel(undefined);
			return;
		}
		this.#host.composer.setSidePanel(this.#panel, this.#resolveDock());
	}

	/** Whether the last composed frame docked the panel. */
	get docked(): boolean {
		return this.#host.composer.sidePanelDocked;
	}

	/**
	 * `app.sidebar.toggle`: close the fullscreen form if it is open (whatever
	 * the width now is), else flip `sidebar.enabled` on a wide terminal, else
	 * open the fullscreen form. The narrow path never touches the setting.
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
		const component = new SidePanelFullscreenComponent({
			panel: this.#panel,
			onClose: () => this.closeFullscreen(),
			toggleKeys: this.#host.keybindings.getKeys("app.sidebar.toggle"),
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

	register(section: SidePanelSection): () => void {
		return this.#panel.register(section);
	}

	unregister(id: string): void {
		this.#panel.unregister(id);
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
		if (withinColumns(geometry.chatRect, event.col)) return false;
		// Leaving the chat column drops the hovered card's band. The consumed
		// event reaches no other repaint, so repaint here — only when a band
		// was actually showing, never for plain motion over the panel.
		if (composer.hoveredClickId !== undefined) {
			composer.setHoveredClickId(undefined);
			ui.requestRender();
		}
		if (withinColumns(geometry.panelRect, event.col)) {
			this.#panel.routeMouse(event, local - geometry.panelRect.row, event.col - geometry.panelRect.col);
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
		this.#panel.dispose();
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
		let min = cfgSidebarWidthMin.get(settings);
		let max = cfgSidebarWidthMax.get(settings);
		if (min > max) {
			this.#warnInvalid(cfgSidebarWidthMin.id, { min, max }, "sidebar.width.min exceeds sidebar.width.max");
			min = cfgSidebarWidthMin.default;
			max = cfgSidebarWidthMax.default;
		}
		let splitAt = cfgSidebarSplitAt.get(settings);
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
