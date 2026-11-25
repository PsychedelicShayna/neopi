import {
	fitLayoutLine,
	type HeightConstrainedComponent,
	isLayoutComponent,
	isLayoutMouseRoutable,
	type LayoutContent,
	renderLayoutContent,
} from "../components/layout/geometry";
import {
	clampScrollOffset,
	maxScrollOffset,
	scrollOffsetForRow,
	scrollbarThumbRange,
	viewportRange,
} from "../components/scroll-viewport";
import { matchesKey } from "../keys";
import { isRightPress, type MouseRoutable, type SgrMouseEvent } from "../mouse";
import { theme } from "../theme/index";
import type { Component } from "../tui";
import { truncateToWidth, visibleWidth } from "../utils";
import { PanelRows } from "./overlay-box";

/** One registered section of the docked panel. */
export interface SidePanelSection {
	/** Stable id used by consumers to update or remove the section. */
	readonly id: string;
	/** Title row text; rendered through `theme.fg("accent", …)` with a rule. */
	readonly title: string;
	/** Content at natural height. A component may also implement MouseRoutable. */
	readonly content: LayoutContent;
	/** Optional controls kept below the scrolling document. */
	readonly footer?: LayoutContent;
	/** Latest entry to reveal after rendering, with a key that changes on a new lifecycle event. */
	followTarget?(): PanelFollowTarget | undefined;
	/**
	 * Body rows of the keyboard selection. A new revision scrolls them into
	 * view; while a selection exists the follow target does not move the view.
	 */
	selectionTarget?(): PanelSelectionTarget | undefined;
	/** Stable menu item id covering a rendered body row, if the section supports selection. */
	itemIdAtRow?(row: number): string | undefined;
	/** Rendered as a title-only row when true. */
	collapsed?: boolean;
	/** Section order; lower first. Ties keep registration order. */
	readonly order?: number;
}

/** Construction options for {@link SidePanel}. */
export interface SidePanelOptions {
	/** Called after any section change; the host maps it to ui.requestRender(). */
	onChange?: () => void;
	/** Right-button press anywhere in the panel (the host cycles views). */
	onSecondaryClick?: () => void;
	/** Left click on panel space no section row claims: gaps, the placeholder, below the document. */
	onEmptyClick?: () => void;
	onInput?: (data: string) => void;
	/** Fixed text above the section controls, outside the scrollable document. */
	hints?: () => readonly string[];
	/** Paints floating content (a popup, the help card) over the finished panel rows. */
	overlay?: (lines: readonly string[], width: number) => readonly string[];
	/** Receives panel-local mouse events before the document, returning true when consumed. */
	overlayMouse?: (event: SgrMouseEvent, line: number, col: number) => boolean;
}

/** Section content that tracks the pointer and drops its hover when the pointer leaves the panel. */
export interface SidePanelPointerAware {
	pointerLeave(): void;
}

function isPointerAware(content: unknown): content is SidePanelPointerAware {
	return typeof (content as Partial<SidePanelPointerAware> | null)?.pointerLeave === "function";
}

/** Rows scrolled per wheel notch. */
const WHEEL_ROWS = 3;
const PLACEHOLDER = "nothing to show";
const TRACK = " ";
const THUMB = "┃";

interface RegisteredSection {
	section: SidePanelSection;
	/** Registration sequence; keeps ties in registration order across replacement. */
	sequence: number;
	titleRows: PanelRows;
	/**
	 * Whether the body had rows when it last rendered. A collapsed section
	 * renders no body (no wasted work, no render-time side effects), so its
	 * title-only row is kept or dropped by what the body last showed.
	 */
	hadRows: boolean;
}

/** What a document row belongs to, for hit-testing after scroll. */
interface DocumentRowTag {
	sectionId: string;
	kind: "title" | "body" | "gap" | "footer";
	bodyRow: number;
}

const PLACEHOLDER_TAG: DocumentRowTag = { sectionId: "", kind: "gap", bodyRow: 0 };

interface PanelFollowTarget {
	row: number;
	edge: "start" | "end";
	revision: string;
}

/** Body rows `[start, end)` of a section's keyboard selection. */
export interface PanelSelectionTarget {
	start: number;
	end: number;
	revision: string;
}

/**
 * Docked side-panel content: registered sections laid out as one logical
 * document (title row, natural-height body, blank separator per section) and
 * shown through a scrolled viewport of exactly `height` rows. Knows nothing
 * about dock geometry; the composer places it.
 */
export class SidePanel implements HeightConstrainedComponent, MouseRoutable {
	readonly debugId = "side-panel";
	readonly #onChange: () => void;
	readonly #onSecondaryClick: (() => void) | undefined;
	readonly #onEmptyClick: (() => void) | undefined;
	readonly #onInput: ((data: string) => void) | undefined;
	readonly #hints: SidePanelOptions["hints"];
	readonly #overlay: SidePanelOptions["overlay"];
	readonly #overlayMouse: SidePanelOptions["overlayMouse"];
	readonly #sections = new Map<string, RegisteredSection>();
	#nextSequence = 0;
	#height: number | undefined;
	#viewportHeight = 0;
	#footerTags: readonly DocumentRowTag[] = [];
	#followRevision: string | undefined;
	#followOffset: number | undefined;
	#selectionRevision: string | undefined;
	#scrollOffset = 0;
	#documentRows = 0;
	#rowTags: readonly DocumentRowTag[] = [];
	#contentWidth = 0;

	constructor(options: SidePanelOptions = {}) {
		this.#onChange = options.onChange ?? (() => {});
		this.#onSecondaryClick = options.onSecondaryClick;
		this.#onEmptyClick = options.onEmptyClick;
		this.#onInput = options.onInput;
		this.#hints = options.hints;
		this.#overlay = options.overlay;
		this.#overlayMouse = options.overlayMouse;
	}

	/** Register or replace a section by id (keeping its place); returns an unregister function. */
	register(section: SidePanelSection): () => void {
		const existing = this.#sections.get(section.id);
		if (existing) {
			if (existing.section.content !== section.content && isPointerAware(existing.section.content)) {
				existing.section.content.pointerLeave();
			}
			existing.section = section;
			existing.titleRows.invalidate();
		} else {
			this.#sections.set(section.id, {
				section,
				sequence: this.#nextSequence++,
				titleRows: new PanelRows(),
				hadRows: true,
			});
		}
		this.#onChange();
		return () => {
			if (this.#sections.get(section.id)?.section === section) this.unregister(section.id);
		};
	}

	/** Remove a section; its content stays owned by the caller. */
	unregister(id: string): void {
		const entry = this.#sections.get(id);
		if (!entry) return;
		if (isPointerAware(entry.section.content)) entry.section.content.pointerLeave();
		this.#sections.delete(id);
		this.#followRevision = undefined;
		this.#followOffset = undefined;
		this.#onChange();
	}

	setCollapsed(id: string, collapsed: boolean): void {
		const entry = this.#sections.get(id);
		if (!entry || (entry.section.collapsed ?? false) === collapsed) return;
		if (collapsed && isPointerAware(entry.section.content)) entry.section.content.pointerLeave();
		entry.section.collapsed = collapsed;
		this.#onChange();
	}

	toggleCollapsed(id: string): void {
		const entry = this.#sections.get(id);
		if (entry) this.setCollapsed(id, !(entry.section.collapsed ?? false));
	}

	/** Scroll the document; clamped to [0, maxScrollOffset]. */
	scrollBy(delta: number): void {
		this.scrollTo(this.#scrollOffset + delta);
	}

	scrollTo(offset: number): void {
		const next = clampScrollOffset(offset, this.#documentRows, this.#viewportHeight);
		if (next === this.#scrollOffset) return;
		this.pointerLeave();
		this.#scrollOffset = next;
		this.#onChange();
	}

	get viewportHeight(): number {
		return this.#viewportHeight;
	}

	/** Count items that intersect the viewport, including partially visible entries. */
	visibleItems(section: SidePanelSection): number {
		const range = viewportRange(this.#documentRows, this.#viewportHeight, this.#scrollOffset);
		let count = 0;
		let previous: string | undefined;
		for (let row = range.start; row < range.end; row++) {
			const tag = this.#rowTags[row];
			if (tag?.kind !== "body" || tag.sectionId !== section.id) continue;
			const id = section.itemIdAtRow?.(tag.bodyRow);
			if (id !== undefined && id !== previous) count++;
			previous = id;
		}
		return Math.max(1, count);
	}

	/** Reveal on the next layout even if a motion clamped at the current selection. */
	revealSelection(): void {
		this.#selectionRevision = undefined;
		this.#onChange();
	}

	scrollToPercent(percent: number): void {
		this.scrollTo(Math.round((maxScrollOffset(this.#documentRows, this.#viewportHeight) * percent) / 100));
	}

	capturesInput(data: string): boolean {
		return this.#onInput !== undefined && matchesKey(data, "ctrl+c");
	}

	handleInput(data: string): void {
		this.#onInput?.(data);
	}

	get scrollOffset(): number {
		return this.#scrollOffset;
	}

	/** Total document rows from the last render (sections + titles + separators). */
	get documentRows(): number {
		return this.#documentRows;
	}

	get sections(): readonly SidePanelSection[] {
		return this.#ordered().map(entry => entry.section);
	}

	setHeight(height: number | undefined): void {
		this.#height = height === undefined ? undefined : Math.max(0, Math.trunc(height));
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(0, Math.trunc(width));
		// The last column is the scrollbar gutter, reserved even when nothing
		// overflows so content never reflows as the document crosses the height.
		const contentWidth = Math.max(0, safeWidth - 1);
		this.#contentWidth = contentWidth;
		const document: string[] = [];
		const tags: DocumentRowTag[] = [];
		const footer = [...(this.#hints?.() ?? [])];
		const footerTags: DocumentRowTag[] = footer.map(() => PLACEHOLDER_TAG);
		let follow: PanelFollowTarget | undefined;
		let selection: PanelSelectionTarget | undefined;
		for (const entry of this.#ordered()) {
			const { section } = entry;
			if (section.footer && contentWidth > 0) {
				const lines = renderLayoutContent(section.footer, contentWidth, undefined);
				for (let row = 0; row < lines.length; row++) {
					footer.push(lines[row]!);
					footerTags.push({ sectionId: section.id, kind: "footer", bodyRow: row });
				}
			}
			let body: readonly string[] = [];
			if (!section.collapsed) {
				body = contentWidth > 0 ? renderLayoutContent(section.content, contentWidth, undefined) : [];
				entry.hadRows = body.length > 0;
			}
			// A section with nothing to show contributes no title either, so an
			// empty todo list leaves only the placeholder rather than a bare header.
			if (!entry.hadRows) continue;
			entry.titleRows.setLines([this.#titleLine(section, contentWidth)]);
			document.push(...entry.titleRows.render(contentWidth));
			tags.push({ sectionId: section.id, kind: "title", bodyRow: 0 });
			const target = section.collapsed ? undefined : section.followTarget?.();
			if (target) follow = { ...target, row: document.length + target.row };
			const chosen = section.collapsed ? undefined : section.selectionTarget?.();
			if (chosen) {
				selection = {
					start: document.length + chosen.start,
					end: document.length + chosen.end,
					revision: chosen.revision,
				};
			}
			for (let row = 0; row < body.length; row++) {
				document.push(body[row]!);
				tags.push({ sectionId: section.id, kind: "body", bodyRow: row });
			}
			// Fixed controls already separate the document from the panel below.
			if (!section.footer) {
				document.push("");
				tags.push({ sectionId: section.id, kind: "gap", bodyRow: 0 });
			}
		}
		if (document.length === 0) {
			document.push(theme.fg("dim", truncateToWidth(PLACEHOLDER, contentWidth)));
			tags.push(PLACEHOLDER_TAG);
		}
		this.#documentRows = document.length;
		this.#rowTags = tags;
		const height = this.#height ?? document.length + footer.length;
		const footerStart = Math.max(0, footer.length - height);
		const bodyHeight = Math.max(0, height - footer.length);
		this.#viewportHeight = bodyHeight;
		this.#footerTags = footerTags.slice(footerStart);
		if (selection) {
			// The keyboard selection owns the view: reveal it when it moves, and let
			// autoscroll wait until the selection is cleared.
			if (selection.revision !== this.#selectionRevision) {
				const last = Math.max(selection.start, selection.end - 1);
				let offset = scrollOffsetForRow(this.#scrollOffset, last, document.length, bodyHeight);
				offset = scrollOffsetForRow(offset, selection.start, document.length, bodyHeight);
				this.#scrollOffset = offset;
			}
			this.#selectionRevision = selection.revision;
			this.#followOffset = undefined;
			this.#followRevision = follow?.revision;
		} else if (follow) {
			const offset = scrollOffsetForRow(this.#scrollOffset, follow.row, document.length, bodyHeight, follow.edge);
			if (follow.revision !== this.#followRevision || this.#scrollOffset === this.#followOffset) {
				this.#scrollOffset = offset;
			}
			this.#followOffset = offset;
			this.#followRevision = follow.revision;
		} else {
			this.#followOffset = undefined;
			this.#followRevision = undefined;
		}
		if (!selection) this.#selectionRevision = undefined;
		this.#scrollOffset = clampScrollOffset(this.#scrollOffset, document.length, bodyHeight);
		const range = viewportRange(document.length, bodyHeight, this.#scrollOffset);
		const thumb =
			document.length > bodyHeight
				? scrollbarThumbRange(bodyHeight, document.length, this.#scrollOffset)
				: undefined;
		const lines: string[] = [];
		for (let row = 0; row < bodyHeight; row++) {
			const index = range.start + row;
			const content = index < range.end ? (document[index] ?? "") : "";
			const gutter = thumb && row >= thumb.start && row < thumb.end ? theme.fg("border", THUMB) : TRACK;
			lines.push(safeWidth > 0 ? fitLayoutLine(content, contentWidth) + gutter : "");
		}
		for (let row = footerStart; row < footer.length; row++) {
			lines.push(fitLayoutLine(footer[row]!, contentWidth) + TRACK);
		}
		return this.#overlay ? this.#overlay(lines, safeWidth) : lines;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#overlayMouse?.(event, line, col)) return;
		if (event.wheel !== null) {
			this.scrollBy(event.wheel * WHEEL_ROWS);
			return;
		}
		if (isRightPress(event)) {
			this.#onSecondaryClick?.();
			return;
		}
		// The scrollbar gutter has no row target.
		if (col < 0 || col >= this.#contentWidth) {
			if (event.motion) this.pointerLeave();
			return;
		}
		const tag =
			line >= this.#viewportHeight
				? this.#footerTags[line - this.#viewportHeight]
				: this.#rowTags[line + this.#scrollOffset];
		const entry = tag && tag.kind !== "gap" ? this.#sections.get(tag.sectionId) : undefined;
		if (!tag || !entry) {
			// Motion over empty space is a pointer leaving every section.
			if (event.motion) this.pointerLeave();
			else if (event.leftClick) this.#onEmptyClick?.();
			return;
		}
		if (tag.kind === "title") {
			if (event.motion) this.pointerLeave();
			if (event.leftClick) this.toggleCollapsed(tag.sectionId);
			return;
		}
		const content = tag.kind === "footer" ? entry.section.footer : entry.section.content;
		if (event.motion) {
			if (tag.kind === "footer") this.pointerLeave();
			for (const other of this.#sections.values()) {
				if (other !== entry && isPointerAware(other.section.content)) other.section.content.pointerLeave();
			}
		}
		if (content !== undefined && isLayoutMouseRoutable(content)) content.routeMouse(event, tag.bodyRow, col);
	}

	/** The pointer left the panel (or crossed onto non-section rows): sections drop hover state. */
	pointerLeave(): void {
		for (const entry of this.#sections.values()) {
			if (isPointerAware(entry.section.content)) entry.section.content.pointerLeave();
		}
	}

	invalidate(): void {
		for (const entry of this.#sections.values()) {
			entry.titleRows.invalidate();
			if (isLayoutComponent(entry.section.content)) entry.section.content.invalidate?.();
			if (entry.section.footer && isLayoutComponent(entry.section.footer)) entry.section.footer.invalidate?.();
		}
	}

	dispose(): void {
		for (const entry of this.#sections.values()) {
			if (isLayoutComponent(entry.section.content)) entry.section.content.dispose?.();
		}
	}

	/** Concrete section components exposed to the debug tree. */
	get debugChildren(): readonly Component[] {
		const children: Component[] = [];
		for (const entry of this.#ordered()) {
			if (isLayoutComponent(entry.section.content)) children.push(entry.section.content);
		}
		return children;
	}

	#ordered(): RegisteredSection[] {
		return [...this.#sections.values()].sort(
			(left, right) => (left.section.order ?? 0) - (right.section.order ?? 0) || left.sequence - right.sequence,
		);
	}

	#titleLine(section: SidePanelSection, width: number): string {
		const title = truncateToWidth(section.title, Math.max(0, width - 2));
		const rule = Math.max(0, width - visibleWidth(title) - 1);
		return `${theme.bold(theme.fg("accent", title))} ${theme.fg("border", theme.boxRound.horizontal.repeat(rule))}`;
	}
}
