import { Container, ScrollView, TruncatedText } from "../index";
import { compileMenuRegex } from "../menu-search";
import { theme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { MenuSelection } from "../components/menu-selection";
import {
	applyMenuMotion,
	MenuKeyReader,
	MenuSearchField,
	MenuViewport,
	type MenuViewportPosition,
} from "../components/menu-navigation";
import { formatKeyHint } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { node, span } from "../native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { CLOSE_ACTION, dockedPicker, PICKER_KEY, pickerAction, pickerEvent } from "../native/picker";
import type { TspPickerItem } from "@oh-my-pi/pi-wire";
import { actionHint, hintsRow, overlayCard } from "../native/overlay";

const LOGOUT_SELECTOR_MAX_VISIBLE = 10;

export interface LogoutAccount {
	credentialId: number;
	provider: string;
	label: string;
	detail: string;
	type: "api_key" | "oauth";
	active: boolean;
}

/** Account picker for `/logout` after the provider has been selected. */
export class LogoutAccountSelectorComponent extends OverlayPanel {
	#listContainer: Container;
	#menu: MenuSelection<LogoutAccount>;
	readonly #keys = new MenuKeyReader();
	readonly #viewport = new MenuViewport();
	readonly #search = new MenuSearchField();
	#onSelectCallback: (account: LogoutAccount) => void;
	#onCancelCallback: () => void;
	#nativeItems: readonly NativeNode[] | undefined;
	#nativeHints: NativeNode | undefined;
	#nativeRoot: NativeNode | undefined;
	#pickerRoot: NativeNode | undefined;
	#pickerItems: readonly TspPickerItem[] | undefined;
	readonly #providerName: string;
	readonly #accounts: readonly LogoutAccount[];

	constructor(
		providerName: string,
		accounts: LogoutAccount[],
		onSelect: (account: LogoutAccount) => void,
		onCancel: () => void,
	) {
		super(`Select ${providerName} account to log out`, "omp.overlay.logout");
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#providerName = providerName;
		this.#accounts = accounts;
		const active = accounts.find(account => account.active);
		this.#menu = new MenuSelection<LogoutAccount>(
			accounts,
			{
				getKey: account => String(account.credentialId),
				getSearchText: account => `${account.label} ${account.detail} ${account.provider}`,
			},
			active ? String(active.credentialId) : undefined,
		);

		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		this.#updateList();
	}

	#updateList(): void {
		this.#nativeRoot = undefined;
		this.#pickerRoot = undefined;
		this.#listContainer.clear();

		const items = this.#menu.visibleItems;
		const total = items.length;
		const maxVisible = LOGOUT_SELECTOR_MAX_VISIBLE;
		const { startIndex, endIndex } = this.#viewport.layout(
			items.map(() => 1),
			this.#menu.selectedIndex,
			maxVisible,
		);

		const rows: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const account = items[i];
			if (!account) continue;
			const activeTag = account.active ? theme.fg("muted", " (active)") : "";
			const detail = account.detail ? theme.fg("dim", `  ${account.detail}`) : "";
			if (i === this.#menu.selectedIndex) {
				rows.push(`${theme.fg("accent", `${theme.nav.cursor} ${account.label}`)}${activeTag}${detail}`);
			} else {
				rows.push(`  ${account.label}${activeTag}${detail}`);
			}
		}

		if (rows.length > 0) {
			const sv = new ScrollView(rows, {
				height: rows.length,
				scrollbar: "auto",
				totalRows: total,
				theme: { track: text => theme.fg("muted", text), thumb: text => theme.fg("accent", text) },
			});
			sv.setScrollOffset(startIndex);
			this.#listContainer.addChild(sv);
		}

		if (total === 0) {
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", "No stored accounts to log out"), 0, 0));
		}
		if (this.#search.focused || this.#menu.query) {
			this.#listContainer.addChild(
				new TruncatedText(this.#search.render(72, { muted: text => theme.fg("muted", text) }), 0, 0),
			);
		}

		this.#listContainer.addChild(
			new TruncatedText(
				theme.fg(
					"muted",
					`j/k or ${editorKeys("tui.select.up", "tui.select.down")} select · / search · ${formatKeyHint("enter")} log out account · ${editorKey("tui.select.cancel")} cancel`,
				),
				0,
				0,
			),
		);
	}

	navigationSnapshot(): unknown {
		return {
			selectedKey: this.#menu.selectedKey,
			search: this.#search.navigationSnapshot(),
			viewportTop: this.#viewport.top,
		};
	}

	restoreNavigation(snapshot: unknown): void {
		if (typeof snapshot !== "object" || snapshot === null) return;
		const state = snapshot as { selectedKey?: string; search?: unknown; viewportTop?: MenuViewportPosition | number };
		this.#search.restoreNavigation(state.search);
		this.#menu.setQuery(this.#search.value);
		if (state.selectedKey !== undefined) this.#menu.setSelectedKey(state.selectedKey);
		this.#viewport.setTop(state.viewportTop);
		this.#nativeItems = undefined;
		this.#updateList();
	}

	handleInput(data: string): void {
		const before = this.#search.value;
		const field = this.#search.handleInput(data);
		if (field !== "pass") {
			if (this.#search.value !== before) {
				this.#menu.setQuery(this.#search.value);
				this.#viewport.reveal();
				this.#nativeItems = undefined;
			}
			this.#updateList();
			return;
		}
		const action = this.#keys.read(data);
		if (action === undefined || action === "pending") return;
		if (applyMenuMotion(action, this.#menu, this.#viewport, { wrap: true }).handled) this.#updateList();
		else if (action.kind === "search") {
			this.#search.focused = true;
			this.#updateList();
		} else if (action.kind === "cancel") this.#onCancelCallback();
		else if (action.kind === "confirm") this.#confirmSelection();
	}

	#confirmSelection(): void {
		const account = this.#menu.selectedItem;
		if (!account) return;
		this.#onSelectCallback(account);
	}

	override describe(cx: DescribeContext): NativeNode {
		if (cx.supports("picker")) {
			this.#pickerRoot ??= dockedPicker({
				title: `${this.#providerName} accounts`,
				subtitle: compileMenuRegex(this.#search.value)?.error ?? "Pick the account to sign out",
				icon: "key-round",
				noun: "accounts",
				size: "md",
				layout: "cards",
				preview: "none",
				query: this.#menu.query,
				order: this.#menu.visibleItems.map(account => String(account.credentialId)),
				items: (this.#pickerItems ??= this.#accounts.map(account => ({
					id: String(account.credentialId),
					label: account.label,
					...(account.detail ? { detail: account.detail } : {}),
					badges: [{ text: account.type === "oauth" ? "login" : "api key" }],
				}))),
				current: this.#accounts.filter(account => account.active).map(account => String(account.credentialId)),
				selected: this.#menu.selectedKey ?? null,
				empty: "No stored accounts to log out",
				actions: [
					pickerAction("confirm", "Sign out", "enter", { primary: true, danger: true }),
					{ ...CLOSE_ACTION, label: this.#search.focused ? "Back to list" : "Close" },
				],
			});
			return this.#pickerRoot;
		}
		if (this.#nativeRoot) return this.#nativeRoot;
		this.#nativeItems ??= this.#menu.visibleItems.map(account =>
			node(
				"item",
				{
					label: account.label,
					detail: account.detail || undefined,
					value: account.active ? [span("active", "muted")] : undefined,
				},
				undefined,
				String(account.credentialId),
			),
		);
		this.#nativeRoot = overlayCard(this.nativeRole, this.title, [
			node(
				"list",
				{
					selected: this.#menu.selectedKey ?? null,
					empty: compileMenuRegex(this.#search.value)?.error ?? "No stored accounts to log out",
					max: { lines: LOGOUT_SELECTOR_MAX_VISIBLE },
				},
				this.#nativeItems,
				"list",
			),
			(this.#nativeHints ??= hintsRow([
				actionHint(["tui.select.up", "tui.select.down"], "select"),
				{ keys: ["enter"], label: "log out account" },
				actionHint("tui.select.cancel", "cancel"),
			])),
		]);
		return this.#nativeRoot;
	}

	/** A click (or double-click) on an account highlights it and logs it out, like Enter. */
	handleNativeEvent(event: NativeUiEvent): void {
		const ev = pickerEvent(event, PICKER_KEY);
		if (ev?.kind === "action") {
			if (ev.act === "confirm") this.#confirmSelection();
			else if (ev.act === "close" || ev.act === "cancel") this.handleInput("\x1b");
			return;
		}
		if (ev?.kind === "select") {
			this.#menu.setSelectedKey(ev.item);
			this.#viewport.reveal();
			this.#updateList();
			return;
		}
		if ((event.type !== "select" && event.type !== "activate") || (event.key !== "list" && ev?.kind !== "activate"))
			return;
		this.#menu.setSelectedKey(event.item);
		this.#viewport.reveal();
		if (this.#menu.selectedKey !== event.item) return;
		this.#updateList();
		this.#confirmSelection();
	}
}
