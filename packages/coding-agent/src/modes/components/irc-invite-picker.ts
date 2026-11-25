import {
	applyMenuMotion,
	type Component,
	FuzzyQuery,
	getKeybindings,
	getMenuSearchVimMode,
	isKeyRepeat,
	matchesKey,
	menuHintLines,
	MenuKeyReader,
	MenuSearchField,
	MenuSelection,
	MenuViewport,
	replaceTabs,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { bottomBorder, row, topBorder } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { formatKeyHints } from "@oh-my-pi/pi-tui/key-hint-format";
import { compileMenuRegex } from "@oh-my-pi/pi-tui/menu-search";
import type { AgentStatus } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import { sanitizeDisplaySingleLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { t } from "@oh-my-pi/pi-utils/i18n";

const GROUP_ORDER: Record<AgentStatus, number> = { parked: 0, aborted: 1, idle: 2, running: 3 };
const STATES = ["any", "running", "idle", "parked"] as const;
const CONDITIONS = ["state", "name", "slug"] as const;
const NOTICE_MODES = ["next-turn", "wake-now", "verbose", "silent"] as const;
const CONFIRM_ROWS = [...NOTICE_MODES, "back", "add"] as const;
const SEARCH_THEME = { muted: (text: string) => theme.fg("muted", text) };

type Condition = (typeof CONDITIONS)[number];
type ConfirmRow = (typeof CONFIRM_ROWS)[number];
export type IrcInviteNoticeMode = (typeof NOTICE_MODES)[number];

export interface IrcInviteAgent {
	id: string;
	name: string;
	/** The full, unshortened model slug. */
	modelSlug: string;
	status: AgentStatus;
	/** Timestamp of the transition into this state, when known. */
	statusEnteredAt?: number;
}

export interface IrcInviteConfirmation {
	roomId: string;
	agentIds: readonly string[];
	noticeMode: IrcInviteNoticeMode;
}

export interface IrcInvitePickerOptions {
	/** Real agents eligible for the client to list, and the current room membership. */
	getRoomRoster(roomId: string): { agents: readonly IrcInviteAgent[]; memberIds: ReadonlySet<string> };
	/** Called once on Add, after closing the picker. The caller owns membership updates and delivery. */
	onConfirm(selection: IrcInviteConfirmation): void;
	/** Called when dismissed without confirming. */
	onClose(): void;
	/** Available popup height including borders. */
	maxRows?(): number;
}

type Page =
	| { kind: "list" }
	| {
			kind: "matching";
			menu: MenuSelection<Condition>;
			viewport: MenuViewport;
			state: number;
			name: MenuSearchField;
			slug: MenuSearchField;
		  }
	| { kind: "confirm"; menu: MenuSelection<ConfirmRow>; viewport: MenuViewport; mode: IrcInviteNoticeMode };

function actionMenu<T extends string>(items: readonly T[], initial?: T): MenuSelection<T> {
	return new MenuSelection(items, { getKey: item => item, getSearchText: item => item }, initial);
}

function containsMatcher(pattern: string): (text: string) => boolean {
	const regex = compileMenuRegex(pattern);
	if (regex) return text => regex.regex?.test(text) ?? false;
	const needle = pattern.toLowerCase();
	return text => text.toLowerCase().includes(needle);
}

/** Keep one instance for the lifetime of the IRC client, not one per popup. */
export class IrcInvitePickerComponent implements Component {
	readonly #options: IrcInvitePickerOptions;
	readonly #marks = new Map<string, Set<string>>();
	readonly #keys = new MenuKeyReader();
	readonly #search = new MenuSearchField("", false, "retain");
	readonly #viewport = new MenuViewport();
	readonly #agents = new MenuSelection<IrcInviteAgent>([], {
		getKey: agent => agent.id,
		getSearchText: agent => agent.name,
		filter: (agents, pattern) => {
			const query = new FuzzyQuery(pattern);
			return agents.filter(agent => query.match(agent.name).matches || query.match(agent.modelSlug).matches);
		},
	});
	#room: { id: string; name: string; marks: Set<string> } | undefined;
	#page: Page = { kind: "list" };

	constructor(options: IrcInvitePickerOptions) {
		this.#options = options;
	}

	get isOpen(): boolean {
		return this.#room !== undefined;
	}

	open(roomId: string, roomName = roomId): void {
		const marks = this.#marks.get(roomId) ?? new Set<string>();
		this.#marks.set(roomId, marks);
		this.#room = { id: roomId, name: roomName, marks };
		this.#keys.reset();
		this.#page = { kind: "list" };
		this.#search.focused = false;
		this.#search.setValue("");
		this.#agents.setItems([]);
		this.#agents.setQuery("");
		this.#viewport.setTop(undefined);
		this.refresh();
	}

	/** Reconcile changes to the real roster; filtering never changes the marks. */
	refresh(): void {
		const room = this.#room;
		if (!room) return;
		const { agents, memberIds } = this.#options.getRoomRoster(room.id);
		const candidates = agents.filter(agent => !memberIds.has(agent.id));
		candidates.sort((a, b) => {
			const group = GROUP_ORDER[a.status] - GROUP_ORDER[b.status];
			if (group !== 0) return group;
			if (a.statusEnteredAt === undefined) return b.statusEnteredAt === undefined ? 0 : -1;
			if (b.statusEnteredAt === undefined) return 1;
			return a.statusEnteredAt - b.statusEnteredAt;
		});
		if (room.marks.size > 0) {
			const eligible = new Set(candidates.map(agent => agent.id));
			const before = room.marks.size;
			for (const id of room.marks) if (!eligible.has(id)) room.marks.delete(id);
			// A changed batch must be reviewed again, not sent under the previous count.
			if (room.marks.size !== before && this.#page.kind === "confirm") this.#page = { kind: "list" };
		}
		this.#agents.setItems(candidates);
		this.#viewport.reveal();
	}

	close(): void {
		if (!this.#room) return;
		this.#dismiss();
		this.#options.onClose();
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const room = this.#room;
		if (!room) return;
		const page = this.#page;
		if (page.kind === "list" && this.#search.focused) {
			this.#search.handleInput(data);
			if (this.#search.query !== this.#agents.query) {
				this.#agents.setQuery(this.#search.query);
				this.#viewport.reveal();
			}
			return;
		}
		if (page.kind === "matching") {
			const field = page.name.focused ? page.name : page.slug.focused ? page.slug : undefined;
			if (field) {
				field.handleInput(data);
				return;
			}
		}

		const action = this.#keys.read(data);
		if (action === "pending") return;
		if (action?.kind === "cancel") {
			if (page.kind === "list") this.close();
			else this.#page = { kind: "list" };
			return;
		}
		if (action?.kind === "confirm" && isKeyRepeat(data)) return;

		if (page.kind === "list") {
			if (action && applyMenuMotion(action, this.#agents, this.#viewport).handled) return;
			if (action?.kind === "search") this.#search.focused = true;
			else if (action?.kind === "toggle") {
				const agent = this.#agents.selectedItem;
				if (agent && !room.marks.delete(agent.id)) room.marks.add(agent.id);
			} else if (action?.kind === "confirm") {
				this.refresh();
				if (room.marks.size > 0) {
					this.#page = {
						kind: "confirm",
						menu: actionMenu(CONFIRM_ROWS, "back"),
						viewport: new MenuViewport(),
						mode: "next-turn",
					};
				}
			} else if (!action && matchesKey(data, "c")) room.marks.clear();
			else if (!action && matchesKey(data, "s")) {
				this.#page = {
					kind: "matching",
					menu: actionMenu(CONDITIONS),
					viewport: new MenuViewport(),
					state: 0,
					name: new MenuSearchField("", false, "retain"),
					slug: new MenuSearchField("", false, "retain"),
				};
			}
			return;
		}

		if (!action) return;
		if (applyMenuMotion(action, page.menu, page.viewport).handled) return;
		if (page.kind === "matching") {
			const field = page.menu.selectedItem;
			if (action.kind === "context") {
				page.menu.move(action.delta, true);
				page.viewport.reveal();
			} else if (action.kind === "confirm") {
				const status = STATES[page.state];
				const matchesName = containsMatcher(page.name.confirmedQuery);
				const matchesSlug = containsMatcher(page.slug.confirmedQuery);
				this.refresh();
				for (const agent of this.#agents.items) {
					if ((status === "any" || agent.status === status) && matchesName(agent.name) && matchesSlug(agent.modelSlug)) {
						room.marks.add(agent.id);
					}
				}
				this.#page = { kind: "list" };
			} else if (field === "state" && (action.kind === "horizontal" || action.kind === "toggle")) {
				const delta = action.kind === "horizontal" ? action.delta : 1;
				page.state = (page.state + delta + STATES.length) % STATES.length;
			} else if ((field === "name" || field === "slug") && (action.kind === "search" || action.kind === "toggle")) {
				page[field].focused = true;
			}
			return;
		}

		if (action.kind !== "confirm" && action.kind !== "toggle") return;
		const choice = page.menu.selectedItem;
		if (!choice) return;
		if (choice === "back") this.#page = { kind: "list" };
		else if (choice !== "add") page.mode = choice;
		else if (action.kind === "confirm") {
			this.refresh();
			if (this.#page !== page || room.marks.size === 0) return;
			const agentIds = this.#agents.items.filter(agent => room.marks.has(agent.id)).map(agent => agent.id);
			this.#marks.delete(room.id);
			this.#dismiss();
			this.#options.onConfirm({ roomId: room.id, agentIds, noticeMode: page.mode });
		}
	}

	render(width: number): readonly string[] {
		const room = this.#room;
		if (!room) return [];
		const page = this.#page;
		const columns = Math.max(0, width - 4);
		const label = (text: string) => truncateToWidth(replaceTabs(text), columns);
		const title =
			page.kind === "list"
				? t("overlays.irc_invite.title", { room: sanitizeDisplaySingleLine(room.name) })
				: t(`overlays.irc_invite.${page.kind}_title`);
		const lines = [topBorder(width, title)];
		const muted = (text: string) => theme.fg("muted", label(text));
		const put = (text: string) => lines.push(row(text, width));
		const kb = getKeybindings();
		const vim = getMenuSearchVimMode();
		const height = this.#options.maxRows?.() ?? Math.min(24, process.stdout.rows ?? 24);
		const chrome = page.kind === "list" ? 4 : 2;
		const hints = menuHintLines(
			t(`overlays.irc_invite.${page.kind}_hint`, {
				toggle: formatKeyHints(kb.getKeys("tui.select.toggle")),
				search: formatKeyHints(kb.getKeys("tui.select.search")),
				confirm: formatKeyHints(kb.getKeys("tui.select.confirm")),
				cancel: formatKeyHints(kb.getKeys("tui.select.cancel")),
				move: vim ? "↑↓/jk" : "↑↓",
				horizontal: vim ? "←→/hl" : "←→",
			}),
			columns,
			"",
		).slice(0, Math.max(0, height - chrome - 1));
		const budget = Math.max(1, height - hints.length - chrome);
		if (page.kind === "list") {
			const items = this.#agents.visibleItems;
			const grouped = items.map((agent, index) => (budget > 1 && agent.status !== items[index - 1]?.status ? 2 : 1));
			const window = this.#viewport.layout(grouped, this.#agents.selectedIndex, budget);
			let remaining = budget;
			for (let index = window.startIndex; index < window.endIndex && remaining > 0; index++) {
				const agent = items[index]!;
				if (grouped[index] === 2 && remaining > 1 && (index !== window.startIndex || window.lineOffset === 0)) {
					put(muted(t(`overlays.irc_invite.state.${agent.status}`)));
					remaining--;
				}
				const check = room.marks.has(agent.id) ? theme.checkbox.checked : theme.checkbox.unchecked;
				const text = `${check} ${sanitizeDisplaySingleLine(agent.name)} · ${sanitizeDisplaySingleLine(agent.modelSlug)}`;
				put(this.#renderChoice(label, text, index === this.#agents.selectedIndex));
				remaining--;
			}
			if (items.length === 0) {
				const key = this.#agents.items.length === 0 ? "overlays.irc_invite.no_agents" : "tui.components.search.no_matching_items";
				put(muted(t(key)));
			}
			put(muted(t("overlays.irc_invite.selected", { count: room.marks.size })));
			for (const hint of hints) put(muted(hint));
			put(this.#search.render(columns, SEARCH_THEME));
		} else {
			const items = page.menu.visibleItems;
			const window = page.viewport.layout(items.map(() => 1), page.menu.selectedIndex, budget);
			for (let index = window.startIndex; index < window.endIndex; index++) {
				const item = items[index]!;
				const selected = index === page.menu.selectedIndex;
				if (page.kind === "matching") {
					if (item !== "state" && item !== "name" && item !== "slug") continue;
					const name = t(`overlays.irc_invite.condition.${item}`);
					const field = item === "state" ? undefined : page[item];
					if (field?.focused) {
						const prefix = label(`${name} · `);
						put(`${prefix}${field.render(Math.max(0, columns - visibleWidth(prefix)), SEARCH_THEME)}`);
					} else {
						const value = field
							? sanitizeDisplaySingleLine(field.confirmedQuery)
							: t(`overlays.irc_invite.state.${STATES[page.state]}`);
						put(this.#renderChoice(label, `${name}: ${value}`, selected));
					}
				} else if (item === "add" || item === "back") {
					put(this.#renderChoice(label, t(`overlays.irc_invite.${item}`, { count: room.marks.size }), selected));
				} else {
					const mark = page.mode === item ? theme.checkbox.checked : theme.checkbox.unchecked;
					put(this.#renderChoice(label, `${mark} ${t(`overlays.irc_invite.notice.${item}`)}`, selected));
				}
			}
			for (const hint of hints) put(muted(hint));
		}
		lines.push(bottomBorder(width));
		return lines;
	}

	#renderChoice(fit: (text: string) => string, text: string, selected: boolean): string {
		const fitted = fit(`${selected ? "> " : "  "}${text}`);
		return selected ? theme.fg("accent", fitted) : fitted;
	}

	#dismiss(): void {
		if (this.#room?.marks.size === 0) this.#marks.delete(this.#room.id);
		this.#room = undefined;
		this.#page = { kind: "list" };
		this.#agents.setItems([]);
	}
}
