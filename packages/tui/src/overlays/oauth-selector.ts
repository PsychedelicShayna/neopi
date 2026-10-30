import type { CredentialsApi, KeysApi } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth/types";
import { Container, ScrollView, type SgrMouseEvent, Spacer, TruncatedText } from "../index";
import { theme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { MenuSelection } from "../components/menu-selection";
import { MenuHelp, MenuHints } from "../components/menu-hints";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import {
	applyMenuMotion,
	MenuKeyReader,
	MenuSearchField,
	MenuViewport,
	type MenuViewportPosition,
} from "../components/menu-navigation";
import type { TspPickerAction, TspPickerItem, TspSpan, TspText, TspTone } from "@oh-my-pi/pi-wire";
import { node, span, text } from "../native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { CLOSE_ACTION, dockedPicker, PICKER_KEY, pickerAction, pickerEvent, pickerQuery } from "../native/picker";
import { overlayCard } from "../native/overlay";
import { isNativeRendering } from "../native/state";

const OAUTH_SELECTOR_MAX_VISIBLE = 10;

/** Credential presence and provenance needed by the provider picker. */
export interface OAuthSelectorAuthSource {
	readonly credentials: Pick<CredentialsApi, "has">;
	readonly keys: Pick<KeysApi, "source">;
}

/**
 * How a host other than `/login` presents the native provider sheet (the
 * setup wizard): its heading, `role` and size, a status line docked above the
 * action bar, and the Esc action that leaves in place of Close (the action's
 * `id` cancels like Esc).
 */
export interface OAuthSelectorSheet {
	readonly title: string;
	readonly subtitle: TspText;
	readonly role: string;
	readonly size: "md" | "lg";
	readonly status?: TspText;
	readonly leave: { readonly id: string; readonly label: string };
}

/**
 * Rendered lines before the provider rows: top border
 * (must mirror the constructor's addChild order).
 */
const LIST_ROW_OFFSET = 1;

/** Compact, human-readable tag for each credential-origin leg. */
const ORIGIN_LABELS = {
	runtime: "--api-key",
	config: "config",
	oauth: "login",
	api_key: "api key",
	env: "env",
};
/**
 * Component that renders an OAuth provider selector.
 */
export class OAuthSelectorComponent extends OverlayPanel {
	#listContainer: Container;
	/** Provider rows viewport of the last {@link #updateList}; spinner ticks repaint only its rows. */
	#listView: ScrollView | undefined;
	#menu: MenuSelection<OAuthProviderInfo>;
	/** The provider search field; its value drives `#menu`'s query. */
	readonly #search = new MenuSearchField();
	readonly #help = new MenuHelp("jk gg/G C-u d e y");
	#hoveredIndex: number | null = null;
	/** First provider index of the visible ScrollView window (last #updateList). */
	#scrollStart = 0;
	#visibleCount = 0;
	/** Visible list window, shrunk by {@link setMaxHeight} on short screens. */
	#maxVisible = OAUTH_SELECTOR_MAX_VISIBLE;
	readonly #navigationKeys = new MenuKeyReader();
	readonly #viewport = new MenuViewport();
	#mode: "login" | "logout";
	#authStorage: OAuthSelectorAuthSource;
	#onSelectCallback: (providerId: string) => void;
	#onCancelCallback: () => void;
	#cancelLabel: string;
	#statusMessage: string | undefined;
	#validateAuthCallback?: (providerId: string) => Promise<boolean>;
	#requestRenderCallback?: () => void;
	#authState: Map<string, "checking" | "valid" | "invalid"> = new Map();
	#spinnerFrame: number = 0;
	#spinnerInterval?: NodeJS.Timeout;
	#validationGeneration: number = 0;
	#nativeItems: readonly NativeNode[] | undefined;
	/** The `visibleItems` array {@link #nativeItems} was built from. */
	#nativeItemsSource: readonly OAuthProviderInfo[] | undefined;
	#nativeRoot: NativeNode | undefined;
	/** Picker rows for the whole catalogue; dropped when an auth state changes. */
	#pickerItems: readonly TspPickerItem[] | undefined;
	#pickerRoot: NativeNode | undefined;
	#sheet: OAuthSelectorSheet | undefined;
	constructor(
		mode: "login" | "logout",
		authStorage: OAuthSelectorAuthSource,
		onSelect: (providerId: string) => void,
		onCancel: () => void,
		options?: {
			disabledProviders?: readonly string[];
			validateAuth?: (providerId: string) => Promise<boolean>;
			requestRender?: () => void;
			cancelLabel?: string;
			sheet?: OAuthSelectorSheet;
		},
	) {
		super(mode === "login" ? "Select provider to login" : "Select provider to logout", "omp.overlay.oauth");
		this.#mode = mode;
		this.#authStorage = authStorage;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#cancelLabel = options?.cancelLabel ?? "close";
		this.#validateAuthCallback = options?.validateAuth;
		this.#requestRenderCallback = options?.requestRender;
		this.#sheet = options?.sheet;
		this.#menu = new MenuSelection<OAuthProviderInfo>([], {
			getKey: provider => provider.id,
			getSearchText: provider => this.#getProviderSearchText(provider),
		});
		// Load all OAuth providers
		this.#loadProviders(options?.disabledProviders);
		// Create list container
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		// Initial render
		this.#updateList();
		this.#startValidation();
	}

	stopValidation(): void {
		this.#validationGeneration += 1;
		this.#stopSpinner();
	}

	/** Replace the native sheet's presentation (a new outcome line, a relabelled leave action). */
	setSheet(sheet: OAuthSelectorSheet): void {
		this.#sheet = sheet;
		this.#pickerRoot = undefined;
	}

	/** Re-read credential state after a sign-in stored one, keeping the query and selection. */
	refreshAuth(): void {
		this.#nativeItems = undefined;
		this.#pickerItems = undefined;
		this.#menu.setItems(this.#menu.items);
		this.#updateList();
	}

	/**
	 * Fit the selector into `lines` rendered rows by shrinking the visible list
	 * window (the window is centered on the selection, so the selected row is
	 * always visible at any height). Prefers keeping the full chrome — borders,
	 * spacers, title, search status — but sacrifices the trailing spacer/border
	 * (clipped by the host) before dropping below three visible rows.
	 */
	setMaxHeight(lines: number): void {
		// Above the rows: LIST_ROW_OFFSET; below: search status + border.
		const strict = lines - LIST_ROW_OFFSET - 2;
		// Keeps only the rows + search status inside `lines`.
		const relaxed = lines - LIST_ROW_OFFSET - 1;
		const rows = Math.min(OAUTH_SELECTOR_MAX_VISIBLE, Math.max(1, strict, Math.min(relaxed, 3)));
		if (rows === this.#maxVisible) return;
		this.#maxVisible = rows;
		this.#updateList();
	}
	#hasSelectableAuth(providerId: string): boolean {
		return this.#mode === "logout"
			? this.#authStorage.credentials.has(providerId)
			: this.#authStorage.keys.source(providerId) !== undefined;
	}

	#loadProviders(disabledProviders: readonly string[] = []): void {
		const providers = getOAuthProviders();
		if (this.#mode === "logout") {
			// Logout stays unfiltered by `disabledProviders`: a now-disabled
			// provider may still hold stored credentials worth removing.
			this.#menu.setItems(providers.filter(provider => this.#hasSelectableAuth(provider.id)));
		} else {
			const disabled = new Set(disabledProviders);
			// Hide a login entry when either its own id or the provider id it
			// stores credentials under is disabled, so alias logins (e.g.
			// `openai-codex-device` ⇒ `openai-codex`) disappear alongside the
			// model provider they authenticate.
			this.#menu.setItems(
				providers.filter(
					provider =>
						!disabled.has(provider.id) &&
						!(provider.storeCredentialsAs && disabled.has(provider.storeCredentialsAs)),
				),
			);
		}
	}

	#startValidation(): void {
		if (!this.#validateAuthCallback) return;
		const generation = this.#validationGeneration + 1;
		this.#validationGeneration = generation;

		let pending = 0;
		for (const provider of this.#menu.items) {
			if (!this.#hasSelectableAuth(provider.id)) {
				this.#authState.delete(provider.id);
				continue;
			}
			this.#authState.set(provider.id, "checking");
			this.#nativeItems = undefined;
			this.#pickerItems = undefined;
			pending += 1;
			void this.#validateProvider(provider.id, generation);
		}

		if (pending > 0) {
			this.#startSpinner();
			this.#updateList();
			this.#requestRenderCallback?.();
		}
	}

	async #validateProvider(providerId: string, generation: number): Promise<void> {
		if (!this.#validateAuthCallback) return;
		let isValid = false;
		try {
			isValid = await this.#validateAuthCallback(providerId);
		} catch {
			isValid = false;
		}

		if (generation !== this.#validationGeneration) return;
		this.#authState.set(providerId, isValid ? "valid" : "invalid");
		this.#nativeItems = undefined;
		this.#pickerItems = undefined;
		if (![...this.#authState.values()].includes("checking")) {
			this.#stopSpinner();
		}
		this.#updateList();
		this.#requestRenderCallback?.();
	}

	#startSpinner(): void {
		// Natively the "checking" status pulses on the terminal's clock.
		if (this.#spinnerInterval || isNativeRendering()) return;
		this.#spinnerInterval = setInterval(() => {
			const frameCount = theme.spinnerFrames.length;
			if (frameCount > 0) {
				this.#spinnerFrame = (this.#spinnerFrame + 1) % frameCount;
			}
			// Only the provider rows carry the spinner glyph; the window is unchanged.
			if (this.#listView) {
				const start = this.#scrollStart;
				this.#listView.setLines(this.#providerRows(start, start + this.#visibleCount));
			} else {
				this.#updateList();
			}
			this.#requestRenderCallback?.();
		}, 80);
	}

	#stopSpinner(): void {
		if (this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
		}
	}

	/**
	 * Muted provenance suffix (" (env: COPILOT_GITHUB_TOKEN)", " (login)", …) so
	 * the list distinguishes a real login from an env var aliasing the provider.
	 */
	#getSourceLabel(providerId: string): string {
		const origin = this.#authStorage.keys.source(providerId);
		if (!origin) return "";
		const detail = origin.kind === "env" && origin.envVar ? `env: ${origin.envVar}` : ORIGIN_LABELS[origin.kind];
		return theme.fg("muted", ` (${detail})`);
	}

	#getStatusIndicator(providerId: string): string {
		const state = this.#authState.get(providerId);
		const source = this.#getSourceLabel(providerId);
		if (state === "checking") {
			const frameCount = theme.spinnerFrames.length;
			const spinner = frameCount > 0 ? theme.spinnerFrames[this.#spinnerFrame % frameCount] : theme.status.pending;
			return theme.fg("warning", ` ${spinner} checking`) + source;
		}
		if (state === "invalid") {
			return theme.fg("error", ` ${theme.status.error} invalid`) + source;
		}
		if (state === "valid") {
			return theme.fg("success", ` ${theme.status.enabled} logged in`) + source;
		}
		return this.#hasSelectableAuth(providerId)
			? theme.fg("success", ` ${theme.status.enabled} logged in`) + source
			: "";
	}

	#isSearchEnabled(): boolean {
		return true;
	}

	#shouldRenderSearchStatus(): boolean {
		return this.#isSearchEnabled() || this.#menu.query.length > 0;
	}

	#renderStatusLine(_total: number): string {
		return this.#search.render(72, { muted: text => theme.fg("muted", text) });
	}

	#getProviderSearchText(provider: OAuthProviderInfo): string {
		let text = `${provider.name} ${provider.id}`;
		const origin = this.#authStorage.keys.source(provider.id);
		if (origin) {
			text += ` logged in authenticated ${ORIGIN_LABELS[origin.kind]}`;
			if (origin.envVar) text += ` ${origin.envVar}`;
		}
		if (!provider.available) {
			text += " unavailable";
		}
		return text;
	}

	/** Applies the confirmed search query to the filter; clears any stale status. */
	#syncSearchQuery(): void {
		this.#menu.setQuery(this.#search.query, false);
		this.#viewport.reveal();
		this.#statusMessage = undefined;
		this.#updateList();
	}

	#updateList(): void {
		this.#nativeRoot = undefined;
		this.#pickerRoot = undefined;
		this.#listContainer.clear();
		this.#listView = undefined;

		const total = this.#menu.visibleItems.length;
		const maxVisible = this.#maxVisible;
		const { startIndex, endIndex } = this.#viewport.layout(
			this.#menu.visibleItems.map(() => 1),
			this.#menu.selectedIndex,
			maxVisible,
		);
		this.#scrollStart = startIndex;
		this.#visibleCount = endIndex - startIndex;

		const rows = this.#providerRows(startIndex, endIndex);
		if (rows.length > 0) {
			const sv = new ScrollView(rows, {
				height: rows.length,
				scrollbar: "auto",
				totalRows: total,
				theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
			});
			sv.setScrollOffset(startIndex);
			this.#listView = sv;
			this.#listContainer.addChild(sv);
		}

		// Search status line (scrollbar covers overflow indication)
		if (this.#shouldRenderSearchStatus()) {
			this.#listContainer.addChild(
				!this.#search.focused && !this.#search.value
					? new MenuHints(
							() =>
								`${editorKeys("tui.select.up", "tui.select.down")} select · / search · Enter choose · ${editorKey("tui.select.cancel")} ${this.#cancelLabel} · ? help`,
							text => theme.fg("muted", text),
							"jk gg/G C-u d e y",
						)
					: new TruncatedText(this.#renderStatusLine(total), 0, 0),
			);
		}

		if (total === 0) {
			const message =
				this.#menu.items.length === 0
					? this.#mode === "login"
						? "No OAuth providers available"
						: "No stored provider credentials to log out"
					: "No matching providers";
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", message), 0, 0));
		}
		if (this.#statusMessage) {
			this.#listContainer.addChild(new Spacer(1));
			this.#listContainer.addChild(new TruncatedText(theme.fg("warning", this.#statusMessage), 0, 0));
		}
	}

	/** Styled rows for visible providers `[startIndex, endIndex)`: cursor, name, auth status and provenance. */
	#providerRows(startIndex: number, endIndex: number): string[] {
		const items = this.#menu.visibleItems;
		const rows: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const provider = items[i];
			if (!provider) continue;
			const isSelected = i === this.#menu.selectedIndex;
			const isAvailable = provider.available;
			const statusIndicator = this.#getStatusIndicator(provider.id);

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", `${theme.nav.cursor} `);
				const text = isAvailable ? theme.fg("accent", provider.name) : theme.fg("dim", provider.name);
				line = prefix + text + statusIndicator;
			} else {
				const text = isAvailable ? `  ${provider.name}` : theme.fg("dim", `  ${provider.name}`);
				line = text + statusIndicator;
			}
			if (!isSelected && i === this.#hoveredIndex) {
				line = theme.bg("selectedBg", line);
			}
			rows.push(line);
		}
		return rows;
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
		this.#navigationKeys.reset();
		this.#search.restoreNavigation(state.search);
		this.#menu.setQuery(this.#search.query, false);
		if (typeof state.selectedKey === "string") this.#menu.setSelectedKey(state.selectedKey);
		this.#viewport.setTop(state.viewportTop);
		this.#updateList();
	}

	leaveMenu(): void {
		this.#search.focused = false;
		this.stopValidation();
	}

	override render(width: number): readonly string[] {
		return this.#help.render(super.render(width), width);
	}

	handleInput(data: string): void {
		const before = this.#search.query;
		const field = this.#search.handleInput(data);
		if (field !== "pass") {
			if (this.#search.query !== before) this.#syncSearchQuery();
			else this.#updateList();
			return;
		}
		if (this.#help.handleInput(data)) {
			this.#requestRenderCallback?.();
			return;
		}
		const action = this.#navigationKeys.read(data);
		if (action === undefined || action === "pending") return;
		if (applyMenuMotion(action, this.#menu, this.#viewport, { wrap: true }).handled) {
			this.#statusMessage = undefined;
			this.#updateList();
			return;
		}
		switch (action.kind) {
			case "search":
				this.#search.focused = true;
				this.#navigationKeys.reset();
				this.#updateList();
				break;
			case "cancel":
				this.stopValidation();
				this.#onCancelCallback();
				break;
			case "confirm":
				this.#confirmSelection();
				break;
		}
	}

	/** Confirm the selected provider (Enter or mouse click). */
	#confirmSelection(): void {
		const selectedProvider = this.#menu.selectedItem;
		if (selectedProvider?.available) {
			this.#statusMessage = undefined;
			this.stopValidation();
			this.#onSelectCallback(selectedProvider.id);
		} else if (selectedProvider) {
			this.#statusMessage = "Provider unavailable in this environment.";
			this.#updateList();
		}
	}

	/** Credential status of a provider row: `value` (state) and `detail` (origin) spans. */
	#describeStatus(providerId: string): { value?: readonly TspSpan[]; detail?: readonly TspSpan[] } {
		const origin = this.#authStorage.keys.source(providerId);
		const detail = origin
			? [
					span(
						origin.kind === "env" && origin.envVar ? `env: ${origin.envVar}` : ORIGIN_LABELS[origin.kind],
						"muted",
					),
				]
			: undefined;
		const state = this.#authState.get(providerId);
		if (state === "checking") return { value: [span("checking", "warning", { fx: "pulse" })], detail };
		if (state === "invalid") return { value: [span("invalid", "error")], detail };
		if (state === "valid" || this.#hasSelectableAuth(providerId)) {
			return { value: [span("logged in", "success")], detail };
		}
		return { detail };
	}

	/** One provider card: initials mark, origin detail, auth-state dot, disabled reason. */
	#pickerItem(provider: OAuthProviderInfo): TspPickerItem {
		const origin = this.#authStorage.keys.source(provider.id);
		const state = this.#authState.get(provider.id);
		const dot: TspTone =
			state === "checking"
				? "pending"
				: state === "invalid"
					? "error"
					: state === "valid" || this.#hasSelectableAuth(provider.id)
						? "success"
						: "muted";
		const source = origin
			? origin.kind === "env" && origin.envVar
				? `env: ${origin.envVar}`
				: ORIGIN_LABELS[origin.kind]
			: undefined;
		const detail = !source
			? "Not configured"
			: origin?.kind === "oauth"
				? `Signed in · ${source}`
				: `API key · ${source}`;
		const initials = provider.name
			.split(/[^\p{L}\p{N}]+/u)
			.filter(word => word.length > 0)
			.slice(0, 2)
			.map(word => word[0]!.toUpperCase())
			.join("");
		return {
			id: provider.id,
			label: provider.name,
			detail,
			mark: { text: initials, seed: provider.id },
			dot,
			...(provider.available ? {} : { disabled: "Provider unavailable in this environment" }),
		};
	}

	#describePicker(): NativeNode {
		if (this.#pickerRoot) return this.#pickerRoot;
		const all = this.#menu.items;
		this.#pickerItems ??= all.map(provider => this.#pickerItem(provider));
		const query = this.#menu.query;
		const login = this.#mode === "login";
		const search = this.#shouldRenderSearchStatus() ? pickerQuery(this.#search.input) : pickerQuery(null);
		const sheet = this.#sheet;
		const leave: TspPickerAction = sheet
			? pickerAction(sheet.leave.id, sheet.leave.label, "escape", { end: true })
			: CLOSE_ACTION;
		this.#pickerRoot = dockedPicker({
			...(sheet ? { role: sheet.role } : {}),
			title: sheet?.title ?? (login ? "Sign in" : "Sign out"),
			subtitle: sheet?.subtitle ?? (login ? "Pick a provider" : "Remove stored credentials"),
			icon: "key-round",
			noun: "providers",
			size: sheet?.size ?? "md",
			layout: "cards",
			preview: "none",
			...search,
			placeholder: "Search providers…",
			items: this.#pickerItems,
			...(query.length > 0 ? { order: this.#menu.visibleItems.map(provider => provider.id) } : {}),
			selected: this.#menu.selectedKey ?? null,
			total: all.length,
			empty: login ? "No OAuth providers available" : "No stored provider credentials to log out",
			...(this.#statusMessage ? { message: this.#statusMessage } : {}),
			...(sheet?.status ? { strip: { label: sheet.status, items: [] } } : {}),
			actions: [
				pickerAction(
					"confirm",
					login ? "Sign in" : "Sign out",
					"enter",
					login ? { primary: true } : { primary: true, danger: true },
				),
				{
					...leave,
					label: this.#search.focused
						? "Back to list"
						: sheet
							? sheet.leave.label
							: this.#cancelLabel === "close"
								? "Close"
								: this.#cancelLabel,
				},
			],
		});
		return this.#pickerRoot;
	}

	override describe(cx: DescribeContext): NativeNode {
		if (this.#help.open) return this.#help.describe();
		if (cx.supports("picker")) return this.#describePicker();
		if (this.#nativeRoot) return this.#nativeRoot;
		const items = this.#menu.visibleItems;
		if (!this.#nativeItems || this.#nativeItemsSource !== items) {
			this.#nativeItemsSource = items;
			this.#nativeItems = items.map(provider =>
				node(
					"item",
					{
						label: provider.name,
						tone: provider.available ? undefined : "muted",
						...this.#describeStatus(provider.id),
					},
					undefined,
					provider.id,
				),
			);
		}
		const query = this.#menu.query;
		const children: NativeNode[] = [];
		if (this.#shouldRenderSearchStatus()) {
			children.push(
				node(
					"input",
					{ text: this.#search.value, cursor: this.#search.cursor, placeholder: "Type to search" },
					undefined,
					"search",
				),
			);
		}
		const empty =
			this.#menu.items.length === 0
				? this.#mode === "login"
					? "No OAuth providers available"
					: "No stored provider credentials to log out"
				: "No matching providers";
		children.push(
			node(
				"list",
				{
					selected: this.#menu.selectedKey ?? null,
					filter: query.trim() || undefined,
					empty: [span(empty, "muted")],
					max: { lines: OAUTH_SELECTOR_MAX_VISIBLE },
				},
				this.#nativeItems,
				"list",
			),
		);
		if (this.#statusMessage) children.push(text([span(this.#statusMessage, "warning")]));
		this.#nativeRoot = overlayCard(this.nativeRole, this.title, children);
		return this.#nativeRoot;
	}

	/** A click (or double-click) on a provider selects and confirms it, like the SGR click in {@link routeMouse}. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#help.open) {
			if (event.type === "action") this.#help.handleInput("\x1b");
			this.#requestRenderCallback?.();
			return;
		}
		const ev = pickerEvent(event, PICKER_KEY);
		if (ev?.kind === "action") {
			if (ev.act === "confirm") this.#confirmSelection();
			else if (ev.act === "clear") {
				this.#search.setValue("");
				this.#syncSearchQuery();
			} else if (ev.act === "close" || ev.act === "cancel" || ev.act === this.#sheet?.leave.id) {
				this.handleInput("\x1b");
			}
			return;
		}
		if (ev?.kind === "select") {
			const index = this.#menu.visibleItems.findIndex(provider => provider.id === ev.item);
			if (index < 0 || index === this.#menu.selectedIndex) return;
			this.#menu.setSelectedIndex(index);
			this.#viewport.reveal();
			this.#statusMessage = undefined;
			this.#updateList();
			return;
		}
		if ((event.type !== "select" && event.type !== "activate") || (event.key !== "list" && ev?.kind !== "activate"))
			return;
		const index = this.#menu.visibleItems.findIndex(provider => provider.id === event.item);
		if (index < 0) return;
		if (index !== this.#menu.selectedIndex) {
			this.#menu.setSelectedIndex(index);
			this.#viewport.reveal();
			this.#statusMessage = undefined;
			this.#updateList();
		}
		this.#confirmSelection();
	}

	/** Move the selection one step for a wheel notch (clamped, no wrap). */
	handleWheel(delta: -1 | 1): void {
		if (this.#menu.visibleItems.length === 0) return;
		if (!this.#menu.move(delta, false)) return;
		this.#viewport.reveal();
		this.#statusMessage = undefined;
		this.#updateList();
	}

	/**
	 * Route an SGR mouse report at component-local coordinates. Provider rows
	 * start LIST_ROW_OFFSET lines into the render; the ScrollView window shows
	 * #visibleCount rows from #scrollStart. Wheel moves the selection, motion
	 * drives the hover band, and a left click selects and confirms like Enter.
	 */
	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		if (event.wheel !== null) {
			this.handleWheel(event.wheel);
			return;
		}
		const localRow = line - LIST_ROW_OFFSET;
		const index = localRow >= 0 && localRow < this.#visibleCount ? this.#scrollStart + localRow : undefined;
		const target = index !== undefined && index < this.#menu.visibleItems.length ? index : null;
		if (event.motion) {
			if (target !== this.#hoveredIndex) {
				this.#hoveredIndex = target;
				this.#updateList();
			}
			return;
		}
		if (!event.leftClick || target === null) return;
		if (target !== this.#menu.selectedIndex) {
			this.#menu.setSelectedIndex(target);
			this.#viewport.reveal();
			this.#statusMessage = undefined;
		}
		this.#confirmSelection();
	}
}
