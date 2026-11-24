import type { MouseRoutable, SgrMouseEvent } from "@oh-my-pi/pi-tui";
import type { SidePanelPointerAware } from "@oh-my-pi/pi-tui/chrome";
import { modelChip, statusGlyph } from "@oh-my-pi/pi-tui/overlays/agent-hub-renderer";
import type { AgentRecordLike, AgentStatus } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import { agentColored } from "@oh-my-pi/pi-tui/overlays/agent-identity";
import { sanitizeDisplaySingleLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import type { ObservableSession } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { SidePanelViewSection } from "../controllers/side-panel-controller";
import { cfgSidebarAgentAutoscroll, cfgSidebarAgentFilters, cfgSidebarAgentOrder } from "../settings";

/** What the agents section needs from its host. */
export interface AgentsSectionHost {
	settings: Settings;
	/** This UI's roster, already scoped to its root (the Agent Hub's list). */
	agents(): readonly AgentRecordLike[];
	observed(id: string): ObservableSession | undefined;
	/** A live repaint tick is needed only while this section is on screen. */
	visible(): boolean;
	/** The agent whose transcript the main area shows, or undefined for the primary session. */
	focusedAgentId(): string | undefined;
	/** Show `id`'s transcript in the main area; the host surfaces focus failures. */
	focus(id: string): void | Promise<void>;
	/** Return the main area to the primary session. */
	returnToPrimary(): void;
	requestRender(): void;
	/** Roster lifecycle and observed progress changes; returns the unsubscribe. */
	onChange(listener: (event?: AgentRosterChange) => void): () => void;
}

const FILTER_CONTROLS = [
	["running", "Run"],
	["idle", "Idle"],
	["parked", "Park"],
	["advisors", "Adv"],
	["aborted", "End"],
	["auto", "Auto"],
] as const;

type AgentControlId = (typeof FILTER_CONTROLS)[number][0];

interface StatusChange {
	status: AgentStatus;
	createdAt: number;
	at: number;
	sequence: number;
}

interface AgentRosterChange {
	type: "registered" | "status_changed" | "metadata_changed" | "removed";
	ref: AgentRecordLike;
}

type AgentFollowTarget = { row: number; edge: "start" | "end"; revision: string };

function isListed(ref: AgentRecordLike): boolean {
	return ref.kind === "sub" || ref.kind === "advisor";
}

function compareChanges(a: StatusChange, b: StatusChange): number {
	return a.at - b.at || a.sequence - b.sequence;
}

function elapsedClock(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const tail = String(seconds % 60).padStart(2, "0");
	if (minutes < 60) return `${minutes}:${tail}`;
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${tail}`;
}

/** The filter controls stay fixed below the document, even when no agent matches. */
class AgentControls implements MouseRoutable {
	readonly #host: AgentsSectionHost;
	#selected: number | undefined;
	#hits: { line: number; start: number; end: number; id: AgentControlId }[] = [];

	constructor(host: AgentsSectionHost) {
		this.#host = host;
	}

	render(width: number): readonly string[] {
		const settings = this.#host.settings;
		const enabled = cfgSidebarAgentFilters.get(settings);
		const rows: string[] = [];
		this.#hits = [];
		let line = "";
		let used = 0;
		for (const [index, [id, label]] of FILTER_CONTROLS.entries()) {
			const on = id === "auto" ? cfgSidebarAgentAutoscroll.get(settings) : enabled.includes(id);
			const text = truncateToWidth(`${on ? "+" : "-"}${label}`, width, "");
			const size = visibleWidth(text);
			if (used > 0 && used + size + 1 > width) {
				rows.push(line);
				line = "";
				used = 0;
			}
			if (used > 0) {
				line += " ";
				used++;
			}
			this.#hits.push({ line: rows.length, start: used, end: used + size, id });
			used += size;
			const styled = on ? theme.bold(theme.fg("accent", text)) : theme.fg("muted", text);
			line += index === this.#selected ? theme.bgFill("selectedBg", styled) : styled;
		}
		rows.push(line);
		return rows;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (!event.leftClick) return;
		const hit = this.#hits.find(cell => cell.line === line && col >= cell.start && col < cell.end);
		if (hit) this.#toggle(hit.id);
	}

	move(delta: number): void {
		const count = FILTER_CONTROLS.length;
		this.#selected = ((this.#selected ?? (delta > 0 ? -1 : 0)) + delta + count) % count;
		this.#host.requestRender();
	}

	toggleSelected(): void {
		if (this.#selected !== undefined) this.#toggle(FILTER_CONTROLS[this.#selected]![0]);
	}

	reset(): void {
		this.#selected = undefined;
	}

	invalidate(): void {}

	#toggle(id: AgentControlId): void {
		const settings = this.#host.settings;
		if (id === "auto") cfgSidebarAgentAutoscroll.set(settings, !cfgSidebarAgentAutoscroll.get(settings));
		else {
			const current = cfgSidebarAgentFilters.get(settings);
			cfgSidebarAgentFilters.set(
				settings,
				current.includes(id) ? current.filter(filter => filter !== id) : [...current, id],
			);
		}
		this.#host.requestRender();
	}
}

class AgentsContent implements MouseRoutable, SidePanelPointerAware {
	readonly #host: AgentsSectionHost;
	readonly #unsubscribe: () => void;
	readonly #changes = new Map<string, StatusChange>();
	#sequence = 0;
	#tick: NodeJS.Timeout | undefined;
	#target: AgentFollowTarget | undefined;
	/** Agent id per rendered body row, from the last render. */
	#rowIds: readonly string[] = [];
	#hovered: string | undefined;
	#pendingFocus: { id: string } | undefined;

	constructor(host: AgentsSectionHost) {
		this.#host = host;
		this.#unsubscribe = host.onChange(event => {
			if (event?.type === "removed") this.#changes.delete(event.ref.id);
			else if (event && isListed(event.ref) && event.type !== "metadata_changed") {
				this.#observe(event.ref, event.type);
			}
			if (host.visible()) host.requestRender();
		});
	}

	#observe(ref: AgentRecordLike, event?: "registered" | "status_changed"): StatusChange {
		const previous = event === "registered" ? undefined : this.#changes.get(ref.id);
		if (previous?.status === ref.status && previous.createdAt === ref.createdAt) return previous;
		const at = !previous && event !== "status_changed" && ref.status === "running" ? ref.createdAt : ref.lastActivity;
		const change = { status: ref.status, createdAt: ref.createdAt, at, sequence: this.#sequence++ };
		this.#changes.set(ref.id, change);
		return change;
	}

	render(width: number): readonly string[] {
		const settings = this.#host.settings;
		const filters = cfgSidebarAgentFilters.get(settings);
		const newestAtTop = cfgSidebarAgentOrder.get(settings) === "newest-at-top";
		const follow = cfgSidebarAgentAutoscroll.get(settings);
		const agents = [];
		for (const ref of this.#host.agents()) {
			if (!isListed(ref)) continue;
			const change = this.#observe(ref);
			if (filters.includes(ref.kind === "advisor" ? "advisors" : ref.status)) agents.push({ ref, change });
		}
		agents.sort((a, b) => {
			const parked = Number(b.ref.status === "parked") - Number(a.ref.status === "parked");
			if (parked) return newestAtTop ? -parked : parked;
			const chronology = compareChanges(a.change, b.change);
			return newestAtTop || a.ref.status === "parked" ? -chronology : chronology;
		});
		this.#target = undefined;
		const ids: string[] = [];
		this.#rowIds = ids;
		if (agents.length === 0) {
			this.#hovered = undefined;
			return [theme.fg("muted", truncateToWidth("No agents match these filters", width))];
		}
		const focused = this.#host.focusedAgentId();
		const now = Date.now();
		const lines: string[] = [];
		let newest: StatusChange | undefined;
		let live = false;
		for (const { ref, change } of agents) {
			const top = lines.length;
			const running = ref.status === "running";
			live ||= running;
			this.#appendAgent(lines, ref, change, now, width, ref.id === focused);
			for (let row = top; row < lines.length; row++) ids.push(ref.id);
			// Follow running work first; a parking transition must not pull it out of view.
			if (
				follow &&
				(!newest || (running === (newest.status === "running") ? compareChanges(change, newest) > 0 : running))
			) {
				newest = change;
				this.#target = {
					row: newestAtTop ? top : lines.length - 1,
					edge: newestAtTop ? "start" : "end",
					revision: `${newestAtTop}:${filters.join(",")}:${change.sequence}`,
				};
			}
		}
		if (this.#hovered !== undefined && !ids.includes(this.#hovered)) this.#hovered = undefined;
		if (live && !this.#tick) {
			this.#tick = setTimeout(
				() => {
					this.#tick = undefined;
					if (this.#host.visible()) this.#host.requestRender();
				},
				1000 - (now % 1000),
			);
			this.#tick.unref?.();
		}
		return lines;
	}

	#appendAgent(
		lines: string[],
		ref: AgentRecordLike,
		change: StatusChange,
		now: number,
		width: number,
		focused: boolean,
	): void {
		const observed = this.#host.observed(ref.id);
		const progress = observed?.progress;
		const running = ref.status === "running";
		const currentProgress =
			running && observed?.status === "active" && observed.progressAt !== undefined ? progress : undefined;
		const current = currentProgress?.currentTool;
		const waitAt = current === "wait" ? currentProgress?.currentToolStartMs : undefined;
		const duration = running
			? currentProgress && observed?.progressAt !== undefined
				? currentProgress.durationMs + Math.max(0, now - observed.progressAt)
				: now - change.at
			: (progress?.durationMs ?? ref.history?.metrics?.durationMs ?? change.at - ref.createdAt);
		const name = agentColored(theme, ref.id, sanitizeDisplaySingleLine(ref.id));
		const slug = modelChip(ref, observed)?.text;
		const gutter = focused ? theme.fg("accent", "▍") : " ";
		const model = slug ? theme.fg("muted", ` ${slug}`) : "";
		const advisor = ref.kind === "advisor" ? theme.fg("warning", " read-only") : "";
		const header = `${gutter}${statusGlyph(ref.status)} ${focused ? theme.bold(name) : name}${model}${advisor}`;
		const assignment =
			progress?.assignment ?? observed?.description ?? progress?.task ?? (!running ? ref.activity : undefined);
		const operation = current
			? (currentProgress?.currentToolIntent ?? [current, currentProgress?.currentToolArgs].filter(Boolean).join(" "))
			: running
				? (currentProgress?.lastIntent ?? ref.activity ?? ref.status)
				: ref.status;
		const branch = theme.fg("dim", " ├ ");
		const leaf = theme.fg("dim", " └ ");
		const clock = theme.fg("muted", elapsedClock(duration));
		const hovered = ref.id === this.#hovered;
		const start = lines.length;
		lines.push(
			header,
			`${branch}${clock}${assignment ? ` ${sanitizeDisplaySingleLine(assignment)}` : ""}`,
			`${waitAt === undefined ? leaf : branch}${sanitizeDisplaySingleLine(operation)}`,
		);
		if (waitAt !== undefined) lines.push(`${leaf}${theme.fg("warning", `wait ${formatDuration(now - waitAt)}`)}`);
		for (let row = start; row < lines.length; row++) {
			const fitted = truncateToWidth(lines[row]!, width);
			lines[row] = hovered
				? theme.bgFill("selectedBg", fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted))))
				: fitted;
		}
	}

	followTarget(): AgentFollowTarget | undefined {
		return this.#target;
	}

	routeMouse(event: SgrMouseEvent, line: number): void {
		const id = this.#rowIds[line];
		if (event.motion) {
			this.#setHovered(id);
			return;
		}
		if (!event.leftClick) return;
		if (id === undefined) {
			this.clickEmpty();
			return;
		}
		if (id === this.#host.focusedAgentId() || id === this.#pendingFocus?.id) {
			this.#pendingFocus = undefined;
			this.#host.returnToPrimary();
			return;
		}
		const completion = this.#host.focus(id);
		if (completion) {
			const pending = { id };
			this.#pendingFocus = pending;
			const settled = () => {
				if (this.#pendingFocus === pending) this.#pendingFocus = undefined;
			};
			void completion.then(settled, settled);
		} else {
			this.#pendingFocus = undefined;
		}
	}

	/** A click on panel space with no agent row returns to the primary session. */
	clickEmpty(): void {
		if (this.#host.focusedAgentId() === undefined && this.#pendingFocus === undefined) return;
		this.#pendingFocus = undefined;
		this.#host.returnToPrimary();
	}

	pointerLeave(): void {
		this.#setHovered(undefined);
	}

	invalidate(): void {}

	dispose(): void {
		this.#unsubscribe();
		clearTimeout(this.#tick);
	}

	#setHovered(id: string | undefined): void {
		if (id === this.#hovered) return;
		this.#hovered = id;
		this.#host.requestRender();
	}
}

/** An Agent Hub jump list with its own live task tree and fixed filter controls. */
export class AgentsSection implements SidePanelViewSection {
	readonly id = "agents";
	readonly title = "AGENTS";
	readonly order = 10;
	collapsed?: boolean;
	readonly content: AgentsContent;
	readonly footer: AgentControls;

	constructor(host: AgentsSectionHost) {
		this.content = new AgentsContent(host);
		this.footer = new AgentControls(host);
	}

	followTarget(): AgentFollowTarget | undefined {
		return this.content.followTarget();
	}

	moveControl(delta: number): void {
		this.footer.move(delta);
	}

	toggleControl(): void {
		this.footer.toggleSelected();
	}

	resetControl(): void {
		this.footer.reset();
	}

	clickEmpty(): void {
		this.content.clickEmpty();
	}
}
