import {
	fitLayoutLine,
	type HeightConstrainedComponent,
	isLayoutComponent,
	isLayoutMouseRoutable,
	type LayoutContent,
	renderLayoutContent,
} from "../components/layout/geometry";
import { clampScrollOffset, scrollbarThumbRange, viewportRange } from "../components/scroll-viewport";
import type { MouseRoutable, SgrMouseEvent } from "../mouse";
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
	/** Rendered as a title-only row when true. */
	collapsed?: boolean;
	/** Section order; lower first. Ties keep registration order. */
	readonly order?: number;
}

/** Construction options for {@link SidePanel}. */
export interface SidePanelOptions {
	/** Called after any section change; the host maps it to ui.requestRender(). */
	onChange?: () => void;
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
}

/** What a document row belongs to, for hit-testing after scroll. */
interface DocumentRowTag {
	sectionId: string;
	kind: "title" | "body" | "gap";
	bodyRow: number;
}

const PLACEHOLDER_TAG: DocumentRowTag = { sectionId: "", kind: "gap", bodyRow: 0 };

/**
 * Docked side-panel content: registered sections laid out as one logical
 * document (title row, natural-height body, blank separator per section) and
 * shown through a scrolled viewport of exactly `height` rows. Knows nothing
 * about dock geometry; the composer places it.
 */
export class SidePanel implements HeightConstrainedComponent, MouseRoutable {
	readonly debugId = "side-panel";
	readonly #onChange: () => void;
	readonly #sections = new Map<string, RegisteredSection>();
	#nextSequence = 0;
	#height: number | undefined;
	#scrollOffset = 0;
	#documentRows = 0;
	#rowTags: readonly DocumentRowTag[] = [];
	#contentWidth = 0;

	constructor(options: SidePanelOptions = {}) {
		this.#onChange = options.onChange ?? (() => {});
	}

	/** Register or replace a section by id (keeping its place); returns an unregister function. */
	register(section: SidePanelSection): () => void {
		const existing = this.#sections.get(section.id);
		if (existing) {
			existing.section = section;
			existing.titleRows.invalidate();
		} else {
			this.#sections.set(section.id, { section, sequence: this.#nextSequence++, titleRows: new PanelRows() });
		}
		this.#onChange();
		return () => {
			if (this.#sections.get(section.id)?.section === section) this.unregister(section.id);
		};
	}

	/** Remove a section; its content stays owned by the caller. */
	unregister(id: string): void {
		if (!this.#sections.delete(id)) return;
		this.#onChange();
	}

	setCollapsed(id: string, collapsed: boolean): void {
		const entry = this.#sections.get(id);
		if (!entry || (entry.section.collapsed ?? false) === collapsed) return;
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
		const next = clampScrollOffset(offset, this.#documentRows, this.#height ?? this.#documentRows);
		if (next === this.#scrollOffset) return;
		this.#scrollOffset = next;
		this.#onChange();
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
		for (const entry of this.#ordered()) {
			const { section } = entry;
			const body = contentWidth > 0 ? renderLayoutContent(section.content, contentWidth, undefined) : [];
			// A section with nothing to show contributes no title either, so an
			// empty todo list leaves only the placeholder rather than a bare header.
			if (body.length === 0) continue;
			entry.titleRows.setLines([this.#titleLine(section, contentWidth)]);
			document.push(...entry.titleRows.render(contentWidth));
			tags.push({ sectionId: section.id, kind: "title", bodyRow: 0 });
			if (!section.collapsed) {
				for (let row = 0; row < body.length; row++) {
					document.push(body[row]!);
					tags.push({ sectionId: section.id, kind: "body", bodyRow: row });
				}
			}
			document.push("");
			tags.push({ sectionId: section.id, kind: "gap", bodyRow: 0 });
		}
		if (document.length === 0) {
			document.push(theme.fg("dim", truncateToWidth(PLACEHOLDER, contentWidth)));
			tags.push(PLACEHOLDER_TAG);
		}
		this.#documentRows = document.length;
		this.#rowTags = tags;
		const height = this.#height ?? document.length;
		this.#scrollOffset = clampScrollOffset(this.#scrollOffset, document.length, height);
		const range = viewportRange(document.length, height, this.#scrollOffset);
		const overflows = document.length > height;
		const thumb = overflows ? scrollbarThumbRange(height, document.length, this.#scrollOffset) : undefined;
		const lines: string[] = [];
		for (let row = 0; row < height; row++) {
			const index = range.start + row;
			const content = index < range.end ? (document[index] ?? "") : "";
			const gutter = thumb && row >= thumb.start && row < thumb.end ? theme.fg("border", THUMB) : TRACK;
			lines.push(safeWidth > 0 ? fitLayoutLine(content, contentWidth) + gutter : "");
		}
		return lines;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (event.wheel !== null) {
			this.scrollBy(event.wheel * WHEEL_ROWS);
			return;
		}
		// The scrollbar gutter is consumed without an action.
		if (col >= this.#contentWidth) return;
		const tag = this.#rowTags[line + this.#scrollOffset];
		if (!tag || tag.kind === "gap") return;
		const entry = this.#sections.get(tag.sectionId);
		if (!entry) return;
		if (tag.kind === "title") {
			if (event.leftClick) this.toggleCollapsed(tag.sectionId);
			return;
		}
		const content = entry.section.content;
		if (isLayoutMouseRoutable(content)) content.routeMouse(event, tag.bodyRow, col);
	}

	invalidate(): void {
		for (const entry of this.#sections.values()) {
			entry.titleRows.invalidate();
			if (isLayoutComponent(entry.section.content)) entry.section.content.invalidate?.();
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
