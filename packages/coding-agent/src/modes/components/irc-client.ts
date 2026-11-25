import {
	applyMenuMotion,
	type AutocompleteItem,
	type Component,
	FuzzyQuery,
	getKeybindings,
	getMenuSearchVimMode,
	Input,
	isKeyRepeat,
	type KeyId,
	matchesKey,
	MenuKeyReader,
	MenuSearchField,
	MenuSelection,
	MenuViewport,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { bottomBorder, row, topBorder } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { formatKeyHints } from "@oh-my-pi/pi-tui/key-hint-format";
import { compileMenuRegex } from "@oh-my-pi/pi-tui/menu-search";
import { agentColored } from "@oh-my-pi/pi-tui/overlays/agent-identity";
import { statusGlyph } from "@oh-my-pi/pi-tui/overlays/agent-hub-renderer";
import { sanitizeDisplaySingleLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { clockTime } from "@oh-my-pi/pi-tui/overlays/irc-viewer";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { t, type TranslationValues } from "@oh-my-pi/pi-utils/i18n";
import {
	IRC_NOTIFICATION_LEVELS,
	IRC_TRAFFIC_ID,
	type IrcClientConversation,
	type IrcClientModel,
	type IrcConversationId,
	ircDmId,
	ircEntryConversationId,
	ircEntryId,
	type IrcNotificationLevel,
	ircRoomId,
	otherIrcDmPeer,
} from "../../irc/client-model";
import { IrcClientFeed } from "./irc-client-feed";
import { type IrcInviteAgent, type IrcInviteConfirmation, IrcInvitePickerComponent } from "./irc-invite-picker";

export interface IrcClientTarget {
	conversationId: IrcConversationId;
	entryId?: string;
}

const PERMISSIONS = ["receive", "send", "invite", "admin"] as const;
type Permission = (typeof PERMISSIONS)[number];
const JOIN_MODES = ["silent", "announce", "invisible"] as const;
type JoinMode = (typeof JOIN_MODES)[number];
type Capability = "invite" | "leave" | "notifications" | "mute" | "remove" | "permissions" | `join-${JoinMode}`;

export interface IrcClientMember extends IrcInviteAgent {
	agentType?: string;
	displayModelSlug?: string;
	activity?: string;
	color?(text: string): string;
	muted?: boolean;
	permissions?: Readonly<Record<Permission, boolean>>;
}

export interface IrcClientRoom {
	name: string;
	joined: boolean;
	/** Effective send right, even when the joined operator is invisible in members. */
	canSend?: boolean;
	notifications?: IrcNotificationLevel;
	members: readonly IrcClientMember[];
	capabilities?: readonly Capability[];
}

export type IrcClientAction =
	| { kind: "send"; conversationId: IrcConversationId; text: string }
	| { kind: "create"; room: string }
	| { kind: "join"; room: string; mode: JoinMode }
	| { kind: "leave"; room: string }
	| { kind: "notifications"; conversationId: IrcConversationId; level: IrcNotificationLevel }
	| { kind: "invite"; confirmation: IrcInviteConfirmation }
	| { kind: "mute"; room: string; memberId: string; muted: boolean }
	| { kind: "remove"; room: string; memberId: string }
	| { kind: "permission"; room: string; memberId: string; permission: Permission; enabled: boolean };

export interface IrcClientHost {
	operatorId?: string;
	operatorName: string;
	canCreate?: boolean;
	rooms(): readonly IrcClientRoom[];
	agents(): readonly IrcInviteAgent[];
	/** Resolve with the actual error text, or undefined only when the operation succeeded. */
	act(action: IrcClientAction): Promise<string | undefined> | string | undefined;
}

interface ClientOptions {
	model: IrcClientModel;
	host: IrcClientHost;
	requestRender(): void;
	onClose(): void;
	maxRows(): number;
	viewerKeys?: readonly KeyId[];
	trafficKeys?: readonly KeyId[];
}

type Page = "quick" | "dms" | "roster";
type Region = "sidebar" | "center" | "members";
type Shortcut = "roster" | "see_all" | "open_dms" | "new_room";
type SidebarRow =
	| { key: string; type: "group"; text: string }
	| { key: Shortcut; type: "shortcut"; text: string }
	| { key: IrcConversationId; type: "conversation"; text: string; conversation?: IrcClientConversation };

type Choice = { label: string; run?: () => void };
type Popup =
	| { title: string; type: "choices"; list: MenuSelection<Choice>; viewport: MenuViewport }
	| { title: string; type: "create"; input: Input };

const FILTERS = ["all", "joined", "not_joined", "pinned", "unread"] as const;
const SORTS = ["activity", "name", "members"] as const;
const SEARCH_THEME = { muted: (text: string) => theme.fg("muted", text) };
const MIN_PANE_WIDTH = 16;
const RECENT_DMS = 6;

function label(key: string, values?: TranslationValues): string {
	return t(`overlays.irc_client.${key}`, values);
}

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, width);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function supports(room: IrcClientRoom, capability: Capability): boolean {
	return room.capabilities?.includes(capability) ?? false;
}

function matcher(query: string): (text: string) => boolean {
	if (!query) return () => true;
	const compiled = compileMenuRegex(query);
	if (compiled) return text => compiled.regex?.test(text) ?? false;
	const fuzzy = new FuzzyQuery(query);
	return text => fuzzy.match(text).matches;
}

export class IrcClientComponent implements Component {
	readonly #model: IrcClientModel;
	readonly #host: IrcClientHost;
	readonly #unsubscribe: () => void;
	readonly #keys = new MenuKeyReader();
	readonly #sidebar = new MenuSelection<SidebarRow>([], {
		getKey: item => item.key,
		getSearchText: item => item.text,
		isDisabled: item => item.type === "group",
	});
	readonly #members = new MenuSelection<IrcClientMember>([], { getKey: member => member.id, getSearchText: member => member.name });
	readonly #sidebarView = new MenuViewport();
	readonly #membersView = new MenuViewport();
	readonly #roster = new MenuSelection<IrcClientConversation & { kind: "room" }>([], {
		getKey: item => item.id,
		getSearchText: item => item.room,
	});
	readonly #rosterView = new MenuViewport();
	readonly #search = new MenuSearchField();
	readonly #feed = new IrcClientFeed();
	readonly #previewFeed = new IrcClientFeed();
	readonly #editors = new Map<IrcConversationId, CustomEditor>();
	readonly #invite: IrcInvitePickerComponent;
	#popup: Popup | undefined;
	#open = false;
	#opening = 0;
	#disposed = false;
	#terminalCursor = false;
	#page: Page = "quick";
	#region: Region = "sidebar";
	#filter = 0;
	#sort = 0;
	#previewEnabled = false;
	#previousDisplay: IrcConversationId | undefined;
	#membersFor: IrcConversationId | undefined;
	#rooms = new Map<string, IrcClientRoom>();
	#names = new Map<string, string>();
	#lastVisibleRoom: IrcConversationId | undefined;
	#sidebarRows = 1;
	#busy = false;
	#error: string | undefined;
	focused = true;

	constructor(private readonly options: ClientOptions) {
		this.#model = options.model;
		this.#host = options.host;
		this.#invite = new IrcInvitePickerComponent({
			getRoomRoster: room => ({
				agents: this.#host.agents(),
				memberIds: new Set(this.#host.rooms().find(candidate => candidate.name === room)?.members.map(member => member.id)),
			}),
			onConfirm: confirmation => { void this.#act({ kind: "invite", confirmation }); },
			onClose: options.requestRender,
			maxRows: options.maxRows,
		});
		this.#unsubscribe = this.#model.subscribe(() => {
			if (this.#open) options.requestRender();
		});
	}

	open(mode: "resume" | "traffic" = "resume", target?: IrcClientTarget): void {
		if (this.#disposed) return;
		this.#open = true;
		this.#opening++;
		this.#dismissTransient();
		this.#page = "quick";
		this.#region = mode === "traffic" || target ? "center" : "sidebar";
		const previous = this.#model.selected;
		const id = this.#model.open(mode, target?.conversationId);
		if (mode === "traffic" || target || previous !== id) this.#feed.reset(target?.entryId);
		this.#refresh(id);
		this.options.requestRender();
	}

	close(): void {
		if (!this.#open) return;
		this.#open = false;
		this.#dismissTransient();
		this.#model.close();
	}

	dispose(): void {
		this.close();
		this.#disposed = true;
		this.#unsubscribe();
		this.#editors.clear();
	}

	invalidate(): void {
		for (const editor of this.#editors.values()) editor.invalidate();
	}

	setUseTerminalCursor(value: boolean): void {
		this.#terminalCursor = value;
	}

	#dismissTransient(): void {
		this.#keys.reset();
		this.#popup = undefined;
		this.#invite.close();
		this.#search.focused = false;
		this.#search.setValue("");
		this.#previewEnabled = false;
	}

	#name(id: string): string {
		return id === this.#host.operatorId ? this.#host.operatorName : (this.#names.get(id) ?? id);
	}

	#title(id: IrcConversationId): string {
		if (id === IRC_TRAFFIC_ID) return label("traffic");
		if (id.startsWith("room:")) return `#${sanitizeDisplaySingleLine(id.slice(5))}`;
		const other = otherIrcDmPeer(id, this.#host.operatorId);
		if (other) return sanitizeDisplaySingleLine(this.#name(other));
		const { message } = this.#model.entries(id)[0] ?? {};
		return message ? `${sanitizeDisplaySingleLine(this.#name(message.from))} ↔ ${sanitizeDisplaySingleLine(this.#name(message.to))}` : label("direct");
	}

	#room(id: IrcConversationId): IrcClientRoom | undefined {
		return id.startsWith("room:") ? this.#rooms.get(id.slice(5)) : undefined;
	}

	#preview(): IrcConversationId | undefined {
		if (!this.#previewEnabled || this.#region !== "sidebar" || this.#page === "roster") return undefined;
		const choice = this.#sidebar.selectedItem;
		return choice?.type === "conversation" && choice.key !== this.#model.selected ? choice.key : undefined;
	}

	#canSend(id: IrcConversationId): boolean {
		const room = this.#room(id);
		return this.#host.operatorId !== undefined && (!!otherIrcDmPeer(id, this.#host.operatorId) || (room?.joined === true && room.canSend !== false));
	}

	#refresh(preferred?: IrcConversationId): void {
		const rooms = this.#host.rooms();
		const agents = this.#host.agents();
		this.#rooms = new Map(rooms.map(room => [room.name, room]));
		this.#names = new Map(agents.map(agent => [agent.id, agent.name]));
		for (const room of rooms) for (const member of room.members) this.#names.set(member.id, member.name);
		const conversations = this.#model.conversations(rooms.map(room => room.name));
		const dms = conversations.filter(item => item.kind === "dm");
		const roomItems = conversations.filter(item => item.kind === "room");
		const query = this.#search.query;
		const match = matcher(query);
		const matchesRoom = (item: (typeof roomItems)[number]) =>
			match(item.room) || this.#rooms.get(item.room)?.members.some(member => match(member.name)) === true;
		const matchesDm = (item: (typeof dms)[number]) => match(this.#title(item.id));
		const asRow = (item: IrcClientConversation): SidebarRow => ({ key: item.id, type: "conversation", conversation: item, text: this.#title(item.id) });
		const create: SidebarRow[] = this.#host.canCreate ? [{ key: "new_room", type: "shortcut", text: label("new_room") }] : [];
		const quick: SidebarRow[] = [
			{ key: IRC_TRAFFIC_ID, type: "conversation", text: label("traffic") },
			{ key: "roster", type: "shortcut", text: label("roster") },
		];
		const filteredDms = query && this.#page !== "roster" ? dms.filter(matchesDm) : dms;
		const filteredRooms = query && this.#page !== "roster" ? roomItems.filter(matchesRoom) : roomItems;
		const overhead = 1 + quick.length + create.length + 1 + (dms.length ? 1 + Math.min(dms.length, RECENT_DMS) + Number(dms.length > RECENT_DMS) : 0);
		const roomSlots = Math.max(1, this.#sidebarRows - overhead - Number(filteredRooms.length > this.#sidebarRows - overhead));
		const shownRooms = query ? filteredRooms : filteredRooms.slice(0, roomSlots);
		this.#lastVisibleRoom = shownRooms.at(-1)?.id;
		if (this.#page === "dms") {
			quick.length = 0;
			quick.push(...filteredDms.map(asRow));
		} else {
			if (filteredDms.length > 0) {
				quick.push({ key: "direct", type: "group", text: label("direct") });
				quick.push(...(query ? filteredDms : filteredDms.slice(0, RECENT_DMS)).map(asRow));
				if (!query && dms.length > RECENT_DMS) quick.push({ key: "open_dms", type: "shortcut", text: label("open_dms", { count: dms.length }) });
			}
			if (filteredRooms.length > 0) {
				quick.push({ key: "rooms", type: "group", text: label("rooms") }, ...shownRooms.map(asRow));
				if (shownRooms.length < filteredRooms.length) quick.push({ key: "see_all", type: "shortcut", text: label("see_all") });
			}
			quick.push(...create);
		}
		// A DM opened from a member may not have its first ledger row yet.
		const active = this.#model.selected;
		if (this.#page === "quick" && !query && active !== IRC_TRAFFIC_ID && !quick.some(item => item.key === active)) {
			const item = conversations.find(item => item.id === active);
			if (!item) quick.splice(2, 0, { key: active, type: "conversation", text: this.#title(active) });
		}
		if (this.#sidebar.setItems(quick, preferred ?? this.#sidebar.selectedKey)) this.#sidebarView.reveal();
		if (this.#page === "roster") {
			const roster = roomItems.filter(item => {
				if (!matchesRoom(item)) return false;
				const joined = this.#rooms.get(item.room)?.joined === true;
				switch (FILTERS[this.#filter]) {
					case "joined": return joined;
					case "not_joined": return !joined;
					case "pinned": return item.pinned;
					case "unread": return item.unread > 0;
					default: return true;
				}
			});
			if (SORTS[this.#sort] === "name") roster.sort((a, b) => a.room.localeCompare(b.room));
			else if (SORTS[this.#sort] === "members") roster.sort((a, b) => (this.#rooms.get(b.room)?.members.length ?? 0) - (this.#rooms.get(a.room)?.members.length ?? 0));
			if (this.#roster.setItems(roster)) this.#rosterView.reveal();
		}
		const display = this.#displayId();
		if (display !== this.#previousDisplay) {
			this.#previousDisplay = display;
			this.#previewFeed.reset();
		}
		const nextMembers = display && this.#room(display)?.members;
		if (this.#members.setItems(nextMembers || [], this.#membersFor === display ? this.#members.selectedKey : "")) this.#membersView.reveal();
		this.#membersFor = display;
	}

	#displayId(): IrcConversationId | undefined {
		return this.#page === "roster" ? this.#roster.selectedItem?.id : (this.#preview() ?? this.#model.selected);
	}

	#editor(id: IrcConversationId): CustomEditor {
		let editor = this.#editors.get(id);
		if (editor) return editor;
		editor = new CustomEditor(getEditorTheme());
		editor.setPromptGutter("> ");
		editor.setAutocompleteMaxVisible(4);
		editor.onAutocompleteUpdate = this.options.requestRender;
		let candidates: AutocompleteItem[] = [];
		let tokenStart: string | undefined;
		const updateMention = (lines: readonly string[], row: number, col: number) => {
			const line = lines[row] ?? "";
			const prefix = /(?:^|[^\p{L}\p{N}_@/-])(@[\p{L}\p{N}_/-]*)$/u.exec(line.slice(0, col))?.[1];
			const room = this.#room(id);
			if (!prefix || !room) {
				tokenStart = undefined;
				return null;
			}
			const start = `${row}:${col - prefix.length}`;
			if (tokenStart !== start) {
				tokenStart = start;
				const handles = new Set(["everyone", ...room.members.map(member => member.name)]);
				candidates = [...handles].map(handle => ({ value: `@${handle}`, label: sanitizeDisplaySingleLine(`@${handle}`) }));
			}
			const items = candidates.filter(candidate => candidate.value.toLowerCase().startsWith(prefix.toLowerCase()));
			return items.length ? { items, prefix } : null;
		};
		editor.setAutocompleteProvider({
			getSuggestions: async (lines, row, col) => updateMention(lines, row, col),
			applyCompletion: (lines, row, col, item, prefix) => {
				const line = lines[row] ?? "";
				const start = col - prefix.length;
				const end = line.slice(col).match(/^[\p{L}\p{N}_/-]*/u)?.[0].length ?? 0;
				const insert = `${item.value} `;
				lines[row] = line.slice(0, start) + insert + line.slice(col + end);
				tokenStart = undefined;
				return { lines, cursorLine: row, cursorCol: start + insert.length };
			},
		});
		const composer = editor;
		editor.onChange = () => {
			const { line, col } = composer.getCursor();
			updateMention(composer.getLines(), line, col);
		};
		editor.onSubmit = async text => {
			if (text) {
				const sent = await this.#act({ kind: "send", conversationId: id, text });
				if (this.#disposed) return;
				if (sent) composer.addToHistory(text);
				else composer.restoreSubmittedDraft();
			}
			composer.clearSubmittedDraft();
			if (this.#open) this.options.requestRender();
		};
		this.#editors.set(id, editor);
		return editor;
	}

	#activate(id: IrcConversationId, queryMembership = true, entryId?: string): void {
		const room = this.#room(id);
		if (queryMembership && id.startsWith("room:") && !room?.joined) {
			const choices: Choice[] = [{ label: label("join.spy"), run: () => this.#activate(id, false, entryId) }];
			if (room) for (const mode of JOIN_MODES) {
				if (supports(room, `join-${mode}`)) choices.push({ label: label(`join.${mode}`), run: () => {
					void this.#act({ kind: "join", room: room.name, mode }, () => this.#activate(id, false, entryId));
				} });
			}
			this.#choices(this.#title(id), choices);
			return;
		}
		this.#dismissTransient();
		if (this.#page === "roster") this.#page = "quick";
		this.#region = "center";
		if (entryId || id !== this.#model.selected || this.#feed.following) this.#feed.reset(entryId);
		this.#model.select(id);
		this.#refresh(id);
	}

	#openRoster(anchor?: IrcConversationId): void {
		this.#dismissTransient();
		this.#page = "roster";
		this.#region = "center";
		this.#filter = 0;
		this.#sort = 0;
		this.#rosterView.setTop(undefined);
		this.#refresh();
		if (anchor && this.#roster.setSelectedKey(anchor)) this.#rosterView.reveal();
		this.#refresh();
	}

	#choices(title: string, choices: Choice[], defaultToBack = false): void {
		const back = label("back");
		choices.push({ label: back });
		const list = new MenuSelection(choices, { getKey: choice => choice.label, getSearchText: choice => choice.label }, defaultToBack ? back : undefined);
		this.#popup = { title, type: "choices", list, viewport: new MenuViewport() };
		this.#keys.reset();
	}

	#create(): void {
		if (!this.#host.canCreate || this.#busy) return;
		const input = new Input();
		input.prompt = "";
		input.placeholder = label("room_name");
		input.focused = true;
		this.#popup = { title: label("new_room"), type: "create", input };
	}

	#inviteRoom(room: IrcClientRoom | undefined): void {
		if (!room || !supports(room, "invite") || this.#busy) return;
		this.#invite.open(room.name, room.name);
	}

	#optionsFor(id: IrcConversationId): void {
		if (id === IRC_TRAFFIC_ID || this.#busy) return;
		const room = this.#room(id);
		const pinned = this.#model.conversations().some(item => item.id === id && item.pinned);
		const choices: Choice[] = [{ label: label(pinned ? "unpin" : "pin"), run: () => this.#model.setPinned(id, !pinned) }];
		if ((room && supports(room, "notifications")) || otherIrcDmPeer(id, this.#host.operatorId)) choices.push({ label: label("notifications"), run: () => {
			const current = this.#model.notificationLevel(id);
			this.#choices(label("notifications"), IRC_NOTIFICATION_LEVELS.map(level => ({
				label: `${level === current ? "✓ " : ""}${label(`level.${level}`)}`,
				run: () => { void this.#act({ kind: "notifications", conversationId: id, level }); },
			})));
		} });
		if (room && supports(room, "invite")) choices.push({ label: label("invite"), run: () => this.#inviteRoom(room) });
		if (room && supports(room, "leave")) choices.push({ label: label("leave"), run: () => {
			this.#choices(this.#title(id), [{ label: label("leave"), run: () => { void this.#act({ kind: "leave", room: room.name }); } }], true);
		} });
		this.#choices(this.#title(id), choices);
	}

	#memberMenu(room: IrcClientRoom, member: IrcClientMember): void {
		if (this.#busy) return;
		const id = ircRoomId(room.name);
		const choices: Choice[] = [];
		if (this.#canSend(id)) choices.push({ label: label("mention"), run: () => {
			this.#activate(id, false);
			this.#editor(id).insertText(`@${member.name} `);
		} });
		const operator = this.#host.operatorId;
		if (operator && operator !== member.id) choices.push({ label: label("direct_message"), run: () => this.#activate(ircDmId(operator, member.id)) });
		if (member.permissions && supports(room, "permissions")) {
			choices.push({ label: label("permissions"), run: () => this.#permissions(room, member) });
		}
		if (supports(room, "mute")) choices.push({ label: label(member.muted ? "unmute" : "mute"), run: () => this.#toggleMute(room, member) });
		if (supports(room, "remove")) choices.push({ label: label("remove"), run: () => {
			this.#choices(sanitizeDisplaySingleLine(member.name), [{ label: label("remove"), run: () => {
				void this.#act({ kind: "remove", room: room.name, memberId: member.id });
			} }], true);
		} });
		if (choices.length) this.#choices(sanitizeDisplaySingleLine(member.name), choices);
	}

	#permissions(room: IrcClientRoom, member: IrcClientMember): void {
		const permissions = member.permissions;
		if (!permissions || !supports(room, "permissions")) return;
		this.#choices(label("permissions"), PERMISSIONS.map(permission => ({
			label: `${permissions[permission] ? theme.checkbox.checked : theme.checkbox.unchecked} ${label(`permission.${permission}`)}`,
			run: () => {
				void this.#act({ kind: "permission", room: room.name, memberId: member.id, permission, enabled: !permissions[permission] }, () => {
					const current = this.#host.rooms().find(item => item.name === room.name);
					const updated = current?.members.find(item => item.id === member.id);
					if (current && updated) this.#permissions(current, updated);
				});
			},
		})));
	}

	#toggleMute(room: IrcClientRoom, member: IrcClientMember): void {
		if (supports(room, "mute")) void this.#act({ kind: "mute", room: room.name, memberId: member.id, muted: !member.muted });
	}

	async #act(action: IrcClientAction, onSuccess?: () => void): Promise<boolean> {
		if (this.#busy) return false;
		const opening = this.#opening;
		this.#busy = true;
		this.#error = undefined;
		this.options.requestRender();
		let error: string | undefined;
		try {
			error = await this.#host.act(action);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			this.#busy = false;
		}
		if (this.#disposed) return false;
		this.#error = error === undefined ? undefined : sanitizeDisplaySingleLine(error || label("action_failed"));
		if (this.#open) {
			if (error === undefined) {
				this.#refresh();
				if (opening === this.#opening) onSuccess?.();
			}
			this.options.requestRender();
		}
		return error === undefined;
	}

	#cycle(delta: -1 | 1): void {
		const regions: Region[] = ["sidebar", "center"];
		const active = this.#page === "roster" ? this.#roster.selectedItem?.id : this.#model.selected;
		if (active && this.#room(active)?.members.length) regions.push("members");
		const current = regions.indexOf(this.#region);
		this.#region = regions[(current + delta + regions.length) % regions.length]!;
		this.#previewEnabled = false;
		this.#refresh();
	}

	handleInput(data: string): void {
		if (!this.#open) return;
		try {
			this.#handleInput(data);
		} finally {
			this.options.requestRender();
		}
	}

	#handleInput(data: string): void {
		if (this.options.viewerKeys?.some(key => matchesKey(data, key))) {
			this.options.onClose();
			return;
		}
		if (this.options.trafficKeys?.some(key => matchesKey(data, key))) {
			this.open("traffic");
			return;
		}
		if (this.#invite.isOpen) {
			this.#invite.handleInput(data);
			return;
		}
		const kb = getKeybindings();
		if (this.#popup?.type === "create") {
			const popup = this.#popup;
			if (kb.matches(data, "tui.select.cancel")) this.#popup = undefined;
			else if (kb.matches(data, "tui.select.confirm")) {
				const room = popup.input.getValue().trim().replace(/^#/, "");
				if (!room || this.#busy || isKeyRepeat(data)) return;
				void this.#act({ kind: "create", room }, () => {
					if (this.#popup === popup) this.#activate(ircRoomId(room), false);
				});
			} else if (!this.#busy) popup.input.handleInput(data);
			return;
		}
		if (this.#search.focused) {
			this.#search.handleInput(data);
			this.#previewEnabled = true;
			this.#refresh();
			return;
		}
		const action = this.#keys.read(data);
		if (this.#popup?.type === "choices") {
			const { list, viewport } = this.#popup;
			if (action && action !== "pending" && applyMenuMotion(action, list, viewport).handled) return;
			if (action && action !== "pending" && action.kind === "cancel") this.#popup = undefined;
			if (action && action !== "pending" && action.kind === "confirm" && !isKeyRepeat(data)) {
				const choice = list.selectedItem;
				this.#popup = undefined;
				choice?.run?.();
			}
			return;
		}
		const editor = this.#page !== "roster" && this.#region === "center" && this.#canSend(this.#model.selected) ? this.#editor(this.#model.selected) : undefined;
		if (action && action !== "pending" && action.kind === "page" && this.#page !== "roster") {
			(this.#preview() ? this.#previewFeed : this.#feed).page(action.delta);
			return;
		}
		if (action && action !== "pending" && action.kind === "context" && (action.delta < 0 || !editor?.isAutocompleteActive())) {
			this.#cycle(action.delta);
			return;
		}
		if (action && action !== "pending" && action.kind === "cancel") {
			if (editor?.isAutocompleteActive() || editor?.vimConsumesEscape()) editor.handleInput(data);
			else if (editor) this.#region = "sidebar";
			else if (this.#search.value) {
				this.#search.setValue("");
				this.#refresh();
			} else if (this.#page !== "quick") {
				this.#page = "quick";
				this.#region = "sidebar";
				this.#previewEnabled = false;
				this.#refresh(this.#model.selected);
			} else this.options.onClose();
			return;
		}
		if (editor) {
			if (!this.#busy && !(isKeyRepeat(data) && kb.matches(data, "tui.input.submit"))) editor.handleInput(data);
			return;
		}
		if (action === "pending") return;
		if (action?.kind === "confirm" && isKeyRepeat(data)) return;
		const target = this.#displayId() ?? this.#model.selected;
		if (this.#region === "members") {
			if (action && applyMenuMotion(action, this.#members, this.#membersView).handled) return;
			const room = this.#room(target);
			const member = this.#members.selectedItem;
			if (matchesKey(data, "i")) this.#inviteRoom(room);
			else if (room && member) {
				if (action?.kind === "confirm") this.#memberMenu(room, member);
				else if (matchesKey(data, "m")) this.#toggleMute(room, member);
			}
			return;
		}
		if (this.#page === "roster" && this.#region === "center") {
			if (action && applyMenuMotion(action, this.#roster, this.#rosterView).handled) { this.#refresh(); return; }
			if (action?.kind === "confirm" && this.#roster.selectedItem) this.#activate(this.#roster.selectedItem.id);
			else if (action?.kind === "search") this.#search.focused = true;
			else if (matchesKey(data, "f")) { this.#filter = (this.#filter + 1) % FILTERS.length; this.#refresh(); }
			else if (matchesKey(data, "s")) { this.#sort = (this.#sort + 1) % SORTS.length; this.#rosterView.reveal(); this.#refresh(); }
			else this.#shortcuts(data, target);
			return;
		}
		if (this.#region === "sidebar") {
			if (action && applyMenuMotion(action, this.#sidebar, this.#sidebarView).handled) {
				this.#previewEnabled = true;
				this.#refresh();
				return;
			}
			const selected = this.#sidebar.selectedItem;
			if (action?.kind === "search") this.#search.focused = true;
			else if (action?.kind === "confirm" && selected?.type === "conversation") this.#activate(selected.key);
			else if (action?.kind === "confirm" && selected?.type === "shortcut") {
				switch (selected.key) {
					case "new_room": this.#create(); break;
					case "roster": this.#openRoster(); break;
					case "see_all": this.#openRoster(this.#lastVisibleRoom); break;
					case "open_dms":
						this.#page = "dms";
						this.#sidebarView.setTop(undefined);
						this.#refresh();
						this.#previewEnabled = true;
						break;
				}
			} else this.#shortcuts(data, selected?.type === "conversation" ? selected.key : target);
			return;
		}
		const entries = this.#model.entries();
		if (action?.kind === "move" || action?.kind === "halfPage") this.#feed.move(entries, action.delta * (action.kind === "move" ? 1 : 4));
		else if (action?.kind === "scroll") this.#feed.scroll(action.delta);
		else if (action?.kind === "boundary") this.#feed.select(entries, action.edge === "first" ? 0 : entries.length - 1);
		else if (action?.kind === "confirm" && target === IRC_TRAFFIC_ID) {
			const entry = this.#feed.selected(entries);
			if (entry) {
				const id = ircEntryConversationId(entry);
				if (id !== IRC_TRAFFIC_ID) {
					const inConversation = this.#model.entries(id);
					this.#activate(id, true, ircEntryId(inConversation.at(-1) ?? entry) === ircEntryId(entry) ? undefined : ircEntryId(entry));
				}
			}
		} else this.#shortcuts(data, target);
	}

	#shortcuts(data: string, id: IrcConversationId): void {
		const kb = getKeybindings();
		if (kb.matches(data, "app.session.pin")) this.#model.setPinned(id, true);
		else if (kb.matches(data, "app.session.unpin")) this.#model.setPinned(id, false);
		else if (matchesKey(data, "n")) this.#create();
		else if (matchesKey(data, "o")) this.#optionsFor(id);
		else if (matchesKey(data, "i")) this.#inviteRoom(this.#room(id));
	}

	render(width: number): readonly string[] {
		if (!this.#open || width < 5) return [];
		const height = Math.max(5, this.options.maxRows());
		this.#sidebarRows = height - 4;
		this.#refresh();
		if (this.#invite.isOpen) {
			this.#invite.refresh();
			return this.#invite.render(width);
		}
		if (this.#popup) return this.#renderPopup(width, height);
		const inner = width - 2;
		const id = this.#displayId() ?? this.#model.selected;
		const room = this.#room(id);
		const preview = this.#preview() !== undefined;
		const mainRows = height - 4;
		const showSidebar = inner >= 2 * MIN_PANE_WIDTH + 1 || this.#region === "sidebar" && this.#page !== "roster";
		const showMembers = inner >= 3 * MIN_PANE_WIDTH + 2 || this.#region === "members";
		const sidebarWidth = showSidebar ? Math.min(26, Math.max(MIN_PANE_WIDTH, Math.floor(inner / 4))) : 0;
		const membersWidth = showMembers ? Math.min(32, Math.max(MIN_PANE_WIDTH, Math.floor(inner / 4))) : 0;
		const sideOnly = inner < 2 * MIN_PANE_WIDTH + 1 && showSidebar;
		const membersOnly = showMembers && inner < 3 * MIN_PANE_WIDTH + 2;
		const centerWidth = Math.max(1, inner - sidebarWidth - membersWidth - Number(showSidebar) - Number(showMembers));
		const columns: { width: number; lines: readonly string[] }[] = [];
		if (showSidebar && !membersOnly) {
			const columnWidth = sideOnly ? inner : sidebarWidth;
			columns.push({ width: columnWidth, lines: this.#renderSidebar(columnWidth, mainRows) });
		}
		if (!sideOnly && !membersOnly) {
			columns.push({ width: centerWidth, lines: this.#page === "roster" ? this.#renderRoster(centerWidth, mainRows) : this.#renderConversation(id, room, centerWidth, mainRows, preview) });
		}
		if (showMembers) {
			const columnWidth = membersOnly ? inner : membersWidth;
			columns.push({ width: columnWidth, lines: this.#renderMembers(room, columnWidth, mainRows) });
		}
		// Only the activated conversation at the live edge marks arrivals read.
		if (!sideOnly && !membersOnly && this.focused && this.#page !== "roster" && !preview && this.#feed.following) {
			this.#model.markRead();
		}
		const vertical = theme.fg("border", theme.boxRound.vertical);
		const lines = [topBorder(width, "IRC")];
		for (let i = 0; i < mainRows; i++) lines.push(`${vertical}${columns.map(column => fit(column.lines[i] ?? "", column.width)).join(vertical)}${vertical}`);
		const hint = this.#search.focused ? this.#search.render(Math.max(1, inner - 2), SEARCH_THEME) : theme.fg("dim", this.#hints(room));
		lines.push(row(this.#page !== "roster" && !this.#search.focused && this.#search.value ? `${label("search")}: ${sanitizeDisplaySingleLine(this.#search.value)}  ${hint}` : hint, width));
		lines.push(row(this.#error ? theme.fg("error", this.#error) : this.#busy ? label("working") : "", width));
		lines.push(bottomBorder(width));
		return lines;
	}

	#hints(room: IrcClientRoom | undefined): string {
		const kb = getKeybindings();
		const keys = {
			move: getMenuSearchVimMode() ? "↑↓/jk" : "↑↓",
			context: formatKeyHints(kb.getKeys("tui.select.nextContext")),
			confirm: formatKeyHints(kb.getKeys("tui.select.confirm")),
			search: formatKeyHints(kb.getKeys("tui.select.search")),
			submit: formatKeyHints(kb.getKeys("tui.input.submit")),
		};
		if (this.#region === "members") return `${label("hint.members", keys)}${room && supports(room, "invite") ? `  ${label("hint.invite")}` : ""}${room && supports(room, "mute") ? `  ${label("hint.mute")}` : ""}`;
		if (this.#page === "roster" && this.#region === "center") return label("hint.roster", keys);
		if (this.#region === "sidebar") return `${label("hint.sidebar", keys)}${this.#host.canCreate ? `  ${label("hint.create")}` : ""}${room && supports(room, "invite") ? `  ${label("hint.invite")}` : ""}`;
		return label(this.#canSend(this.#model.selected) ? "hint.compose" : this.#model.selected === IRC_TRAFFIC_ID ? "hint.traffic" : "hint.read_only", keys);
	}

	#heading(text: string, focused: boolean): string {
		return ` ${theme.fg(focused ? "accent" : "muted", theme.bold(text))}`;
	}

	#renderSidebar(width: number, height: number): string[] {
		const lines = [this.#heading(label(this.#page === "dms" ? "open_dms_title" : "conversations"), this.#region === "sidebar")];
		const items = this.#sidebar.visibleItems;
		const window = this.#sidebarView.layout(items.map(() => 1), this.#sidebar.selectedIndex, height - 1);
		for (let i = window.startIndex; i < window.endIndex; i++) {
			const item = items[i]!;
			if (item.type === "group") { lines.push(theme.fg("dim", ` ─ ${item.text}`)); continue; }
			const cursor = this.#region === "sidebar" && i === this.#sidebar.selectedIndex;
			const active = item.type === "conversation" && item.key === this.#model.selected;
			const unread = item.type === "conversation" ? item.conversation?.unread ?? (item.key === IRC_TRAFFIC_ID ? this.#model.unread() : 0) : 0;
			const pin = item.type === "conversation" && item.conversation?.pinned ? "★ " : "";
			const envelope = unread && item.type === "conversation" && item.conversation?.kind === "dm" ? "✉ " : "";
			const quiet = item.type === "conversation" && item.key !== IRC_TRAFFIC_ID && this.#model.notificationLevel(item.key) === "none";
			const count = unread ? ` ${unread} ` : "";
			const text = fit(`${cursor ? "›" : active ? "▏" : " "} ${pin}${envelope}${item.text}`, Math.max(0, width - visibleWidth(count)));
			const title = cursor ? theme.fg("accent", theme.bold(text)) : unread && !quiet ? theme.fg("accent", text) : active ? text : theme.fg("muted", text);
			lines.push(`${title}${quiet ? theme.fg("dim", count) : cursor || unread ? theme.fg("accent", count) : count}`);
		}
		if (items.length === 0) lines.push(` ${theme.fg("dim", label("no_dms"))}`);
		return lines;
	}

	#renderRoster(width: number, height: number): string[] {
		const list = this.#roster.visibleItems;
		const rows = [
			this.#heading(label("roster"), this.#region === "center"),
			` ${theme.fg("muted", label("roster_view", { filter: label(`filter.${FILTERS[this.#filter]}`), sort: label(`sort.${SORTS[this.#sort]}`) }))}`,
		];
		const window = this.#rosterView.layout(list.map(() => 2), this.#roster.selectedIndex, height - 2);
		let skip = window.lineOffset;
		for (let i = window.startIndex; i < window.endIndex; i++) {
			const item = list[i]!;
			const room = this.#rooms.get(item.room);
			const cursor = i === this.#roster.selectedIndex;
			const unread = item.unread ? `  ${label("unread", { count: item.unread })}` : "";
			const first = `${cursor ? "›" : " "} ${item.pinned ? "★ " : ""}${this.#title(item.id)}`;
			const count = this.#model.notificationLevel(item.id) === "none" ? theme.fg("dim", unread) : cursor ? theme.fg("accent", unread) : unread;
			const details = [label("member_count", { count: room?.members.length ?? 0 }), label(room?.joined ? "joined" : "not_joined")];
			if (room?.notifications) details.push(label(`level.${room.notifications}`));
			if (item.lastMessageAt !== undefined) details.push(clockTime(item.lastMessageAt));
			const itemRows = [`${cursor ? theme.fg("accent", first) : first}${count}`, `   ${theme.fg("muted", details.join(" · "))}`];
			rows.push(...itemRows.slice(skip));
			skip = 0;
		}
		if (!list.length) rows.push(` ${theme.fg("dim", label("no_rooms"))}`);
		return rows.slice(0, height).map(line => truncateToWidth(line, width));
	}

	#renderConversation(id: IrcConversationId, room: IrcClientRoom | undefined, width: number, height: number, preview: boolean): string[] {
		const entries = this.#model.entries(id);
		const canSend = !preview && this.#canSend(id);
		const attributes = [];
		if (preview) attributes.push(label("preview"));
		if (room) attributes.push(label("member_count", { count: room.members.length }));
		if (room?.notifications) attributes.push(label(`level.${room.notifications}`));
		if (otherIrcDmPeer(id, this.#host.operatorId)) attributes.push(label(`level.${this.#model.notificationLevel(id)}`));
		const heading = `${this.#heading(this.#title(id), this.#region === "center")}${attributes.length ? theme.fg("dim", `  ${attributes.join(" · ")}`) : ""}`;
		let composer: readonly string[] = [];
		if (canSend && height >= 5 && width >= 8) {
			const editor = this.#editor(id);
			editor.focused = this.focused && this.#region === "center";
			editor.setUseTerminalCursor(this.#terminalCursor);
			editor.setVimMode(getMenuSearchVimMode());
			editor.setMaxHeight(Math.max(1, Math.floor(height / 4)));
			editor.viewportRowsProvider = () => height - 1;
			composer = editor.render(width).slice(0, height - 2);
		} else if (height >= 3 && id !== IRC_TRAFFIC_ID) {
			composer = [theme.fg("dim", ` ${label(preview ? "preview_only" : "read_only")}`)];
		}
		const budget = Math.max(1, height - 1 - composer.length);
		const feed = preview ? this.#previewFeed : this.#feed;
		const traffic = id === IRC_TRAFFIC_ID;
		const showMessageCursor = !preview && this.#region === "center" && (traffic || !feed.following);
		const lines = feed.render(entries, width, budget, showMessageCursor, id => this.#name(id), traffic);
		if (!entries.length) lines.push(theme.fg("dim", ` ${label("no_messages")}`));
		while (lines.length < budget) lines.push("");
		return [heading, ...lines, ...composer];
	}

	#renderMembers(room: IrcClientRoom | undefined, width: number, height: number): string[] {
		const lines = [this.#heading(label("members"), this.#region === "members")];
		const members = this.#members.visibleItems;
		const window = this.#membersView.layout(members.map(() => 3), this.#members.selectedIndex, height - 1);
		let skip = window.lineOffset;
		for (let i = window.startIndex; i < window.endIndex; i++) {
			const member = members[i]!;
			const name = sanitizeDisplaySingleLine(member.name);
			const tags = [];
			if (member.muted) tags.push(label("badge.muted"));
			if (member.permissions?.send === false) tags.push(label("badge.read_only"));
			if (member.permissions?.admin) tags.push(label("badge.admin"));
			const details = [member.agentType, member.displayModelSlug ?? member.modelSlug].filter(Boolean).join(" · ");
			const memberRows = [
				`${i === this.#members.selectedIndex && this.#region === "members" ? theme.fg("accent", "›") : " "}${statusGlyph(member.status)} ${member.color?.(name) ?? agentColored(theme, member.id, name)}${tags.length ? theme.fg("muted", ` ${tags.join(" ")}`) : ""}`,
				`   ${theme.fg("muted", sanitizeDisplaySingleLine(details))}`,
				`   ${theme.fg("dim", sanitizeDisplaySingleLine(member.activity ?? ""))}`,
			];
			lines.push(...memberRows.slice(skip));
			skip = 0;
		}
		if (!room) lines.push(` ${theme.fg("dim", label("no_room_selected"))}`);
		else if (!members.length) lines.push(` ${theme.fg("dim", label("no_members"))}`);
		return lines.slice(0, height).map(line => truncateToWidth(line, width));
	}

	#renderPopup(width: number, height: number): string[] {
		const popup = this.#popup!;
		const lines = [topBorder(width, popup.title)];
		if (popup.type === "create") {
			popup.input.setUseTerminalCursor(this.#terminalCursor);
			lines.push(row(popup.input.render(Math.max(1, width - 4))[0] ?? "", width));
		} else {
			const items = popup.list.visibleItems;
			const window = popup.viewport.layout(items.map(() => 1), popup.list.selectedIndex, height - 3);
			for (let i = window.startIndex; i < window.endIndex; i++) {
				const text = `${i === popup.list.selectedIndex ? "›" : " "} ${items[i]!.label}`;
				lines.push(row(i === popup.list.selectedIndex ? theme.fg("accent", text) : text, width));
			}
		}
		if (this.#error) lines.push(row(theme.fg("error", this.#error), width));
		else if (this.#busy) lines.push(row(label("working"), width));
		lines.push(bottomBorder(width));
		return lines;
	}
}
