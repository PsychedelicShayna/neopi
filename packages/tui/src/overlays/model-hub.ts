import { uiProvenanceSuffix } from "../theme/provenance";
import { parseModelString, splitUpstreamRouting } from "./model-selector";
/**
 * Fullscreen /models hub, shown on the alternate screen like /settings.
 *
 * Layout: a sidebar of scopes (recently used, role management, all models,
 * one entry per provider — locked providers included, dimmed) beside a
 * {@link ModelBrowser} body. The Roles view manages assignments directly:
 * pick a role, pick a model, adjust thinking in an inline strip, or clear the
 * role back to auto-selection. Locked providers forward to the /login flow.
 * Fully mouse-navigable (hover, wheel, click). `/model` reuses the browser in
 * session-only mode; alt+p keeps its compact picker ({@link ./model-picker}).
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	TspPickerAction,
	TspPickerColumn,
	TspPickerGroup,
	TspPickerItem,
	TspPickerProps,
	TspPickerScope,
	TspSpan,
} from "@oh-my-pi/pi-wire";
import type { KeysApi, Model } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { getSupportedEfforts, getSupportedThinkingLevels } from "@oh-my-pi/pi-catalog/model-thinking";
import { Effort, THINKING_CHOICES, THINKING_EFFORTS, type ThinkingEffort } from "@oh-my-pi/pi-catalog/effort";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { MODEL_KINDS, modelKind, type ModelKind } from "@oh-my-pi/pi-catalog/types";
import type { Component, TUI } from "../tui";
import { extractPrintableText, matchesKey } from "../keys";
import { FuzzyCorpus } from "../fuzzy";
import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { boundKeys, editorKey, editorKeys } from "../chrome/keybinding-hints";
import { col, compact, kbd, md, node, row, span, text } from "../native/describe";
import { CLOSE_ACTION, type PickerEvent, picker, pickerAction, pickerEvent } from "../native/picker";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { hintsRow, type NativeHint } from "../native/overlay";
import { plainText } from "../native/spans";
import { isNativeRendering } from "../native/state";
import { compileMenuRegex } from "../menu-search";
import { Input } from "../components/input";
import {
	applyMenuMotion,
	MenuKeyReader,
	type MenuNavAction,
	MenuSearchField,
	MenuViewport,
	type MenuViewportPosition,
} from "../components/menu-navigation";
import { MenuSelection } from "../components/menu-selection";
import { routeSgrMouseInput, type SgrMouseEvent } from "../mouse";
import { truncateToWidth, visibleWidth } from "../utils";
import type {
	ModelBrowserSource,
	ModelBrowserRegistry,
	ModelRoleLookup,
	ResolvedModelRoleValue,
} from "./model-browser";
import { AUTO_THINKING, type ConfiguredThinkingLevel, getConfiguredThinkingLevelMetadata } from "../thinking";
import { sanitizeDisplayWarning, thinkingLevelGlyph } from "../render/render-utils";
import { theme } from "../theme/theme";
import { matchesSelectCancel } from "../keybinding-matchers";
import {
	buildBrowserItems,
	MODEL_PICKER_COLUMNS,
	ModelBrowser,
	type ModelBrowserItem,
	type ModelBrowserNavigation,
	modelMatchesRegex,
	modelSearchText,
	providerMark,
	thinkingDotToken,
	type RoleAssignments,
	resolveRoleAssignments,
	scopedRolePool,
	sortModelItems,
} from "./model-browser";
import {
	describeHubFrame,
	describeHubSidebar,
	HubFrame,
	type SidebarEntry as HubSidebarEntry,
	type SidebarStyle,
	type StripChip as HubStripChip,
	type StripState as HubStripState,
} from "./hub-frame";
import { renderSegmentTrack } from "../chrome/segment-track";
import { EffortToggle } from "./effort-toggle";
import { ModelOverridesPanel, type ModelOverridesHost } from "./model-overrides";
import { MenuHelp, menuHintLines } from "../components/menu-hints";

export type HubEffortSelection =
	| { mode: "inherit" }
	| { mode: "fixed"; level: ThinkingLevel }
	| { mode: "auto"; allowed?: ThinkingEffort[]; selector?: string };
export interface HubEffortRule {
	selector: string;
	allowed: ThinkingEffort[];
}

export interface HubContextRule {
	selector: string;
	limit: number | string;
}

const EFFORT_RULE_DESCRIPTION =
	"Not Auto-only: implicit efforts in sessions and subagents, including saved fixed defaults. Caller/manual efforts bypass rules; legacy mode ignores them.";
const CONTEXT_RULE_DESCRIPTION =
	"All session model uses, including subagents and explicit efforts. Session/role/agent overrides > N model limits > context rules > global policy. * marks the effective maintenance budget; catalog context stays in the preview.";

/**
 * Selector kinds the hub can author. `re:` opts a selector into a native
 * ECMAScript regular expression; everything else keeps its existing literal or
 * Bun-glob meaning. This mirrors the agent's `config/selector-pattern.ts`,
 * which the TUI cannot import — the coding agent depends on this package, not
 * the other way round.
 */
const REGEX_SELECTOR_PREFIX = "re:";

type SelectorKind = "exact" | "glob" | "regex";

function selectorKind(selector: string): SelectorKind {
	if (selector.startsWith(REGEX_SELECTOR_PREFIX)) return "regex";
	return /[*?[\]{}]/.test(selector) ? "glob" : "exact";
}

/** Keep the hub's exact/pattern distinction aligned with the effort-policy resolver. */
function isPatternSelector(selector: string): boolean {
	return selectorKind(selector) !== "exact";
}

/** Compile a `re:` selector, keeping the engine's own message for inline validation. */
function compileSelectorRegex(selector: string): { regex: RegExp } | { error: string } {
	try {
		return { regex: new RegExp(selector.slice(REGEX_SELECTOR_PREFIX.length)) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Compile once before previewing catalog models; regexes match case-sensitively. */
function compilePatternSelectorMatcher(selector: string): (candidate: string) => boolean {
	if (selectorKind(selector) === "regex") {
		const compiled = compileSelectorRegex(selector);
		return "regex" in compiled ? candidate => compiled.regex.test(candidate) : () => false;
	}
	const glob = new Bun.Glob(selector.toLowerCase());
	return candidate => glob.match(candidate.toLowerCase());
}

/**
 * Trailing tag for the pattern-entry strip: it names the kind the typed
 * selector will be saved as and reports a bad `re:` expression while it is
 * still being typed, so Enter is never the first sign of a broken regex.
 */
function patternStripHint(value: string): string {
	if (!value) return theme.fg("dim", "glob, or re: for regex");
	const kind = selectorKind(value);
	if (kind !== "regex") return theme.fg("dim", kind === "glob" ? "glob" : "literal");
	if (value.length === REGEX_SELECTOR_PREFIX.length) return theme.fg("dim", "regex");
	const compiled = compileSelectorRegex(value);
	return "error" in compiled ? theme.fg("error", `regex · ${compiled.error}`) : theme.fg("dim", "regex");
}

const MODEL_HUB_BODY_MIN_WIDTH = 28;
const MODEL_SCOPE_HINT = "⏎ models · / search · Alt+←/→ kind · ⎋ close";

/**
 * A row of the Roles view: a role, a model/wildcard chain-key header, one of a
 * chain's fallback entries, or the trailing "+ New role…". Fallback rows under
 * a chain-key header carry the key in `role` — `retry.fallbackChains` treats
 * roles, `provider/model-id`, and `provider/*` keys uniformly.
 */
type RolesRow =
	| { kind: "role"; role: string }
	| { kind: "chainKey"; role: string }
	| { kind: "fallback"; role: string; chainIndex: number; selector: string }
	| { kind: "separator" }
	| { kind: "newFallback" }
	| { kind: "newRole" };

/**
 * What the model browser is currently picking for: a role's model, a slot in
 * a fallback chain (`role` may be a role name, model selector, or `provider/*`
 * key), or the primary model a brand-new fallback chain protects.
 */
type AssignTarget =
	| { kind: "role"; role: string }
	| { kind: "fallback"; role: string; index: number | null }
	| { kind: "fallbackKey" }
	| { kind: "effortRule" };

/** Live preferences and selector operations supplied by the host. */
export interface ModelHubSource extends ModelBrowserSource {
	readonly disabledProviders: readonly string[];
	readonly fallbackChains: Record<string, string[]>;
	readonly modelRoleStorage: "global" | "project";
	/** Fixed authoring scope selected by /models; absent retains the embedding host's scope picker. */
	readonly editingScope?: ModelRoleSelectionScope;
	getSessionModelRole?(role: string): string | undefined;
	getRoleScopeNote?(role: string): string;
	readonly cycleOrder: readonly string[];
	getProjectModelRole(role: string): string | undefined;
	getGlobalModelRole(role: string): string | undefined;
	getModelRoleSource(role: string): "global" | "project" | "default";
	readonly effortRules: readonly HubEffortRule[];
	readonly contextRules?: readonly HubContextRule[];
	/** The policy resolver supplies actual supported levels intersected with the winning global rule. */
	permittedEfforts(model: Model): readonly ThinkingEffort[];
	getProjectRoleEffortSelection(role: string): HubEffortSelection | undefined;
	getGlobalRoleEffortSelection(role: string): HubEffortSelection | undefined;
	getRoleEffortSelection(role: string): HubEffortSelection | undefined;
	/** Explicit role context budget; undefined inherits the ordinary context limit. */
	getRoleTokenBudget?(role: string): number | undefined;
	getFallbackEffortSelection(role: string, selector: string): HubEffortSelection | undefined;
	/** Serialize a resolved role model, retaining any host-specific upstream route. */
	formatModelSelector(model: Model): string;
	/**
	 * Saved model presets (in switch order) and the one the current role setup
	 * matches, if any. Absent hosts have no presets to switch between.
	 */
	getModelPresets?(): { names: readonly string[]; active: string | undefined };
}

/** Catalog capabilities required by the model hub. */
export interface ModelHubRegistry extends ModelBrowserRegistry {
	readonly authStorage: { readonly keys: Pick<KeysApi, "source"> };
	readonly modelConfig?: Pick<ModelOverridesHost, "list" | "schema" | "save" | "remove">;
	getDiscoverableProviders(): string[];
	getProviderDiscoveryState(provider: string):
		| {
				optional: boolean;
				status: "idle" | "ok" | "empty" | "cached" | "unavailable" | "unauthenticated";
				fetchedAt?: number;
				error?: string;
		  }
		| undefined;
	find(provider: string, id: string): Model | undefined;
	refresh(strategy: "online" | "offline"): Promise<void>;
	refreshProvider(
		provider: string,
		strategy: "online",
		options?: { refreshCommandCredentials?: boolean },
	): Promise<void>;
}

/** A `--models` scope entry (mirrors the session's scoped model list). */
export interface ScopedModelItem {
	model: Model;
	thinkingLevel?: string;
}

export type ModelRoleSelectionScope = "global" | "project" | "session";

export interface ModelHubCallbacks {
	/** Select a model without authoring a role or changing saved preferences. */
	onPick?: (model: Model, selector: string) => void | boolean | Promise<void | boolean>;
	/** Open fact sources and per-field overrides in the full model configuration UI. */
	onEditFacts?: (provider?: string, model?: Model) => void;
	/** Persist a role assignment. */
	onAssign: (
		model: Model,
		role: string,
		thinkingLevel: ConfiguredThinkingLevel | undefined,
		selector: string,
		scope?: ModelRoleSelectionScope,
		selection?: HubEffortSelection,
	) => void | boolean | Promise<void | boolean>;
	/** Return false to retain the draft if persistence fails. */
	onEffortRulesChange?: (rules: HubEffortRule[]) => boolean | void;
	/** Validate and normalize typed limits before persisting; false keeps the draft open. */
	onContextRulesChange?: (rules: HubContextRule[]) => boolean | void;
	/** Clear a configured role back to auto-selection. */
	onUnassign: (role: string, scope?: ModelRoleSelectionScope) => void;
	/** Persist the selected role's description. Return false to retain its draft. */
	onRoleDescriptionChange?: (role: string, description: string) => boolean | void;
	/** Edit the existing roleSettings.<role>["compaction.thresholdTokens"] value. */
	onRoleTokenBudgetChange?: (role: string, value: number | undefined) => boolean | void;
	/** Persist a chain and its per-entry effort selections as one mutation. */
	onFallbackChainChange?: (
		role: string,
		chain: string[],
		effort?: { selector: string; selection: HubEffortSelection },
		copiedSelections?: Readonly<Record<string, HubEffortSelection>>,
	) => boolean | void;
	/** Rename a chain and its per-entry effort selections atomically. False retains the draft. */
	onFallbackChainKeyChange?: (previousKey: string, key: string) => boolean | void;
	/** Locked provider activation: forward to the /login flow. */
	onLoginRequest?: (providerId: string) => void;
	/** Open the mixture graph editor from a selected mixture model. */
	onDefineMixture?: (name?: string) => void;
	/** Save the current role assignments and default thinking level as a named model preset. */
	onSavePreset?: (name: string) => void;
	/**
	 * Apply a saved model preset (ctrl+←/→ or p/⇧P in the Roles view) and report
	 * the outcome itself. A switch that writes nothing (a refused preset) still
	 * advances the hub's preset cursor, so the next press moves past it.
	 */
	onSwitchPreset?: (name: string) => void | Promise<void>;
	/** Persist a new quick-switch cycle order (the ctrl+p role cycle). */
	onCycleOrderChange?: (order: string[]) => void;
	/**
	 * Persist typed text as `model`'s own compaction limit: a token base the
	 * policy scales (`400k`), a fixed trigger (`f400k`), a percentage (`80%`), or
	 * empty to reset. Rejected input returns `{ kind: "error" }`; input that
	 * needs acknowledgement (one that opens the extended window) returns
	 * `{ kind: "confirm" }` until called again with the same text and
	 * `confirmed`. Either keeps the field open.
	 */
	onCompactionPointChange?: (
		model: Model,
		input: string,
		confirmed: boolean,
	) => CompactionPointChangeResult | undefined;
	/**
	 * One short line on where `model` would compact with the typed limit
	 * (`compacts at 340K · 85% of 400K base`), shown beside the field while
	 * typing; undefined for input that does not parse or fit.
	 */
	previewCompactionPoint?: (model: Model, input: string) => string | undefined;
	onCancel: () => void;
	/** Edit the file backing the active config view and reload it before resolving. */
	onOpenConfigFile?: (
		section: "roles" | "effort" | "context" | "overrides",
		scope?: ModelRoleSelectionScope,
	) => Promise<void>;
}

/** Why {@link ModelHubCallbacks.onCompactionPointChange} kept the field open. */
export type CompactionPointChangeResult = { kind: "error"; message: string } | { kind: "confirm"; message: string };

export interface ModelHubOptions {
	/** Browse recent models and providers without any role or policy editing. */
	sessionOnly?: boolean;
	/** Preselect this provider's sidebar entry (e.g. when reopening after /login). */
	initialProviderId?: string;
	/** `provider/id` of the session's model, marked current in the native picker. */
	currentSelector?: string;
	/** Provider entries available even before their first model exists. */
	pinnedProviders?: ReadonlyArray<{ id: string; label: string; action: { label: string; onSelect: () => void } }>;
}

interface SidebarEntry extends HubSidebarEntry<
	"recent" | "roles" | "effort" | "overrides" | "all" | "separator" | "provider"
> {
	providerId?: string;
	locked?: boolean;
	oauth?: boolean;
	catalogCount?: number;
}

/**
 * The focused sidebar entry plus its screen row, captured before a rebuild so
 * the viewport can be restored around it. `index` is the entry's position in
 * `#entries` (−1 when absent); `offset` is its row relative to the scroll top.
 */
interface SidebarAnchor {
	id: string;
	index: number;
	offset: number;
}

interface StripChip extends HubStripChip<
	"assign" | "unassign" | "fallback" | "fallbackModel" | "fallbackProvider" | "scope" | "thinking"
> {
	role?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	scope?: ModelRoleSelectionScope;
}

type StripState =
	| (HubStripState<StripChip> & {
			kind: "role" | "scope" | "thinking";
			item: ModelBrowserItem;
			role?: string;
			/** Set when a thinking strip edits a fallback-chain entry instead of a role assignment. */
			fallbackIndex?: number;
			scope?: ModelRoleSelectionScope;
			/** Where to land when a scope or thinking strip closes. */
			returnToRoles: boolean;
			/** Thinking value already committed for this strip. */
			initialThinkingLevel?: ConfiguredThinkingLevel;
			initialSelection?: HubEffortSelection;
			/** Pending fallback entry: no chain mutation until an effort is confirmed. */
			fallbackTarget?: { role: string; index: number | null };
			fallbackSelector?: string;
	  })
	| {
			/** Footer text input naming a new role, or saving a model preset. */
			kind: "name";
			purpose: "role" | "preset";
			input: Input;
	  }
	| {
			kind: "name";
			purpose: "contextRule";
			selector: string;
			input: Input;
	  }
	| {
			kind: "name";
			purpose: "description" | "roleBudget";
			role: string;
			input: Input;
	  }
	| {
			kind: "effortLevels";
			item?: ModelBrowserItem;
			selector?: string;
			role?: string;
			scope?: ModelRoleSelectionScope;
			fallbackTarget?: { role: string; index: number | null };
			ruleIndex?: number;
			pendingRuleSelector?: string;
			baseSelection?: HubEffortSelection;
			toggle: EffortToggle;
			index: number;
	  }
	| {
			kind: "pattern";
			input: Input;
			target: "rule" | "fallback" | "role" | "fallbackKey";
			role?: string;
			fallbackTarget?: { role: string; index: number | null };
	  }
	| {
			kind: "patternEffort";
			selector: string;
			target: { role: string; index: number | null };
			chips: StripChip[];
			index: number;
			initialSelection?: HubEffortSelection;
	  }
	| {
			kind: "selectorChoice";
			target:
				| { kind: "role"; role: string }
				| { kind: "fallback"; role: string; index: number | null }
				| { kind: "fallbackKey" };
			chips: StripChip[];
			index: number;
	  }
	| {
			/**
			 * Footer text input setting `model`'s compaction limit; `error` is the last
			 * rejection, `confirm` the warning a second Enter on the same `value`
			 * accepts, `preview` the host's live line for the typed `value`.
			 */
			kind: "name";
			purpose: "compaction";
			model: Model;
			input: Input;
			error?: string;
			confirm?: { value: string; message: string };
			preview?: { value: string; text: string | undefined };
	  };

interface ModelHubPageNavigation {
	entry: string;
	focus: "scope" | "list";
	modelKind: "all" | ModelKind;
	roleTab: RoleTab;
	filterFocused: boolean;
	rolesQuery: string;
	rolesValue: string;
	rolesCursor: number;
	effortQuery: string;
	effortValue: string;
	effortCursor: number;
	roleKey: string | undefined;
	roleTop: MenuViewportPosition | undefined;
	effortIndex: number;
	effortKey: string | undefined;
	effortTop: MenuViewportPosition | undefined;
	sidebarTop: number;
	browser: ModelBrowserNavigation;
	assigning: AssignTarget | null;
	strip: StripState | null;
	yankedFallback: readonly { selector: string; selection?: HubEffortSelection }[] | null;
	pinnedActionFocused: boolean;
	configError: string | undefined;
	presetCursor: { name: string; revision: number } | undefined;
}

interface ModelHubNavigation extends ModelHubPageNavigation {
	parents: ModelHubPageNavigation[];
}

/** A Roles-view command; keys and the picker's action bar both run {@link ModelHubComponent}'s `#runRolesAction`. */
type RolesAction =
	| "pick"
	| "clear"
	| "fallback"
	| "cycle"
	| "earlier"
	| "later"
	| "new"
	| "thinking"
	| "compaction"
	| "description"
	| "budget"
	| "save"
	| "nextPreset"
	| "prevPreset";

/** Printable keys of the Roles view and the command each runs. */
const ROLES_ACTION_KEYS: Record<string, RolesAction> = {
	x: "clear",
	f: "fallback",
	c: "cycle",
	D: "description",
	b: "budget",
	"[": "earlier",
	"]": "later",
	n: "new",
	t: "thinking",
	// `k` is vim navigation and `p`/`P` paste fallbacks in this fork, so the
	// compaction limit lives on `m` and preset switching only on ctrl+←/→.
	m: "compaction",
	s: "save",
};

/** Picker fact columns of the Roles view. */
const ROLE_PICKER_COLUMNS: readonly TspPickerColumn[] = [
	{ id: "model", head: "Model", format: "text", priority: 2 },
	{ id: "thinking", head: "Thinking", format: "dim", priority: 1 },
	{ id: "compaction", head: "Compaction", format: "dim", priority: 1 },
	{ id: "budget", head: "Role budget", format: "dim", priority: 1 },
];

/** Kind tab labels (sentence case; acronyms stay upper). */
const MODEL_KIND_LABELS: Record<"all" | ModelKind, string> = {
	all: "All",
	chat: "Chat",
	tiny: "Tiny",
	image: "Image",
	tts: "TTS",
	stt: "STT",
	search: "Search",
	judge: "Judge",
	embedding: "Embedding",
	rerank: "Rerank",
	video: "Video",
};

const PROVIDER_REFRESH_DEBOUNCE_MS = 120;
const RECENT_LIMIT = 15;
/** Accepted compaction limit input, shown beside the field: a scaled base, a fixed trigger, or a percentage. */
const COMPACTION_INPUT_HINT = "400k base · f400k fixed · 80% · empty resets";

type CompactionStrip = Extract<StripState, { purpose: "compaction" }>;

/** Whether the compaction field still holds the text its pending warning was raised for. */
function compactionConfirmPending(strip: CompactionStrip): boolean {
	return strip.confirm !== undefined && strip.confirm.value === strip.input.getValue();
}

/**
 * The note beside the compaction field: the last error, a pending warning, the
 * host's live preview of the typed limit, or (empty or unparsed input) the
 * input syntax. Host text embeds model ids and config text, so it is
 * sanitized for every render path (terminal footer, Tern picker and strip).
 */
function compactionNotice(
	strip: CompactionStrip,
	preview: ((model: Model, input: string) => string | undefined) | undefined,
): { text: string; style: "error" | "warning" | "dim" } {
	if (strip.error) return { text: sanitizeDisplayWarning(strip.error), style: "error" };
	// The footer hint and the primary action already say Enter accepts; the
	// notice stays short so it fits beside the field.
	if (strip.confirm && compactionConfirmPending(strip)) {
		return { text: sanitizeDisplayWarning(strip.confirm.message), style: "warning" };
	}
	const value = strip.input.getValue();
	if (preview && value.trim().length > 0) {
		// Renders repeat per frame; ask the host once per typed value.
		if (strip.preview?.value !== value) strip.preview = { value, text: preview(strip.model, value) };
		if (strip.preview.text) return { text: sanitizeDisplayWarning(strip.preview.text), style: "dim" };
	}
	return { text: COMPACTION_INPUT_HINT, style: "dim" };
}

const MODEL_KIND_TABS: ReadonlyArray<"all" | ModelKind> = ["all", ...MODEL_KINDS];
const ROLE_TABS = ["all", "chat", "kind"] as const;
type RoleTab = (typeof ROLE_TABS)[number];

/** Stable native list-item key of a Roles-view row. */
function rolesRowKey(row: RolesRow, index: number): string {
	switch (row.kind) {
		case "role":
			return `role:${row.role}`;
		case "chainKey":
			return `chain:${row.role}`;
		case "fallback":
			return `fallback:${row.role}:${row.chainIndex}`;
		case "separator":
			return `sep:${index}`;
		case "newRole":
		case "newFallback":
			return row.kind;
	}
}

/**
 * Providers already auto-refreshed this process. Selecting a provider fetches
 * its live model list at most once per application lifetime (surviving hub
 * close/reopen); F5 re-fetches on demand.
 */
const autoRefreshedProviders = new Set<string>();

/** Test hook: forget which providers were auto-refreshed this process. */
export function resetProviderAutoRefreshGuard(): void {
	autoRefreshedProviders.clear();
}

/**
 * The fullscreen model hub component. Hosted via `ui.showOverlay(..., { fullscreen: true })`;
 * the host must call {@link ModelHubComponent.dispose} when the overlay closes.
 */
export class ModelHubComponent implements Component {
	#tui: TUI;
	#settings: ModelHubSource;
	#registry: ModelHubRegistry;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#callbacks: ModelHubCallbacks;
	readonly #sessionOnly: boolean;

	#browser: ModelBrowser;
	#roles: RoleAssignments = {};
	#availableItems: ModelBrowserItem[] = [];
	#recentItems: ModelBrowserItem[] = [];
	/** Selectors of {@link #recentItems}, rebuilt with it, for search hit counts. */
	#recentSelectors: ReadonlySet<string> = new Set();
	#candidateItems: ModelBrowserItem[] = [];
	/** {@link #availableItems} when the candidates are that whole catalog (All scope, no role filter). */
	#candidateCatalog: readonly ModelBrowserItem[] | undefined;
	/** {@link #availableItems} when the browser's base items are that whole catalog; its query ranking then covers every count. */
	#browserCatalog: readonly ModelBrowserItem[] | undefined;
	/** Fuzzy index over {@link #availableItems}, for match counts while the browser holds a narrower scope. */
	#catalogCorpus: { items: readonly ModelBrowserItem[]; corpus: FuzzyCorpus<ModelBrowserItem> } | undefined;
	#modelKindTab: "all" | ModelKind = "all";
	#roleTab: RoleTab = "all";
	#configError: string | undefined;
	#effortIndex = 0;
	#keys = new MenuKeyReader();
	readonly #help = new MenuHelp();
	#rolesSearch = new MenuSearchField();
	#effortSearch = new MenuSearchField();
	#roleViewport = new MenuViewport();
	#effortViewport = new MenuViewport();
	#roleLastIndex = 0;
	#effortLastIndex = 0;
	onNavigationVisit?: (page: string, previousSnapshot: unknown) => void;
	#scopeViewport = new MenuViewport();
	#scopeSelection = new MenuSelection<SidebarEntry>([], {
		getKey: entry => entry.id,
		getSearchText: entry => entry.label,
		isDisabled: entry => this.#isHopSkipped(entry),
	});
	#roleSelection = new MenuSelection<RolesRow>([], {
		getKey: entry => rolesRowKey(entry, 0),
		getSearchText: () => "",
		isDisabled: entry => entry.kind === "separator",
	});
	#effortSelection = new MenuSelection<number>([], {
		getKey: String,
		getSearchText: index => this.#effortRowText(index),
	});
	#effortRows: number[] = [];
	#sidebarVisibleCount = 0;
	#effortVisibleCount = 0;
	#effortScrollStart = 0;
	#parentPages: ModelHubPageNavigation[] = [];
	#parentRestored = false;

	#entries: SidebarEntry[] = [];
	// Sidebar sections from the last registry sync; #composeEntries assembles
	// #entries from these (reordered while searching).
	#fixedEntries: SidebarEntry[] = [];
	#unlockedProviderEntries: SidebarEntry[] = [];
	#lockedProviderEntries: SidebarEntry[] = [];
	/** Fuzzy match totals while searching: recent-scope hits and overall hits. */
	#recentSearchCount = 0;
	#searchTotal = 0;
	#activeEntryId = "all";
	#externalEditPending = false;
	/** Snap the sidebar viewport to the active entry on the next render; wheel panning leaves it free. */
	#sidebarFollowActive = true;
	#sidebarHover: number | null = null;
	/**
	 * Arrow-key ownership: `scope` (default) hops the sidebar; `list`
	 * navigates rows (browser models or role rows). Typing anywhere focuses
	 * the model list; Tab toggles; ←/→ switches between sidebar and list.
	 */
	#focus: "scope" | "list" = "scope";
	get #filterEditing(): boolean {
		if (this.#assigning === null) {
			if (this.#activeEntry().kind === "roles") return this.#rolesSearch.focused;
			if (this.#activeEntry().kind === "effort") return this.#effortSearch.focused;
		}
		return this.#browser.filterFocused;
	}

	set #filterEditing(focused: boolean) {
		const kind = this.#assigning === null ? this.#activeEntry().kind : undefined;
		this.#rolesSearch.focused = focused && kind === "roles";
		this.#effortSearch.focused = focused && kind === "effort";
		this.#browser.focusFilter(focused && kind !== "roles" && kind !== "effort");
	}

	#rolesRows: RolesRow[] = [];
	#roleIndex = 0;
	/** In-hub yank register: selectors and sparse effort selections are immutable snapshots. */
	#yankedFallback: readonly { selector: string; selection?: HubEffortSelection }[] | null = null;
	#roleHover: number | null = null;
	/** First Roles row painted by the independent viewport; mouse hit-testing uses this offset. */
	#roleScrollStart = 0;
	/** Roles rows actually drawn this frame; bounds mouse hit-testing to the visible window. */
	#rolesVisibleCount = 0;

	#assigning: AssignTarget | null = null;
	#overridesPanel?: ModelOverridesPanel;

	#overrides(): ModelOverridesPanel {
		return (this.#overridesPanel ??= new ModelOverridesPanel({
			list: () => {
				if (!this.#registry.modelConfig) throw new Error("Model config editing is unavailable.");
				return this.#registry.modelConfig.list();
			},
			schema: kind => this.#registry.modelConfig?.schema(kind) ?? {},
			save: async (entry, original) => {
				if (!this.#registry.modelConfig) throw new Error("Model config editing is unavailable.");
				await this.#registry.modelConfig.save(entry, original);
				await this.#registry.refresh("offline");
			},
			remove: async entry => {
				if (!this.#registry.modelConfig) throw new Error("Model config editing is unavailable.");
				await this.#registry.modelConfig.remove(entry);
				await this.#registry.refresh("offline");
			},
			changed: () => {
				this.#syncFromRegistryState();
				this.#requestRender();
			},
			back: () => {
				this.#focus = "scope";
			},
		}));
	}
	#strip: StripState | null = null;
	#assignmentPending = false;
	/**
	 * Last preset ctrl+←/→ tried in this hub, with the settings revision after the
	 * attempt; steps from it while nothing matches the setup or nothing changed since.
	 */
	#presetCursor: { name: string; revision: number } | undefined;
	#presetsMemo: { revision: number; names: readonly string[]; active: string | undefined } | undefined;
	#disposed = false;
	/** Per-provider fuzzy match counts while a query is active; null when not searching. */
	#searchCounts: Map<string, number> | null = null;

	// Provider discovery refresh (debounced per sidebar selection, with spinner).
	#refreshingProviders = new Set<string>();
	#scheduledProviderRefreshes = new Map<string, Timer>();
	/** F5 while a catalog-only refresh is in flight: re-run with credentials after it settles. */
	#pendingCredentialRefreshProviders = new Set<string>();
	#refreshSpinnerFrame = 0;
	#refreshSpinnerInterval?: Timer;
	#renderBodyPane = (width: number, height: number | undefined): readonly string[] => {
		const rows = Math.max(1, Math.floor(height ?? 10));
		const lines: string[] = [this.#statusRow(width)];
		const entry = this.#activeEntry();
		const pinned =
			entry.kind === "provider" && this.#assigning === null
				? this.#pinnedProviders.find(provider => provider.id === entry.providerId)
				: undefined;
		this.#pinnedActionLine = null;
		if (entry.kind === "overrides" && this.#assigning === null) {
			lines.push(...this.#overrides().render(width, rows - 1));
			return lines.slice(0, rows);
		}
		if (entry.kind === "effort" && this.#assigning === null) {
			lines.push(...this.#renderEffortRules(width, rows - 1));
		} else if (entry.kind === "roles" && this.#assigning === null) {
			lines.push(...this.#renderRolesView(width, rows - 1));
		} else if (entry.kind === "provider" && entry.locked && this.#assigning === null) {
			lines.push(...this.#renderLockedView(entry, width, rows - 1));
		} else {
			lines.push(this.#renderModelKindTabs(width));
			const visible = Math.max(1, rows - 7 - (pinned ? 1 : 0));
			this.#browser.setMaxVisible(visible);
			this.#browser.setFocused(this.#focus === "list" && !this.#pinnedActionFocused);
			const browserLines = this.#browser.render(width);
			if (pinned) {
				this.#pinnedActionLine = lines.length + 2 + visible;
				const selected = this.#focus === "list" && this.#pinnedActionFocused;
				const label = `  ${selected ? theme.nav.cursor : " "} ${pinned.action.label}`;
				browserLines.splice(2 + visible, 0, truncateToWidth(theme.fg(selected ? "accent" : "muted", label), width));
			}
			lines.push(...browserLines);
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	};
	readonly #frame: HubFrame = new HubFrame(
		"Models",
		{ min: 18, max: 26 },
		(width, rows) => this.#renderSidebar(width, rows),
		this.#renderBodyPane,
		{ bodyMinWidth: MODEL_HUB_BODY_MIN_WIDTH, preserveSidebar: true },
	);
	#pinnedActionLine: number | null = null;
	#pinnedActionFocused = false;
	readonly #pinnedProviders: NonNullable<ModelHubOptions["pinnedProviders"]>;
	#lockedLoginLine: number | null = null;
	#rolesRowStart = 1;
	/** Bumped on every visible-state change; the described node is rebuilt when it moves. */
	#nativeVersion = 0;
	#nativeCache: { version: number; picker: boolean; node: NativeNode } | undefined;
	#currentSelector: string | undefined;
	/** The opening online catalog refresh is still in flight (an empty scope then shows as loading). */
	#catalogRefreshing = false;
	#kindTabsMemo: { candidates: readonly ModelBrowserItem[]; tabs: TspPickerProps["tabs"] } | undefined;
	#pickerRoleItems:
		| {
				rows: readonly RolesRow[];
				roles: RoleAssignments;
				cycle: string;
				revision: number;
				items: readonly TspPickerItem[];
		  }
		| undefined;
	#pickerRolePreview:
		| {
				row: RolesRow | undefined;
				roles: RoleAssignments;
				rows: readonly RolesRow[];
				revision: number;
				children: readonly NativeChild[];
		  }
		| undefined;

	constructor(
		tui: TUI,
		settings: ModelHubSource,
		registry: ModelHubRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		callbacks: ModelHubCallbacks,
		options: ModelHubOptions = {},
	) {
		this.#tui = tui;
		this.#settings = settings;
		this.#registry = registry;
		this.#scopedModels = scopedModels;
		this.#callbacks = callbacks;
		this.#sessionOnly = options.sessionOnly === true;
		this.#currentSelector = options.currentSelector;
		this.#pinnedProviders = options.pinnedProviders ?? [];

		this.#browser = new ModelBrowser(settings, {
			emptyText: () => this.#emptyStateMessage(),
		});
		this.#browser.onActivate = item => {
			this.#filterEditing = false;
			this.#activateItem(item);
		};
		this.#browser.onCancel = () => this.#cancel();
		this.#browser.onQueryChange = query => this.#onQueryChanged(query);

		// Hydrate synchronously from the current registry snapshot so the first
		// Enter after opening acts on cached models instead of being dropped
		// while the offline refresh promise is still pending.
		this.#syncFromRegistryState();

		const initialProvider = options.initialProviderId;
		if (initialProvider && this.#entries.some(entry => entry.providerId === initialProvider)) {
			this.#setActiveEntry(`provider:${initialProvider}`);
		} else {
			this.#setActiveEntry(this.#sessionOnly ? "recent" : "all");
		}

		// Reconcile catalogs in the background. This is online discovery only —
		// it must not re-run `!command` credential helpers (F5 / `npi models
		// refresh` passes refreshCommandCredentials for that). A --models scope is
		// registry-independent, so the reload would only repeat the hydration
		// above.
		if (this.#scopedModels.length === 0) {
			this.#catalogRefreshing = true;
			this.#registry
				.refresh("online")
				.then(() => this.#syncFromRegistryState())
				.catch(error => {
					this.#configError = error instanceof Error ? error.message : String(error);
				})
				.finally(() => {
					this.#catalogRefreshing = false;
					this.#requestRender();
				});
		}
	}

	#copyStrip(strip: StripState | null): StripState | null {
		if (!strip) return null;
		if (strip.kind === "name" || strip.kind === "pattern") {
			const input = new Input();
			input.setValue(strip.input.getValue());
			input.setCursor(strip.input.getCursor());
			input.focused = strip.input.focused;
			return { ...strip, input };
		}
		if (strip.kind === "effortLevels")
			return {
				...strip,
				baseSelection: structuredClone(strip.baseSelection),
				fallbackTarget: strip.fallbackTarget ? { ...strip.fallbackTarget } : undefined,
				toggle: new EffortToggle([...strip.toggle.options], [...strip.toggle.selected]),
			};
		const snapshot = { ...strip, chips: strip.chips.map(chip => ({ ...chip })) };
		if ("initialSelection" in snapshot) snapshot.initialSelection = structuredClone(snapshot.initialSelection);
		if ("fallbackTarget" in snapshot && snapshot.fallbackTarget)
			snapshot.fallbackTarget = { ...snapshot.fallbackTarget };
		if ("target" in snapshot) snapshot.target = { ...snapshot.target };
		return snapshot;
	}

	#copyNavigationPage(state: ModelHubPageNavigation): ModelHubPageNavigation {
		return {
			...state,
			browser: { ...state.browser, top: state.browser.top ? { ...state.browser.top } : undefined },
			roleTop: state.roleTop ? { ...state.roleTop } : undefined,
			effortTop: state.effortTop ? { ...state.effortTop } : undefined,
			assigning: state.assigning ? { ...state.assigning } : null,
			strip: this.#copyStrip(state.strip),
			yankedFallback: structuredClone(state.yankedFallback),
			presetCursor: state.presetCursor ? { ...state.presetCursor } : undefined,
		};
	}

	get blocksMenuHistory(): boolean {
		return this.#externalEditPending;
	}

	navigationSnapshot(): ModelHubNavigation {
		const row = this.#rolesRows[this.#roleIndex];
		return {
			entry: this.#activeEntryId,
			focus: this.#focus,
			modelKind: this.#modelKindTab,
			roleTab: this.#roleTab,
			filterFocused: this.#filterEditing,
			rolesQuery: this.#rolesSearch.query,
			rolesValue: this.#rolesSearch.value,
			rolesCursor: this.#rolesSearch.cursor,
			effortQuery: this.#effortSearch.query,
			effortValue: this.#effortSearch.value,
			effortCursor: this.#effortSearch.cursor,
			roleKey: row ? rolesRowKey(row, this.#roleIndex) : undefined,
			roleTop: this.#roleViewport.top ? { ...this.#roleViewport.top } : undefined,
			effortIndex: this.#effortIndex,
			effortKey: this.#effortIndex < 0 ? undefined : this.#effortRowKey(this.#effortIndex),
			effortTop: this.#effortViewport.top ? { ...this.#effortViewport.top } : undefined,
			sidebarTop: this.#frame.sidebarScroll,
			browser: this.#browser.navigationSnapshot(),
			assigning: this.#assigning ? { ...this.#assigning } : null,
			strip: this.#copyStrip(this.#strip),
			yankedFallback: structuredClone(this.#yankedFallback),
			pinnedActionFocused: this.#pinnedActionFocused,
			configError: this.#configError,
			presetCursor: this.#presetCursor ? { ...this.#presetCursor } : undefined,
			parents: this.#parentPages.map(state => this.#copyNavigationPage(state)),
		};
	}

	restoreNavigation(snapshot: unknown): void {
		if (!snapshot || typeof snapshot !== "object") return;
		const state = snapshot as Partial<ModelHubNavigation>;
		if (typeof state.entry !== "string" || !state.browser) return;
		this.#modelKindTab = MODEL_KIND_TABS.includes(state.modelKind ?? "all") ? (state.modelKind ?? "all") : "all";
		this.#roleTab = state.roleTab && ROLE_TABS.includes(state.roleTab) ? state.roleTab : "all";
		this.#assigning = state.assigning ? { ...state.assigning } : null;
		this.#rolesSearch.restoreNavigation({
			value: state.rolesValue ?? state.rolesQuery ?? "",
			query: state.rolesQuery ?? "",
			cursor: state.rolesCursor,
			focused: state.filterFocused === true && state.entry === "roles" && !state.assigning,
		});
		this.#effortSearch.restoreNavigation({
			value: state.effortValue ?? state.effortQuery ?? "",
			query: state.effortQuery ?? "",
			cursor: state.effortCursor,
			focused: state.filterFocused === true && state.entry === "effort" && !state.assigning,
		});
		this.#buildRolesRows();
		this.#setActiveEntry(state.entry);
		this.#browser.restoreNavigation(state.browser);
		this.#roleIndex = Math.max(
			0,
			this.#rolesRows.findIndex((row, index) => rolesRowKey(row, index) === state.roleKey),
		);
		this.#roleLastIndex = this.#roleIndex;
		this.#roleViewport.setTop(state.roleTop);
		const rules = this.#rules();
		const effortIndex =
			state.effortKey === "newExact"
				? rules.length
				: state.effortKey === "newPattern"
					? rules.length + 1
					: state.effortKey?.startsWith("rule:")
						? rules.findIndex(rule => `rule:${rule.selector}` === state.effortKey)
						: -1;
		this.#effortIndex =
			effortIndex >= 0 ? effortIndex : Math.max(-1, Math.min(state.effortIndex ?? 0, rules.length + 1));
		this.#syncEffortSelection();
		this.#effortLastIndex = this.#effortIndex;
		this.#effortViewport.setTop(state.effortTop);
		this.#frame.sidebarScroll = Math.max(0, state.sidebarTop ?? 0);
		this.#sidebarFollowActive = false;
		this.#focus = state.focus === "list" ? "list" : "scope";
		this.#filterEditing = state.filterFocused === true;
		this.#strip = this.#copyStrip(state.strip ?? null);
		this.#yankedFallback = structuredClone(state.yankedFallback ?? null);
		this.#pinnedActionFocused = state.pinnedActionFocused === true;
		this.#configError = state.configError;
		this.#presetCursor = state.presetCursor ? { ...state.presetCursor } : undefined;
		this.#parentPages = Array.isArray(state.parents)
			? state.parents.map(parent => this.#copyNavigationPage(parent))
			: [];
		this.#keys.reset();
		this.#requestRender();
	}

	#navigationPage(): string {
		const strip = this.#strip;
		if (strip) {
			const target = "fallbackTarget" in strip ? strip.fallbackTarget : "target" in strip ? strip.target : undefined;
			const owner =
				typeof target === "object" && target && "role" in target
					? target.role
					: "role" in strip
						? (strip.role ?? "")
						: "";
			const slot =
				typeof target === "object" && target && "index" in target
					? (target.index ?? "new")
					: "ruleIndex" in strip
						? (strip.ruleIndex ?? "")
						: "";
			const purpose = "purpose" in strip ? strip.purpose : "";
			return `${this.#activeEntryId}/${strip.kind}/${owner}/${slot}/${purpose}`;
		}
		const assigning = this.#assigning;
		if (assigning)
			return `assign/${assigning.kind}/${"role" in assigning ? assigning.role : ""}/${"index" in assigning ? (assigning.index ?? "new") : ""}`;
		return "";
	}

	#withNavigationVisit(action: () => void): void {
		const page = this.#navigationPage();
		const previous = this.navigationSnapshot();
		this.#parentRestored = false;
		action();
		const next = this.#navigationPage();
		if (next !== page) {
			if (!this.#parentRestored) {
				if (next === "") this.#parentPages = [];
				else {
					const { parents: _parents, ...parent } = previous;
					this.#parentPages.push(parent);
				}
			}
			this.onNavigationVisit?.(next, previous);
		}
		this.#parentRestored = false;
	}

	#returnToParent(): boolean {
		const parent = this.#parentPages.pop();
		if (!parent) return false;
		this.restoreNavigation({ ...parent, parents: this.#parentPages });
		this.#parentRestored = true;
		return true;
	}

	/** Cancel pending provider refresh timers and the spinner. Host calls this on overlay close. */
	dispose(): void {
		this.#disposed = true;
		for (const [, timer] of this.#scheduledProviderRefreshes) clearTimeout(timer);
		this.#scheduledProviderRefreshes.clear();
		this.#refreshingProviders.clear();
		this.#pendingCredentialRefreshProviders.clear();
		if (this.#refreshSpinnerInterval) {
			clearInterval(this.#refreshSpinnerInterval);
			this.#refreshSpinnerInterval = undefined;
		}
	}

	invalidate(): void {
		this.#nativeVersion++;
		this.#frame.invalidate();
	}

	/** Request a repaint after a state change, invalidating the described node. */
	#requestRender(): void {
		this.#nativeVersion++;
		this.#tui.requestRender();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Data pipeline
	// ═══════════════════════════════════════════════════════════════════════

	#visibleRoleIds(): string[] {
		return [...this.#settings.knownRoleIds];
	}

	/** Resolve every known role: configured values first, auto-selection for the rest. */
	#reloadRoles(autoCandidates: ReadonlyArray<Model>): void {
		const allModels = this.#scopedModels.length > 0 ? autoCandidates : this.#registry.getAll("all");
		this.#roles = resolveRoleAssignments(this.#settings, allModels, autoCandidates);
	}

	/** Rebuild items, roles, and the sidebar from the registry's in-memory state. */
	#syncFromRegistryState(): void {
		this.#nativeVersion++;
		this.#overridesPanel?.reload();
		// A background rebuild (provider refresh, mutation) must not yank the
		// sidebar viewport: remember the focused entry's screen row so it — or
		// its nearest survivor — stays put after #buildSidebar reshuffles entries.
		const anchor = this.#captureSidebarAnchor();
		let allModels: ReadonlyArray<Model>;
		let availableModels: ReadonlyArray<Model>;
		if (this.#scopedModels.length > 0) {
			this.#configError = undefined;
			try {
				allModels = scopedRolePool(
					this.#scopedModels.map(scoped => scoped.model),
					this.#registry,
				);
			} catch (error) {
				this.#configError = error instanceof Error ? error.message : String(error);
				allModels = this.#scopedModels.map(scoped => scoped.model);
			}
			availableModels = allModels;
		} else {
			const loadError = this.#registry.getError();
			this.#configError = loadError ? String(loadError) : undefined;
			allModels = this.#registry.getAll("all");
			try {
				availableModels = this.#registry.getAvailable("all");
			} catch (error) {
				this.#configError = error instanceof Error ? error.message : String(error);
				availableModels = [];
			}
		}

		this.#reloadRoles(availableModels);
		this.#buildRolesRows();

		const mruOrder = this.#settings.mruOrder;
		this.#availableItems = buildBrowserItems(availableModels);
		sortModelItems(this.#availableItems, { roles: this.#roles, mruOrder });
		this.#browser.setRoles(this.#roles);
		this.#browser.setMruOrder(mruOrder);
		this.#browser.setPerfStats(this.#settings.modelPerf);

		const bySelector = new Map(this.#availableItems.map(item => [item.selector, item]));
		this.#recentItems = [];
		for (const key of mruOrder) {
			const item = bySelector.get(key);
			if (item) this.#recentItems.push(item);
			if (this.#recentItems.length >= RECENT_LIMIT) break;
		}
		this.#recentSelectors = new Set(this.#recentItems.map(item => item.selector));

		this.#buildSidebar(allModels, availableModels);
		this.#restoreSidebarAnchor(anchor);
		this.#applyScope();
	}

	#buildSidebar(allModels: ReadonlyArray<Model>, availableModels: ReadonlyArray<Model>): void {
		const scoped = this.#scopedModels.length > 0;
		let disabledProviders: ReadonlySet<string>;
		try {
			disabledProviders = new Set(this.#settings.disabledProviders);
		} catch {
			disabledProviders = new Set();
		}

		const availableCounts = new Map<string, number>();
		for (const model of availableModels) {
			availableCounts.set(model.provider, (availableCounts.get(model.provider) ?? 0) + 1);
		}
		const catalogCounts = new Map<string, number>();
		for (const model of allModels) {
			catalogCounts.set(model.provider, (catalogCounts.get(model.provider) ?? 0) + 1);
		}

		const unlocked = new Set<string>(availableCounts.keys());
		const locked = new Set<string>();
		if (!scoped) {
			const authStorage = this.#registry.authStorage;
			for (const provider of catalogCounts.keys()) {
				if (!unlocked.has(provider) && !disabledProviders.has(provider)) {
					locked.add(provider);
				}
			}
			for (const provider of this.#registry.getDiscoverableProviders()) {
				if (unlocked.has(provider) || disabledProviders.has(provider)) continue;
				// Discoverable without stored auth: catalog-backed providers stay
				// locked; keyless/custom endpoints (ollama, vllm, …) surface as
				// selectable so discovery can populate them.
				const authenticated = authStorage.keys.source(provider) !== undefined;
				if (authenticated || !locked.has(provider)) {
					// #2761: implicit local endpoints (optional: true) stay hidden
					// until discovery actually reaches a server. "idle" means never
					// probed; "unavailable" means the endpoint is unreachable; both
					// would render a dead tab for a provider the user never
					// configured. models.yml discovery providers (optional: false)
					// and providers with stored auth keep their entry so
					// misconfigurations stay visible and diagnosable.
					if (!authenticated) {
						const discovery = this.#registry.getProviderDiscoveryState(provider);
						if (discovery?.optional && (discovery.status === "idle" || discovery.status === "unavailable")) {
							continue;
						}
					}
					locked.delete(provider);
					unlocked.add(provider);
				}
			}
		}

		for (const pinned of this.#pinnedProviders) {
			unlocked.add(pinned.id);
			locked.delete(pinned.id);
		}
		const oauthIds = new Set(getOAuthProviders().map(provider => provider.id));
		const providerEntry = (providerId: string, isLocked: boolean): SidebarEntry => ({
			id: `provider:${providerId}`,
			kind: "provider",
			label: this.#pinnedProviders.find(pinned => pinned.id === providerId)?.label ?? providerId,
			providerId,
			locked: isLocked,
			annotation: isLocked ? undefined : String(availableCounts.get(providerId) ?? 0),
			oauth: oauthIds.has(providerId),
			catalogCount: catalogCounts.get(providerId) ?? 0,
		});

		const visibleRoles = this.#visibleRoleIds();
		let assignedCount = 0;
		for (const role of visibleRoles) {
			const assignment = this.#roles[role];
			if (assignment && !assignment.autoSelected) assignedCount++;
		}

		// Roles leads the fixed section so downward hops from Recent head into
		// model scopes instead of being captured by the roles view.
		const fixed: SidebarEntry[] = this.#sessionOnly
			? [
					{ id: "recent", kind: "recent", label: "Recently used", annotation: String(this.#recentItems.length) },
					{ id: "all", kind: "all", label: "All models", annotation: String(availableModels.length) },
				]
			: [
					{
						id: "roles",
						kind: "roles",
						label: "Roles",
						annotation: `${assignedCount}/${visibleRoles.length}`,
					},
					{ id: "all", kind: "all", label: "All models", annotation: String(availableModels.length) },
				];

		this.#fixedEntries = fixed;
		this.#unlockedProviderEntries = [...unlocked]
			.sort((a, b) => a.localeCompare(b))
			.map(provider => providerEntry(provider, false));
		this.#lockedProviderEntries = [...locked]
			.sort((a, b) => a.localeCompare(b))
			.map(provider => providerEntry(provider, true));
		this.#composeEntries();
	}

	/**
	 * Assemble `#entries` from the stored sections. While a search is active,
	 * providers with matches float to the top of the provider section (each
	 * group stays alphabetical) so the hop order, mouse hit-testing, and the
	 * paint all agree.
	 */
	#composeEntries(): void {
		const counts = this.#searchCounts;
		let providers = this.#unlockedProviderEntries;
		if (counts) {
			providers = [...providers].sort((a, b) => {
				const aMatched = (counts.get(a.providerId ?? "") ?? 0) > 0;
				const bMatched = (counts.get(b.providerId ?? "") ?? 0) > 0;
				if (aMatched !== bMatched) return aMatched ? -1 : 1;
				return a.label.localeCompare(b.label);
			});
		}

		const entries: SidebarEntry[] = [...this.#fixedEntries];
		if (!this.#sessionOnly) {
			entries.push(
				{ id: "sep:effort", kind: "separator", label: "" },
				{
					id: "effort",
					kind: "effort",
					label: "Effort rules",
					annotation: String(this.#settings.effortRules.length),
				},
				{
					id: "context",
					kind: "effort",
					label: "Context rules",
					annotation: String(this.#settings.contextRules?.length ?? 0),
				},
				{ id: "overrides", kind: "overrides", label: "Model overrides" },
			);
		}
		if (providers.length > 0) {
			entries.push({ id: "sep:providers", kind: "separator", label: "" }, ...providers);
		}
		if (this.#lockedProviderEntries.length > 0) {
			entries.push({ id: "sep:locked", kind: "separator", label: "" }, ...this.#lockedProviderEntries);
		}

		this.#entries = entries;
		if (!entries.some(entry => entry.id === this.#activeEntryId)) {
			this.#activeEntryId = "all";
			this.#sidebarFollowActive = true;
		}
	}

	/** Snapshot the focused entry and its row within the sidebar viewport. */
	#captureSidebarAnchor(): SidebarAnchor {
		const index = this.#entries.findIndex(entry => entry.id === this.#activeEntryId);
		return { id: this.#activeEntryId, index, offset: index - this.#frame.sidebarScroll };
	}

	/**
	 * Reposition the sidebar after {@link #buildSidebar} rebuilt `#entries`. A
	 * surviving focused entry keeps its screen row; if it vanished (a keyless
	 * provider flipping back to hidden mid-navigation), focus falls to the
	 * nearest surviving entry instead of snapping to the top.
	 */
	#restoreSidebarAnchor(anchor: SidebarAnchor): void {
		if (anchor.index < 0) return;
		const survivor = this.#entries.findIndex(entry => entry.id === anchor.id);
		if (survivor >= 0) {
			this.#frame.sidebarScroll = Math.max(0, survivor - anchor.offset);
			return;
		}
		const replacement = this.#nearestNavigableEntry(anchor.index);
		if (!replacement) return;
		this.#activeEntryId = replacement.id;
		this.#frame.sidebarScroll = Math.max(0, this.#entries.indexOf(replacement) - anchor.offset);
	}

	/** The selectable entry nearest `preferredIndex` in the current `#entries`. */
	#nearestNavigableEntry(preferredIndex: number): SidebarEntry | undefined {
		const entries = this.#entries;
		if (entries.length === 0) return undefined;
		const start = Math.max(0, Math.min(preferredIndex, entries.length - 1));
		for (let radius = 0; radius < entries.length; radius++) {
			for (const index of radius === 0 ? [start] : [start + radius, start - radius]) {
				const entry = entries[index];
				if (entry && !this.#isHopSkipped(entry)) return entry;
			}
		}
		return undefined;
	}

	#activeEntry(): SidebarEntry {
		return this.#entries.find(entry => entry.id === this.#activeEntryId) ?? this.#entries[0];
	}

	#setActiveEntry(id: string): void {
		if (!this.#entries.some(entry => entry.id === id)) return;
		this.#activeEntryId = id;
		this.#sidebarFollowActive = true;
		this.#pinnedActionFocused = false;
		this.#applyScope();
		const entry = this.#activeEntry();
		if (entry.kind === "overrides") this.#overridesPanel?.reload();
		// Hops must never steal arrow focus: landing on a scope keeps provider
		// navigation active. Diving into the roles rows is explicit (Enter, →,
		// or a click on the Roles entry).
		this.#focus = "scope";
		if (
			entry.kind === "provider" &&
			!entry.locked &&
			!this.#pinnedProviders.some(pinned => pinned.id === entry.providerId)
		) {
			this.#scheduleProviderRefresh(entry.providerId ?? "");
		}
		this.#cancelScheduledRefreshesExcept(entry.kind === "provider" ? entry.providerId : undefined);
	}

	/** Push the active scope's items into the browser. */
	#applyScope(): void {
		const entry = this.#activeEntry();
		switch (entry.kind) {
			case "recent":
				this.#browser.setShowProvider(true);
				this.#setCandidateItems(this.#recentItems);
				break;
			case "provider": {
				if (entry.locked) {
					// Assign-mode renders the browser regardless of scope; a locked
					// provider contributes nothing selectable.
					this.#setCandidateItems([]);
					break;
				}
				const providerId = entry.providerId;
				this.#browser.setShowProvider(false);
				this.#setCandidateItems(this.#availableItems.filter(item => item.provider === providerId));
				break;
			}
			case "roles":
				this.#roleIndex = Math.min(this.#roleIndex, Math.max(0, this.#rolesRowCount - 1));
				break;
			default:
				this.#browser.setShowProvider(true);
				this.#setCandidateItems(this.#availableItems);
				break;
		}
	}

	/**
	 * Push the active scope's items into the browser. While assigning a role,
	 * the role's `accepts` predicate is re-applied here so a scope hop
	 * (provider/all/recent) can never surface a model the role rejects — role
	 * resolution and the runtime candidate pool filter the same way, so an
	 * unaccepted pick would persist a selector that never resolves.
	 */
	#setCandidateItems(items: ReadonlyArray<ModelBrowserItem>): void {
		const assigning = this.#assigning;
		const scoped =
			assigning?.kind === "role"
				? items.filter(item => this.#settings.getRoleInfo(assigning.role).accepts(item.model))
				: items;
		this.#candidateItems = [...scoped];
		this.#candidateCatalog = scoped === this.#availableItems ? this.#availableItems : undefined;
		this.#applyModelKind();
	}

	#applyModelKind(): void {
		const kind = this.#modelKindTab;
		this.#browserCatalog = kind === "all" ? this.#candidateCatalog : undefined;
		this.#browser.setItems(
			kind === "all"
				? [...this.#candidateItems]
				: this.#candidateItems.filter(item => modelKind(item.model) === kind),
		);
	}

	/**
	 * The configured `retry.fallbackChains` record with malformed keys/entries
	 * dropped: non-array chains and non-string selectors never reach the rows
	 * or chain editors, so an edit through the hub replaces them wholesale.
	 */
	#fallbackChains(): Record<string, string[]> {
		try {
			const chains = this.#settings.fallbackChains;
			if (!chains || typeof chains !== "object" || Array.isArray(chains)) return {};
			const sanitized: Record<string, string[]> = {};
			for (const key in chains) {
				const chain = (chains as Record<string, unknown>)[key];
				if (!Array.isArray(chain)) continue;
				sanitized[key] = chain.filter((entry): entry is string => typeof entry === "string");
			}
			return sanitized;
		} catch {
			return {};
		}
	}

	/**
	 * Rebuild the Roles view rows: each visible role followed by its
	 * fallback-chain entries, then model-oriented chains (`provider/model-id`
	 * and `provider/*` keys) as headed groups.
	 */
	#buildRolesRows(): void {
		const rows: RolesRow[] = [];
		const chains = this.#fallbackChains();
		const rawQuery = this.#rolesSearch.query;
		const regex = compileMenuRegex(rawQuery);
		const query = rawQuery.trim().toLowerCase();
		const matchesText = (value: string | undefined): boolean =>
			value !== undefined && (regex ? !!regex.regex?.test(value) : value.toLowerCase().includes(query));
		const matches = (role: string): boolean => {
			if (!query) return true;
			const info = this.#settings.getRoleInfo(role);
			const assignment = this.#roles[role];
			return [
				role,
				info.name,
				info.tag,
				assignment?.model.id,
				assignment?.model.provider,
				this.#settings.getModelRole(role),
				...(chains[role] ?? []),
			].some(matchesText);
		};
		const appendRoles = (roles: ReadonlyArray<string>): void => {
			for (const role of roles) {
				if (!matches(role)) continue;
				rows.push({ kind: "role", role });
				const chain = chains[role] ?? [];
				for (let i = 0; i < chain.length; i++) {
					if (query && !matchesText(chain[i])) continue;
					rows.push({ kind: "fallback", role, chainIndex: i, selector: chain[i] });
				}
			}
		};
		const visibleRoles = this.#visibleRoleIds();
		if (this.#roleTab === "all") {
			const chatRoles = visibleRoles.filter(role => this.#settings.getRoleInfo(role).section === "chat");
			const kindRoles = visibleRoles.filter(role => this.#settings.getRoleInfo(role).section === "kind");
			appendRoles(chatRoles);
			if (chatRoles.length > 0 && kindRoles.length > 0) rows.push({ kind: "separator" });
			appendRoles(kindRoles);
		} else {
			appendRoles(visibleRoles.filter(role => this.#settings.getRoleInfo(role).section === this.#roleTab));
		}
		if (!query) rows.push({ kind: "newRole" });
		rows.push({ kind: "separator" });
		const modelKeys = Object.keys(chains)
			.filter(key => key.includes("/") || selectorKind(key) === "regex")
			.sort();
		for (const key of modelKeys) {
			if (query && ![key, ...(chains[key] ?? [])].some(matchesText)) continue;
			const chain = chains[key] ?? [];
			rows.push({ kind: "chainKey", role: key });
			for (let i = 0; i < chain.length; i++) {
				if (query && !matchesText(chain[i])) continue;
				rows.push({ kind: "fallback", role: key, chainIndex: i, selector: chain[i] });
			}
		}
		if (!query) rows.push({ kind: "newFallback" });
		this.#rolesRows = rows.filter(
			(row, index) =>
				row.kind !== "separator" || (index > 0 && index < rows.length - 1 && rows[index - 1]?.kind !== "separator"),
		);
		this.#roleIndex = Math.max(0, Math.min(this.#roleIndex, this.#rolesRows.length - 1));
		if (this.#rolesRows[this.#roleIndex]?.kind === "separator")
			this.#roleIndex = this.#stepRoleIndex(this.#roleIndex, 1, { wrap: false });
	}

	/**
	 * Rows the Roles view lists on the All tab, separators aside: the picker's
	 * unfiltered `total`, counted in the same rows Tern counts as shown.
	 */
	#allRolesRowCount(): number {
		const chains = this.#fallbackChains();
		// "New role…" and "New fallback chain…", then each role and model chain with its fallback entries.
		let count = 2;
		for (const role of this.#visibleRoleIds()) count += 1 + (chains[role]?.length ?? 0);
		for (const key in chains) if (key.includes("/") || selectorKind(key) === "regex") count += 1 + chains[key].length;
		return count;
	}

	/** Refresh roles + dependent state after a settings mutation (assign/unassign). */
	#refreshAfterMutation(): void {
		this.#syncFromRegistryState();
		this.#requestRender();
	}

	/** Re-sync after an asynchronous callback finishes mutating settings. */
	refreshAfterExternalMutation(): void {
		this.#refreshAfterMutation();
	}

	/**
	 * Recompute per-provider match counts for the active query. Providers
	 * without matches gray out and the scope hop skips them; a provider scope
	 * that just lost its last match falls back to All models so the results
	 * never silently vanish.
	 */
	#onQueryChanged(query: string): void {
		this.#nativeVersion++;
		if (!query.trim()) {
			this.#searchCounts = null;
			this.#composeEntries();
			return;
		}
		const matches = this.#catalogMatches(query);
		const counts = new Map<string, number>();
		let recentCount = 0;
		for (const item of matches) {
			counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
			if (this.#recentSelectors.has(item.selector)) recentCount++;
		}
		this.#recentSearchCount = recentCount;
		this.#searchTotal = matches.length;
		this.#searchCounts = counts;
		this.#composeEntries();
		const entry = this.#activeEntry();
		if (
			this.#assigning === null &&
			entry.kind === "provider" &&
			(entry.locked ||
				((counts.get(entry.providerId ?? "") ?? 0) === 0 &&
					!this.#pinnedProviders.some(provider => provider.id === entry.providerId)))
		) {
			this.#setActiveEntry("all");
		}
	}

	/**
	 * Catalog items matching a non-blank `query`. When the browser holds the
	 * whole catalog its ranking for this query already ran, so reuse it;
	 * otherwise scan a catalog index kept across keystrokes.
	 */
	#catalogMatches(query: string): readonly ModelBrowserItem[] {
		if (this.#browserCatalog === this.#availableItems && this.#browser.query === query) {
			const ranked = this.#browser.queryMatches;
			if (ranked) return ranked;
		}
		const pattern = compileMenuRegex(query);
		if (pattern) {
			return this.#availableItems.filter(item => !!pattern.regex && modelMatchesRegex(item, pattern.regex));
		}
		let cached = this.#catalogCorpus;
		if (cached?.items !== this.#availableItems) {
			cached = { items: this.#availableItems, corpus: new FuzzyCorpus(this.#availableItems, modelSearchText) };
			this.#catalogCorpus = cached;
		}
		return cached.corpus.rank(query).map(result => result.item);
	}

	/**
	 * Scope hops skip separators; only All models filters provider hops by query.
	 * Other sections show full provider counts and must not inherit hidden filtering.
	 */
	#isHopSkipped(entry: SidebarEntry): boolean {
		if (entry.kind === "separator") return true;
		if (!this.#searchCounts || this.#activeEntry().kind !== "all") return false;
		if (entry.kind === "recent") return this.#recentSearchCount === 0;
		if (entry.kind === "provider") {
			if (entry.locked) return true;
			return (
				(this.#searchCounts.get(entry.providerId ?? "") ?? 0) === 0 &&
				!this.#pinnedProviders.some(provider => provider.id === entry.providerId)
			);
		}
		return false;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Provider discovery refresh
	// ═══════════════════════════════════════════════════════════════════════

	#startRefreshSpinner(): void {
		// Native surfaces clock the refresh spinner themselves.
		if (this.#refreshSpinnerInterval || isNativeRendering()) return;
		this.#refreshSpinnerInterval = setInterval(() => {
			const frameCount = theme.spinnerFrames.length;
			if (frameCount > 0) {
				this.#refreshSpinnerFrame = (this.#refreshSpinnerFrame + 1) % frameCount;
			}
			this.#requestRender();
		}, 80);
	}

	#stopRefreshSpinnerIfIdle(): void {
		if (this.#refreshingProviders.size > 0) return;
		if (this.#refreshSpinnerInterval) {
			clearInterval(this.#refreshSpinnerInterval);
			this.#refreshSpinnerInterval = undefined;
		}
		this.#refreshSpinnerFrame = 0;
	}

	#setProviderRefreshing(providerId: string, refreshing: boolean): void {
		if (refreshing) {
			this.#refreshingProviders.add(providerId);
			this.#startRefreshSpinner();
		} else {
			this.#refreshingProviders.delete(providerId);
			this.#stopRefreshSpinnerIfIdle();
		}
	}

	#cancelScheduledRefreshesExcept(keepProviderId?: string): void {
		// Hover debounce only. An explicit F5 queued behind an in-flight catalog
		// fetch must still re-mint credentials after that fetch settles, even if
		// the user has moved to All models or another provider.
		for (const [providerId, timer] of this.#scheduledProviderRefreshes) {
			if (providerId === keepProviderId) continue;
			clearTimeout(timer);
			this.#scheduledProviderRefreshes.delete(providerId);
			this.#setProviderRefreshing(providerId, false);
		}
	}

	#scheduleProviderRefresh(providerId: string, options?: { force?: boolean }): void {
		if (this.#scopedModels.length > 0 || !providerId) return;
		const force = options?.force === true;
		if (force) {
			const pending = this.#scheduledProviderRefreshes.get(providerId);
			if (pending) {
				// Selection already queued a catalog-only fetch. F5 upgrades it
				// instead of returning at the pending-guard and dropping force.
				clearTimeout(pending);
				this.#scheduledProviderRefreshes.delete(providerId);
				autoRefreshedProviders.add(providerId);
				void this.#refreshProviderInBackground(providerId, true);
				return;
			}
			if (this.#refreshingProviders.has(providerId)) {
				this.#pendingCredentialRefreshProviders.add(providerId);
				return;
			}
		} else if (this.#scheduledProviderRefreshes.has(providerId) || this.#refreshingProviders.has(providerId)) {
			return;
		}
		// Hovering a provider must not re-fetch on every visit: auto-refresh runs
		// at most once per provider for the process lifetime. F5 forces a re-fetch.
		if (!force && autoRefreshedProviders.has(providerId)) return;
		this.#setProviderRefreshing(providerId, true);
		const timer = setTimeout(() => {
			// Consume the once-guard only when the fetch actually starts: hopping
			// through a provider cancels the debounce and must not burn its slot.
			autoRefreshedProviders.add(providerId);
			this.#scheduledProviderRefreshes.delete(providerId);
			void this.#refreshProviderInBackground(providerId, force);
		}, PROVIDER_REFRESH_DEBOUNCE_MS);
		this.#scheduledProviderRefreshes.set(providerId, timer);
	}

	async #refreshProviderInBackground(providerId: string, refreshCommandCredentials = false): Promise<void> {
		try {
			if (refreshCommandCredentials) {
				await this.#registry.refreshProvider(providerId, "online", { refreshCommandCredentials: true });
			} else {
				await this.#registry.refreshProvider(providerId, "online");
			}
			// The provider refresh already updated the registry snapshot;
			// re-reading it here stays purely in-memory.
			this.#syncFromRegistryState();
		} catch (error) {
			this.#configError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#setProviderRefreshing(providerId, false);
			if (!this.#disposed && this.#pendingCredentialRefreshProviders.delete(providerId)) {
				this.#setProviderRefreshing(providerId, true);
				autoRefreshedProviders.add(providerId);
				void this.#refreshProviderInBackground(providerId, true);
			}
			this.#requestRender();
		}
	}

	#formatDiscoveryAge(fetchedAt: number | undefined): string | undefined {
		if (!fetchedAt) return undefined;
		const ageMs = Math.max(0, Date.now() - fetchedAt);
		if (ageMs < 60_000) return "less than a minute ago";
		return `${Math.round(ageMs / 60_000)}m ago`;
	}

	#emptyStateMessage(): string | undefined {
		if (this.#configError) return `  ${this.#configError}`;
		const entry = this.#activeEntry();
		if (entry.kind === "recent") return "  No recently used models yet";
		if (entry.kind !== "provider" || entry.locked) return undefined;
		if (this.#browser.query.trim()) {
			return `  No matching models in ${entry.label}. Switch to All models to search every provider.`;
		}
		const providerId = entry.providerId ?? "";
		const state = this.#registry.getProviderDiscoveryState(providerId);
		if (!state) return undefined;
		const age = this.#formatDiscoveryAge(state.fetchedAt);
		switch (state.status) {
			case "cached":
				return age
					? `  Using cached model list from ${age}. Live refresh is still pending.`
					: "  Using cached model list. Live refresh is still pending.";
			case "unavailable": {
				const httpMatch = state.error?.match(/^HTTP (\d+) from (.+)$/);
				if (httpMatch?.[1] === "404") {
					return `  Discovery endpoint ${httpMatch[2]} returned 404. Point baseUrl at the host that serves /models (usually .../v1).`;
				}
				if (state.error) return `  Discovery failed: ${state.error}`;
				return age ? `  Provider unavailable. Using cached model list from ${age}.` : "  Provider unavailable.";
			}
			case "unauthenticated":
				return "  Provider requires authentication before models can be discovered.";
			case "idle":
				return "  Provider has not been refreshed yet.";
			case "empty":
				return "  Discovery succeeded but returned 0 models. Check that /models returns { data: [{ id }] }.";
			case "ok":
				return undefined;
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Assignment flow
	// ═══════════════════════════════════════════════════════════════════════

	#activateItem(item: ModelBrowserItem): void {
		// Also reached from the browser's own native list events, which bypass handleInput.
		this.#nativeVersion++;
		if (this.#sessionOnly) {
			const result = this.#callbacks.onPick?.(item.model, item.selector);
			this.#finishAssignment(result, () => this.#requestRender());
			return;
		}
		if (this.#assigning) {
			const target = this.#assigning;
			this.#assigning = null;
			if (target.kind === "role") {
				this.#assignRole(item, target.role, true);
			} else if (target.kind === "fallbackKey") {
				this.#openFallbackKeyStrip(item);
			} else if (target.kind === "effortRule") {
				if (this.#contextRulesView()) this.#openContextLimit(item.selector);
				else this.#openEffortLevels({ item, pendingRuleSelector: item.selector });
			} else {
				const old = target.index === null ? undefined : this.#fallbackChains()[target.role]?.[target.index];
				const parsed = old ? this.#parseFallbackEntry(old) : undefined;
				const same = parsed && this.#findFallbackModel(parsed.provider, parsed.id)?.selector === item.selector;
				this.#openFallbackChoice(item, target, same ? old : undefined);
			}
			return;
		}
		this.#openRoleStrip(item);
	}

	#roleForScope(role: string, scope: ModelRoleSelectionScope): ResolvedModelRoleValue {
		const roleValue =
			scope === "session"
				? this.#settings.getSessionModelRole?.(role)
				: scope === "project" ? this.#settings.getProjectModelRole(role) : this.#settings.getGlobalModelRole(role);
		const allModels =
			this.#scopedModels.length > 0
				? scopedRolePool(
						this.#scopedModels.map(scoped => scoped.model),
						this.#registry,
					)
				: this.#registry.getAll("all");
		const roleLookup: ModelRoleLookup = {
			getModelRole: scopedRole =>
				scope === "session"
					? (this.#settings.getSessionModelRole?.(scopedRole) ?? this.#settings.getProjectModelRole(scopedRole) ?? this.#settings.getGlobalModelRole(scopedRole))
					:
				scope === "project"
					? (this.#settings.getProjectModelRole(scopedRole) ?? this.#settings.getGlobalModelRole(scopedRole))
					: this.#settings.getGlobalModelRole(scopedRole),
		};
		return this.#settings.resolveRoleValue(roleValue, allModels, roleLookup);
	}

	#thinkingLevelForScope(role: string, scope: ModelRoleSelectionScope): ConfiguredThinkingLevel {
		const resolved = this.#roleForScope(role, scope);
		return resolved.explicitThinkingLevel ? (resolved.thinkingLevel ?? ThinkingLevel.Inherit) : ThinkingLevel.Inherit;
	}
	#finishAssignment(result: void | boolean | Promise<void | boolean>, onSuccess: () => void): void {
		if (!(result instanceof Promise)) {
			if (result !== false) onSuccess();
			else this.#requestRender();
			return;
		}
		this.#assignmentPending = true;
		this.#requestRender();
		void result.then(
			applied => {
				this.#assignmentPending = false;
				if (this.#disposed) return;
				if (applied !== false) this.#withNavigationVisit(onSuccess);
				else this.#requestRender();
			},
			() => {
				this.#assignmentPending = false;
				if (!this.#disposed) this.#requestRender();
			},
		);
	}

	/** Stage a reasoning model and scope; cancel before choosing effort leaves the assignment unchanged. */
	#assignRole(item: ModelBrowserItem, role: string, returnToRoles: boolean, scope?: ModelRoleSelectionScope): void {
		scope = this.#settings.editingScope ?? scope;
		if (this.#settings.modelRoleStorage === "project" && scope === undefined) {
			this.#openScopeStrip(item, role, returnToRoles);
			return;
		}
		if (!item.model.reasoning) {
			const result = this.#callbacks.onAssign(item.model, role, ThinkingLevel.Inherit, item.selector, scope);
			this.#finishAssignment(result, () => {
				this.#refreshAfterMutation();
				if (returnToRoles) {
					this.#setActiveEntry("roles");
					this.#focus = "list";
				}
			});
			return;
		}
		this.#openThinkingStrip(item, role, returnToRoles, scope);
	}

	#unassignRole(role: string): void {
		const assignment = this.#roles[role];
		if (!assignment || assignment.autoSelected) return;
		if (this.#settings.editingScope) {
			this.#callbacks.onUnassign(role, this.#settings.editingScope);
		} else if (this.#settings.modelRoleStorage === "project") {
			const source = this.#settings.getModelRoleSource(role);
			this.#callbacks.onUnassign(role, source === "default" ? undefined : source);
		} else {
			this.#callbacks.onUnassign(role);
		}
		this.#refreshAfterMutation();
	}

	/**
	 * Non-reasoning models have no thinking strip; for reasoning models the
	 * dedicated effort role excludes recursive auto selection.
	 */
	#thinkingOptionsFor(model: Model, role?: string): ConfiguredThinkingLevel[] {
		if (!model.reasoning) return [];
		if (model.thinking?.unverified) return [ThinkingLevel.Inherit, ThinkingLevel.Off, ...getSupportedEfforts(model)];
		return [
			ThinkingLevel.Inherit,
			ThinkingLevel.Off,
			...(role === "effort" ? [] : [AUTO_THINKING]),
			...getSupportedEfforts(model),
		];
	}

	/**
	 * Resolve what `t` on a role row would edit: the role's model in its
	 * persisted scope. Undefined when the role is unassigned or its model has
	 * no thinking levels to offer, which makes both `t` and its footer hint
	 * inert — the same rule wildcard fallback rows follow.
	 */
	#roleThinkingTarget(role: string): { item: ModelBrowserItem; scope?: ModelRoleSelectionScope } | undefined {
		const assignment = this.#roles[role];
		if (!assignment) return undefined;
		const source =
			this.#settings.modelRoleStorage === "project" ? this.#settings.getModelRoleSource(role) : "default";
		const scope = this.#settings.editingScope ?? (source === "project" || source === "global" ? source : undefined);
		const model = scope ? this.#roleForScope(role, scope).model : assignment.model;
		if (!model || this.#thinkingOptionsFor(model).length === 0) return undefined;
		const storedSelector =
			scope === "project"
				? this.#settings.getProjectModelRole(role)
				: scope === "global"
					? this.#settings.getGlobalModelRole(role)
					: this.#settings.getModelRole(role);
		const selector =
			storedSelector && isPatternSelector(storedSelector) && !storedSelector.includes(",")
				? storedSelector
				: `${model.provider}/${model.id}`;
		return {
			item: { provider: model.provider, id: model.id, model, selector },
			scope,
		};
	}

	/** Offer only the roles this model can actually fill (chat roles for chat models, `web` for search runners, …). */
	#openRoleStrip(item: ModelBrowserItem): void {
		const chips: StripChip[] = [];
		const scopedStorage = this.#settings.modelRoleStorage === "project";
		const scopes: readonly ModelRoleSelectionScope[] = this.#settings.editingScope
			? [this.#settings.editingScope]
			: scopedStorage ? ["global", "project"] : ["global"];
		for (const role of this.#visibleRoleIds()) {
			const info = this.#settings.getRoleInfo(role);
			if (!info.accepts(item.model)) continue;
			const assignment = this.#roles[role];
			for (const scope of scopes) {
				const scopedModel = scopedStorage
					? this.#roleForScope(role, scope).model
					: assignment && !assignment.autoSelected
						? assignment.model
						: undefined;
				const assignedHere =
					!!scopedModel && scopedModel.provider === item.model.provider && scopedModel.id === item.model.id;
				const roleLabel = (info.tag ?? info.name ?? role).toLowerCase() + uiProvenanceSuffix("roles", role);
				const label = scopedStorage ? `${scope} ${roleLabel}` : roleLabel;
				chips.push({
					label,
					styled: assignedHere
						? // Separator required: under the `nerd` preset this glyph is a
							// two-cell-wide PUA icon that `visibleWidth` counts as one, so
							// without it the icon overhangs and eats `label`'s first char.
							theme.fg(info.color ?? "muted", `${theme.status.enabled} ${label}`) +
							theme.fg("dim", ` ${theme.status.success}`)
						: theme.fg(info.color ?? "muted", label),
					role,
					scope,
					action: assignedHere ? "unassign" : "assign",
				});
			}
		}
		chips.push({
			label: `fallbacks:${item.model.id}`,
			styled: theme.fg("muted", `fallbacks:${item.model.id}`),
			action: "fallbackModel",
		});
		chips.push({
			label: `fallbacks:${item.model.provider}/*`,
			styled: theme.fg("muted", `fallbacks:${item.model.provider}/*`),
			action: "fallbackProvider",
		});
		// `retry-fallback` appends to the default chain, so only chat-capable models qualify.
		if (this.#settings.getRoleInfo("default").accepts(item.model)) {
			chips.push({ label: "fallback", styled: theme.fg("muted", "retry-fallback"), action: "fallback" });
		}
		this.#strip = { kind: "role", item, chips, index: 0, returnToRoles: false };
	}

	#openScopeStrip(item: ModelBrowserItem, role: string, returnToRoles: boolean): void {
		const chips: StripChip[] = [
			{ label: "global", styled: theme.fg("accent", "global"), action: "scope", scope: "global" },
			{ label: "project", styled: theme.fg("muted", "project"), action: "scope", scope: "project" },
		];
		this.#strip = { kind: "scope", item, role, chips, index: 0, returnToRoles };
	}

	#openThinkingStrip(
		item: ModelBrowserItem,
		role: string,
		returnToRoles: boolean,
		scope?: ModelRoleSelectionScope,
		committedLevel?: ConfiguredThinkingLevel,
	): void {
		const scoped = scope ?? "global";
		const saved =
			this.#settings.editingScope
				? this.#settings.getRoleEffortSelection(role)
				: scoped === "project"
					? this.#settings.getProjectRoleEffortSelection(role)
					: this.#settings.getGlobalRoleEffortSelection(role);
		const selection =
			saved?.mode === "auto" && saved.selector && saved.selector !== item.selector ? undefined : saved;
		const options = this.#thinkingOptionsFor(item.model, role);
		const current =
			committedLevel ??
			(selection?.mode === "auto"
				? AUTO_THINKING
				: selection?.mode === "fixed"
					? selection.level
					: this.#settings.modelRoleStorage === "project" && scope !== undefined
						? this.#thinkingLevelForScope(role, scope)
						: (this.#roles[role]?.thinkingLevel ?? ThinkingLevel.Inherit));
		const chips = this.#thinkingChips(options);
		const preselect = options.indexOf(current);
		this.#strip = {
			kind: "thinking",
			item,
			role,
			scope,
			chips,
			index: preselect >= 0 ? preselect : 0,
			returnToRoles,
			initialThinkingLevel: current,
			initialSelection: selection,
		};
	}

	/** Build the footer chips for a thinking strip from its level options. */
	#thinkingChips(options: ConfiguredThinkingLevel[]): StripChip[] {
		return options.map(level => {
			const label = getConfiguredThinkingLevelMetadata(level).label;
			const glyph = thinkingLevelGlyph(level, theme);
			return {
				label,
				styled: glyph ? `${theme.fg("accent", glyph)} ${label}` : label,
				action: "thinking",
				thinkingLevel: level,
			};
		});
	}

	#effortSelectionFor(level: ConfiguredThinkingLevel): HubEffortSelection {
		return level === ThinkingLevel.Inherit ? { mode: "inherit" } : { mode: "fixed", level: level as ThinkingLevel };
	}

	#openSelectorPattern(
		target: "rule" | "fallback" | "role" | "fallbackKey",
		fallbackTarget?: { role: string; index: number | null },
		role?: string,
	): void {
		const input = new Input();
		input.focused = true;
		if (target === "fallbackKey" && role) input.setValue(role);
		if (fallbackTarget?.index !== null && fallbackTarget?.index !== undefined) {
			const previous = this.#fallbackChains()[fallbackTarget.role]?.[fallbackTarget.index];
			if (previous) input.setValue(previous);
		}
		this.#strip = { kind: "pattern", input, target, fallbackTarget, role };
		this.#configError = undefined;
	}

	#submitSelectorPattern(strip: Extract<StripState, { kind: "pattern" }>): void {
		const selector = strip.input.getValue().trim();
		if (selectorKind(selector) === "regex") {
			// A regex selector is matched against the whole `provider/model-id`
			// string, so neither a slash nor a provider prefix is required.
			if (selector.length === REGEX_SELECTOR_PREFIX.length) {
				this.#configError = "Enter a regular expression after re:";
				return;
			}
			const compiled = compileSelectorRegex(selector);
			if ("error" in compiled) {
				// The engine's own message already reads "Invalid regular expression: …".
				this.#configError = compiled.error;
				return;
			}
		} else {
			if (!selector || !selector.includes("/") || selector.startsWith("/") || selector.endsWith("/")) {
				this.#configError = "Enter a provider/model selector, provider/* glob, or re: regex";
				return;
			}
			if (
				strip.target === "fallbackKey" &&
				selectorKind(selector) === "glob" &&
				!/^([^/*?[\]{}]+\/)+\*$/.test(selector)
			) {
				this.#configError = "Chain keys support provider/* or provider/prefix/* only; use re: for other patterns";
				return;
			}
			try {
				if (isPatternSelector(selector)) new Bun.Glob(selector);
			} catch {
				this.#configError = "Invalid model glob";
				return;
			}
		}
		this.#configError = undefined;
		if (strip.target === "fallbackKey") {
			const chains = this.#fallbackChains();
			if (selector !== strip.role && Object.hasOwn(chains, selector)) {
				this.#configError = `Fallback chain already exists: ${selector}`;
				return;
			}
			if (strip.role) {
				if (selector !== strip.role) {
					if (!this.#callbacks.onFallbackChainKeyChange) {
						this.#configError = "Renaming fallback chains is unavailable";
						return;
					}
					if (this.#callbacks.onFallbackChainKeyChange(strip.role, selector) === false) return;
				}
				this.#strip = null;
				this.#refreshAfterMutation();
				const index = this.#rolesRows.findIndex(row => row.kind === "chainKey" && row.role === selector);
				if (index >= 0) this.#roleIndex = index;
			} else {
				this.#openFallbackSelectorChoice(selector, null);
			}
			return;
		}
		if (strip.target === "rule") {
			if (this.#contextRulesView()) this.#openContextLimit(selector);
			else {
				const index = this.#settings.effortRules.findIndex(rule => rule.selector === selector);
				this.#openEffortLevels({ ruleIndex: index < 0 ? undefined : index, pendingRuleSelector: selector });
			}
		} else if (strip.target === "role" && strip.role) {
			const models =
				this.#scopedModels.length > 0 ? this.#scopedModels.map(entry => entry.model) : this.#registry.getAll("all");
			const resolved = this.#settings.resolveRoleValue(selector, models);
			if (!resolved.model || !this.#settings.getRoleInfo(strip.role).accepts(resolved.model)) {
				this.#configError = "Pattern does not resolve to a compatible model";
				return;
			}
			const model = resolved.model;
			this.#assignRole({ model, provider: model.provider, id: model.id, selector }, strip.role, true);
		} else if (strip.fallbackTarget) {
			this.#openPatternFallbackEffort(selector, strip.fallbackTarget);
		}
	}

	#openFallbackSelectorChoice(role: string, index: number | null): void {
		this.#strip = {
			kind: "selectorChoice",
			target: { kind: "fallback", role, index },
			index: 0,
			chips: [
				{ action: "thinking", label: "pick model…", styled: theme.fg("accent", "pick model…") },
				{ action: "thinking", label: "pattern…", styled: theme.fg("muted", "pattern…") },
			],
		};
	}

	#selectorStripLabel(strip: Extract<StripState, { kind: "selectorChoice" | "patternEffort" }>): string {
		if (strip.kind === "patternEffort") return strip.selector;
		return strip.target.kind === "fallbackKey" ? "New fallback chain" : strip.target.role;
	}

	#openFallbackKeySelectorChoice(): void {
		this.#strip = {
			kind: "selectorChoice",
			target: { kind: "fallbackKey" },
			index: 0,
			chips: [
				{ action: "thinking", label: "pick model…", styled: theme.fg("accent", "pick model…") },
				{ action: "thinking", label: "pattern…", styled: theme.fg("muted", "pattern…") },
			],
		};
	}

	#openRoleSelectorChoice(role: string): void {
		this.#strip = {
			kind: "selectorChoice",
			target: { kind: "role", role },
			index: 0,
			chips: [
				{ action: "thinking", label: "pick model…", styled: theme.fg("accent", "pick model…") },
				{ action: "thinking", label: "pattern…", styled: theme.fg("muted", "pattern…") },
			],
		};
	}

	#activateSelectorChoice(strip: Extract<StripState, { kind: "selectorChoice" }>): void {
		const target = strip.target;
		this.#strip = null;
		if (target.kind === "role") {
			if (strip.index === 0) this.#startAssign(target.role);
			else this.#openSelectorPattern("role", undefined, target.role);
		} else if (target.kind === "fallbackKey") {
			if (strip.index === 0) this.#startAssignFallbackKey();
			else this.#openSelectorPattern("fallbackKey");
		} else if (strip.index === 0) this.#startAssignFallback(target.role, target.index);
		else this.#openSelectorPattern("fallback", target);
	}

	#contextRulesView(): boolean {
		return this.#activeEntry().id === "context";
	}

	#rules(): readonly (HubEffortRule | HubContextRule)[] {
		return this.#contextRulesView() ? (this.#settings.contextRules ?? []) : this.#settings.effortRules;
	}

	#saveRules(rules: (HubEffortRule | HubContextRule)[]): boolean | void {
		return this.#contextRulesView()
			? this.#callbacks.onContextRulesChange?.(rules.filter((rule): rule is HubContextRule => "limit" in rule))
			: this.#callbacks.onEffortRulesChange?.(rules.filter((rule): rule is HubEffortRule => "allowed" in rule));
	}

	#openContextLimit(selector: string): void {
		const input = new Input();
		const previous = this.#settings.contextRules?.find(rule => rule.selector === selector);
		if (previous) input.setValue(String(previous.limit));
		input.focused = true;
		this.#strip = { kind: "name", purpose: "contextRule", selector, input };
	}

	#ruleValue(rule: HubEffortRule | HubContextRule): string {
		return "limit" in rule ? String(rule.limit) : rule.allowed.join(", ");
	}

	#handleEffortRulesInput(data: string): void {
		if (this.#focus === "scope") {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n" || matchesKey(data, "space"))
				this.#focus = "list";
			return;
		}
		this.#syncEffortSelection();
		const count = this.#rules().length;
		if (this.#effortIndex < 0) return;
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#filterEditing = false;
			if (this.#effortIndex === count) {
				this.#assigning = { kind: "effortRule" };
				this.#browser.setQuery("");
				this.#setCandidateItems(this.#availableItems);
			} else if (this.#effortIndex === count + 1) this.#openSelectorPattern("rule");
			else if (this.#contextRulesView()) this.#openContextLimit(this.#rules()[this.#effortIndex].selector);
			else this.#openEffortLevels({ ruleIndex: this.#effortIndex });
		} else if (
			this.#effortIndex < count &&
			(matchesKey(data, "backspace") || matchesKey(data, "delete") || extractPrintableText(data) === "x")
		) {
			const rules = [...this.#rules()];
			rules.splice(this.#effortIndex, 1);
			this.#saveRules(rules);
			this.#effortIndex = Math.min(this.#effortIndex, rules.length);
			this.#refreshAfterMutation();
		} else if (
			this.#effortIndex < count &&
			(matchesKey(data, "shift+up") ||
				extractPrintableText(data) === "[" ||
				matchesKey(data, "shift+down") ||
				extractPrintableText(data) === "]")
		) {
			const delta = matchesKey(data, "shift+up") || extractPrintableText(data) === "[" ? -1 : 1;
			const rules = [...this.#rules()];
			// Only listed order within one pattern kind decides precedence: a regex
			// always outranks a glob, and exact rules outrank both, so a move hops
			// over rules of any other kind instead of pretending to reorder them.
			const kind = selectorKind(rules[this.#effortIndex]?.selector ?? "");
			if (kind === "exact") return;
			let next = this.#effortIndex + delta;
			while (next >= 0 && next < count && selectorKind(rules[next]?.selector ?? "") !== kind) next += delta;
			if (next < 0 || next >= count) return;
			[rules[this.#effortIndex], rules[next]] = [rules[next], rules[this.#effortIndex]];
			this.#saveRules(rules);
			this.#effortIndex = next;
			this.#refreshAfterMutation();
		}
	}

	#effortRowKey(index: number): string {
		const rule = this.#rules()[index];
		return rule ? `rule:${rule.selector}` : index === this.#rules().length ? "newExact" : "newPattern";
	}

	#effortRowText(index: number): string {
		const rules = this.#rules();
		const rule = rules[index];
		if (!rule) return index === rules.length ? "+ Pick exact model…" : "+ Enter glob or re: regex…";
		const kind = selectorKind(rule.selector);
		const prefix = kind === "exact" ? "exact" : `${index + 1}. ${kind}`;
		return `${prefix}  ${rule.selector}  [${this.#ruleValue(rule)}]`;
	}

	#syncEffortSelection(): readonly number[] {
		const count = this.#rules().length + 2;
		if (this.#effortRows.length !== count) this.#effortRows = Array.from({ length: count }, (_, index) => index);
		this.#effortSelection.setItems(this.#effortRows, String(this.#effortIndex));
		this.#effortSelection.setQuery(this.#effortSearch.query);
		if (this.#effortIndex >= 0) this.#effortSelection.setSelectedKey(String(this.#effortIndex));
		this.#effortIndex = this.#effortSelection.selectedItem ?? -1;
		return this.#effortSelection.visibleItems;
	}

	#ruleHeaderRows = 3;
	#renderEffortRules(width: number, rows: number): string[] {
		const indices = this.#syncEffortSelection();
		const description = Bun.wrapAnsi(
			this.#contextRulesView() ? CONTEXT_RULE_DESCRIPTION : EFFORT_RULE_DESCRIPTION,
			Math.max(1, width - 2),
		).split("\n");
		this.#ruleHeaderRows = description.length + 2;
		const window = Math.max(1, rows - this.#ruleHeaderRows - 1);
		this.#effortVisibleCount = window;
		if (this.#effortIndex !== this.#effortLastIndex) this.#effortViewport.reveal();
		this.#effortLastIndex = this.#effortIndex;
		const view = this.#effortViewport.layout(
			indices.map(() => 1),
			this.#effortSelection.selectedIndex,
			window,
		);
		this.#effortScrollStart = view.startIndex;
		const lines = [
			theme.fg("muted", " Exact rules win, then regex, then glob — each in listed order"),
			...description.map(line => theme.fg("muted", ` ${line}`)),
			this.#effortSearch.render(width, { muted: value => theme.fg("muted", value) }),
		];
		if (indices.length === 0) lines.push(theme.fg("muted", " No matching rules"));
		const body: string[] = [];
		for (let row = view.startIndex; row < view.endIndex; row++) {
			const index = indices[row];
			const selected = this.#effortIndex === index;
			const cursor = selected && this.#focus === "list" ? theme.fg("accent", theme.nav.cursor) : " ";
			const label = this.#effortRowText(index);
			body.push(truncateToWidth(` ${cursor} ${selected ? theme.fg("accent", label) : label}`, width));
		}
		lines.push(
			...(view.lineOffset === 0 && body.length <= window
				? body
				: body.slice(view.lineOffset, view.lineOffset + window)),
		);
		return lines;
	}

	#openEffortLevels(options: {
		item?: ModelBrowserItem;
		selector?: string;
		role?: string;
		scope?: ModelRoleSelectionScope;
		fallbackTarget?: { role: string; index: number | null };
		ruleIndex?: number;
		pendingRuleSelector?: string;
		baseSelection?: HubEffortSelection;
	}): void {
		const rule =
			options.ruleIndex !== undefined
				? this.#settings.effortRules[options.ruleIndex]
				: this.#settings.effortRules.find(entry => entry.selector === options.pendingRuleSelector);
		const isRule = options.ruleIndex !== undefined || options.pendingRuleSelector !== undefined;
		let levels: readonly ThinkingEffort[];
		if (isRule) {
			const selector = options.item?.selector ?? rule?.selector ?? options.pendingRuleSelector;
			const matchesSelector = selector ? compilePatternSelectorMatcher(selector) : undefined;
			const models = options.item
				? [options.item.model]
				: this.#registry.getAll("all").filter(model => matchesSelector?.(`${model.provider}/${model.id}`));
			levels = THINKING_CHOICES.filter(effort =>
				effort !== "off" && selector && isPatternSelector(selector)
					? true
					: models.some(model => getSupportedThinkingLevels(model).includes(effort)),
			);
		} else if (options.item && isPatternSelector(options.item.selector)) {
			const selector = options.item.selector;
			const matchesSelector = compilePatternSelectorMatcher(selector);
			const models =
				this.#scopedModels.length > 0 ? this.#scopedModels.map(entry => entry.model) : this.#registry.getAll("all");
			const matches = models.filter(
				model =>
					matchesSelector(`${model.provider}/${model.id}`) &&
					(!options.role || this.#settings.getRoleInfo(options.role).accepts(model)),
			);
			levels = THINKING_CHOICES.filter(effort =>
				matches.some(model => this.#settings.permittedEfforts(model).includes(effort)),
			);
		} else {
			const matchesSelector = options.selector ? compilePatternSelectorMatcher(options.selector) : undefined;
			levels = options.item
				? this.#settings.permittedEfforts(options.item.model)
				: THINKING_CHOICES.filter(
						effort =>
							effort !== "off" ||
							this.#registry
								.getAll("all")
								.some(
									model =>
										matchesSelector?.(`${model.provider}/${model.id}`) &&
										getSupportedThinkingLevels(model).includes("off"),
								),
					);
		}
		const saved =
			rule?.allowed ?? (options.baseSelection?.mode === "auto" ? options.baseSelection.allowed : undefined);
		this.#configError = undefined;
		this.#strip = { kind: "effortLevels", ...options, toggle: new EffortToggle(levels, saved), index: 0 };
	}

	#confirmEffortLevels(strip: Extract<StripState, { kind: "effortLevels" }>): void {
		const allowed = strip.toggle.confirm();
		if (!allowed) {
			this.#configError = "Select at least one effort level before saving";
			this.#tui.requestRender();
			return;
		}
		if (strip.pendingRuleSelector || strip.ruleIndex !== undefined) {
			const rules = [...this.#settings.effortRules];
			const selector = strip.pendingRuleSelector ?? rules[strip.ruleIndex ?? -1]?.selector;
			if (!selector) return;
			const index = rules.findIndex(rule => rule.selector === selector);
			if (index >= 0) rules[index] = { selector, allowed };
			else rules.push({ selector, allowed });
			if (this.#callbacks.onEffortRulesChange?.(rules) === false) return;
			this.#effortIndex = index >= 0 ? index : rules.length - 1;
			this.#refreshAfterMutation();
			this.#closeStrip();
		} else if (strip.fallbackTarget) {
			const selector = strip.selector ?? strip.item?.selector;
			if (!selector) return;
			if (!this.#commitFallbackSelection(selector, strip.fallbackTarget, { mode: "auto", allowed })) return;
		} else if (strip.item && strip.role) {
			this.#saveRoleSelection(strip.item, strip.role, strip.scope, {
				mode: "auto",
				allowed,
				selector: strip.item.selector,
			});
		}
	}

	#saveRoleSelection(
		item: ModelBrowserItem,
		role: string,
		scope: ModelRoleSelectionScope | undefined,
		selection: HubEffortSelection,
	): void {
		const level =
			selection.mode === "auto"
				? AUTO_THINKING
				: selection.mode === "fixed"
					? selection.level
					: ThinkingLevel.Inherit;
		const result = this.#callbacks.onAssign(item.model, role, level, item.selector, scope, selection);
		this.#finishAssignment(result, () => {
			this.#closeStrip();
			this.#refreshAfterMutation();
		});
	}

	/**
	 * Fallback-entry model lookup through the registry — the same
	 * case-insensitive, alias-aware resolution the runtime uses, so
	 * `OpenAI/GPT-5.5` edits the model it runs. Covers locked providers too:
	 * effort support is a catalog fact, not an auth fact, and the row already
	 * exists, so the strip changes no scope.
	 */
	#findFallbackModel(provider: string, id: string): ModelBrowserItem | undefined {
		const model = this.#registry.find(provider, id);
		if (!model) return undefined;
		return { provider: model.provider, id: model.id, model, selector: `${model.provider}/${model.id}` };
	}

	/**
	 * Split a fallback-chain entry into its model base, explicit effort, and
	 * `@upstream` routing. An exact literal id wins over routing
	 * (`google-vertex/claude-opus-4-8@default` is a real model, not a route —
	 * mirroring the runtime's exact-first precedence); otherwise the routing
	 * slug is kept verbatim so saves can re-attach it (`openrouter/id@fireworks`
	 * looks up `openrouter/id` but persists with the route intact). A `re:`
	 * selector is never a model reference: its `:`, `@` and `/` belong to the
	 * expression, so it stays unparsed and takes the pattern path.
	 */
	#parseFallbackEntry(raw: string):
		| {
				provider: string;
				id: string;
				thinkingLevel?: ConfiguredThinkingLevel;
				upstream: string | undefined;
		  }
		| undefined {
		const trimmed = raw.trim();
		if (selectorKind(trimmed) === "regex") return undefined;
		const parse = (pattern: string) =>
			parseModelString(pattern, {
				allowMaxSuffix: true,
				allowAutoAlias: true,
				isLiteralModelId: (provider, id) => this.#findFallbackModel(provider, id) !== undefined,
			});
		const literal = parse(trimmed);
		if (literal && this.#findFallbackModel(literal.provider, literal.id)) return { ...literal, upstream: undefined };
		const routing = splitUpstreamRouting(trimmed);
		if (!routing) {
			if (!literal) return undefined;
			return { ...literal, upstream: undefined };
		}
		const parsed = parse(routing.base.trim());
		if (!parsed) return undefined;
		return { ...parsed, upstream: routing.upstream };
	}

	/**
	 * Exact fallback rows use their catalog model for capability filtering;
	 * wildcard/pattern entries have no single capability ladder and instead
	 * offer all efforts in their editor (the runtime intersects each match).
	 */
	#resolveFallbackEntry(
		role: string,
		index: number,
	):
		| { item: ModelBrowserItem; thinkingLevel: ConfiguredThinkingLevel | undefined; upstream: string | undefined }
		| undefined {
		const raw = this.#fallbackChains()[role]?.[index];
		if (!raw || raw.endsWith("/*")) return undefined;
		const parsed = this.#parseFallbackEntry(raw);
		if (!parsed) return undefined;
		const item = this.#findFallbackModel(parsed.provider, parsed.id);
		if (!item) return undefined;
		return { item, thinkingLevel: parsed.thinkingLevel, upstream: parsed.upstream };
	}

	/** Edit an existing exact or pattern fallback without changing its selector on cancel. */
	#openFallbackThinkingStrip(row: { role: string; chainIndex: number }): void {
		const selector = this.#fallbackChains()[row.role]?.[row.chainIndex];
		if (!selector) return;
		const target = { role: row.role, index: row.chainIndex };
		const resolved = this.#resolveFallbackEntry(row.role, row.chainIndex);
		if (resolved) {
			this.#openFallbackChoice(resolved.item, target, selector);
		} else {
			this.#openPatternFallbackEffort(selector, target);
		}
	}

	#openPatternFallbackEffort(selector: string, target: { role: string; index: number | null }): void {
		const parsed = this.#parseFallbackEntry(selector);
		const canonical =
			parsed?.thinkingLevel === undefined
				? selector
				: `${parsed.provider}/${parsed.id}${parsed.upstream ? `@${parsed.upstream}` : ""}`;
		const saved =
			this.#settings.getFallbackEffortSelection(target.role, selector) ??
			this.#settings.getFallbackEffortSelection(target.role, canonical);
		const authoredLevel = parsed?.thinkingLevel;
		const options: ConfiguredThinkingLevel[] = [
			ThinkingLevel.Inherit,
			ThinkingLevel.Off,
			AUTO_THINKING,
			...THINKING_EFFORTS,
		];
		const level =
			saved?.mode === "auto"
				? AUTO_THINKING
				: saved?.mode === "fixed"
					? saved.level
					: (authoredLevel ?? ThinkingLevel.Inherit);
		this.#strip = {
			kind: "patternEffort",
			selector: canonical,
			target,
			chips: this.#thinkingChips(options),
			index: Math.max(0, options.indexOf(level)),
			initialSelection: saved,
		};
	}

	#openFallbackChoice(
		item: ModelBrowserItem,
		target: { role: string; index: number | null },
		previous?: string,
	): void {
		const saved = previous ? this.#settings.getFallbackEffortSelection(target.role, previous) : undefined;
		const parsed = previous ? this.#parseFallbackEntry(previous) : undefined;
		const options: ConfiguredThinkingLevel[] = [
			ThinkingLevel.Inherit,
			ThinkingLevel.Off,
			AUTO_THINKING,
			...getSupportedEfforts(item.model),
		];
		const level =
			saved?.mode === "auto"
				? AUTO_THINKING
				: saved?.mode === "fixed"
					? saved.level
					: (parsed?.thinkingLevel ?? ThinkingLevel.Inherit);
		const routed = parsed?.upstream ? `${item.selector}@${parsed.upstream}` : item.selector;
		this.#strip = {
			kind: "thinking",
			item,
			role: target.role,
			fallbackIndex: target.index ?? undefined,
			fallbackTarget: target,
			fallbackSelector: routed,
			chips: this.#thinkingChips(options),
			index: Math.max(0, options.indexOf(level)),
			returnToRoles: true,
			initialSelection: saved?.mode === "auto" && saved.selector && saved.selector !== routed ? undefined : saved,
		};
	}

	#commitFallbackSelection(
		selector: string,
		target: { role: string; index: number | null },
		selection: HubEffortSelection,
	): boolean {
		const chain = [...(this.#fallbackChains()[target.role] ?? [])];
		const index = target.index !== null && target.index < chain.length ? target.index : chain.length;
		if (index === chain.length) chain.push(selector);
		else chain[index] = selector;
		for (let i = chain.length - 1; i >= 0; i--) {
			if (i !== index && chain[i] === selector) chain.splice(i, 1);
		}
		if (this.#callbacks.onFallbackChainChange?.(target.role, chain, { selector, selection }) === false) return false;
		this.#strip = null;
		this.#refreshAfterMutation();
		this.#browser.setQuery("");
		this.#setActiveEntry("roles");
		this.#focus = "list";
		const rowIndex = this.#rolesRows.findIndex(
			row => row.kind === "fallback" && row.role === target.role && row.selector === selector,
		);
		if (rowIndex >= 0) this.#roleIndex = rowIndex;
		return true;
	}

	#closeStrip(): void {
		const strip = this.#strip;
		this.#strip = null;
		this.#configError = undefined;
		this.#frame.chipRanges = [];
		if ((strip?.kind === "scope" || strip?.kind === "thinking") && strip.returnToRoles) {
			this.#setActiveEntry("roles");
			this.#focus = "list";
		}
	}

	#activateStripChip(): void {
		const strip = this.#strip;
		if (!strip || strip.kind === "name" || strip.kind === "pattern" || strip.kind === "effortLevels") return;
		const chip = strip.chips[strip.index];
		if (!chip) return;
		if (strip.kind === "patternEffort") {
			const level = chip.thinkingLevel;
			if (level === undefined) return;
			if (level === AUTO_THINKING) {
				this.#openEffortLevels({
					selector: strip.selector,
					fallbackTarget: strip.target,
					baseSelection: strip.initialSelection,
				});
				return;
			}
			this.#commitFallbackSelection(strip.selector, strip.target, this.#effortSelectionFor(level));
			return;
		}
		if (strip.kind === "selectorChoice") {
			this.#activateSelectorChoice(strip);
			return;
		}
		switch (chip.action) {
			case "assign":
				if (chip.role) {
					this.#strip = null;
					this.#assignRole(strip.item, chip.role, false, chip.scope);
				}
				return;
			case "unassign":
				if (chip.role) {
					this.#callbacks.onUnassign(chip.role, chip.scope);
					this.#refreshAfterMutation();
				}
				this.#closeStrip();
				return;
			case "fallback":
				this.#openFallbackChoice(strip.item, { role: "default", index: null });
				return;
			case "fallbackModel":
				this.#closeStrip();
				this.#startAssignFallback(strip.item.selector, null);
				return;
			case "fallbackProvider":
				this.#closeStrip();
				this.#startAssignFallback(`${strip.item.model.provider}/*`, null);
				return;
			case "scope":
				if (strip.role && chip.scope) {
					this.#strip = null;
					this.#assignRole(strip.item, strip.role, strip.returnToRoles, chip.scope);
				}
				return;
			case "thinking": {
				if (chip.thinkingLevel === undefined) return;
				if (chip.thinkingLevel === AUTO_THINKING) {
					this.#openEffortLevels({
						item: strip.item,
						selector: strip.fallbackSelector,
						role: strip.fallbackTarget ? undefined : strip.role,
						scope: strip.scope,
						fallbackTarget: strip.fallbackTarget,
						baseSelection: strip.initialSelection,
					});
					return;
				}
				const selection = this.#effortSelectionFor(chip.thinkingLevel);
				if (strip.fallbackTarget) {
					this.#commitFallbackSelection(
						strip.fallbackSelector ?? strip.item.selector,
						strip.fallbackTarget,
						selection,
					);
				} else if (strip.role) {
					this.#saveRoleSelection(strip.item, strip.role, strip.scope, selection);
				}
				return;
			}
		}
	}

	/**
	 * Switch the body into assign mode for `role`: full catalog, cleared query, current model preselected.
	 * Arrows land on the model rows (the next step of the flow); ← still reaches the provider scopes.
	 */
	#startAssign(role: string): void {
		this.#assigning = { kind: "role", role };
		this.#focus = "list";
		this.#browser.setShowProvider(true);
		this.#setCandidateItems(this.#availableItems);
		this.#browser.setQuery("");
		const current = this.#roles[role];
		if (current) {
			this.#browser.selectSelector(`${current.model.provider}/${current.model.id}`);
		}
	}

	/** Browse the catalog to fill a fallback-chain slot: `index` replaces an entry, `null` appends. */
	#startAssignFallback(role: string, index: number | null): void {
		this.#assigning = { kind: "fallback", role, index };
		this.#focus = "list";
		this.#browser.setShowProvider(true);
		this.#setCandidateItems(this.#availableItems);
		this.#browser.setQuery("");
		if (index !== null) {
			const selector = this.#fallbackChains()[role]?.[index];
			// Suffixed entries (`provider/id:low`) carry effort the browser rows
			// don't show; match on the base so the current model preselects.
			if (selector) {
				const parsed = this.#parseFallbackEntry(selector);
				this.#browser.selectSelector(parsed ? `${parsed.provider}/${parsed.id}` : selector);
			}
		}
	}

	/** Browse the catalog for the primary model a brand-new fallback chain protects. */
	#startAssignFallbackKey(): void {
		this.#assigning = { kind: "fallbackKey" };
		this.#focus = "list";
		this.#browser.setShowProvider(true);
		this.#setCandidateItems(this.#availableItems);
		this.#browser.setQuery("");
	}

	/** Second step of "+ New fallback…": key the chain by the picked model or its whole provider. */
	#openFallbackKeyStrip(item: ModelBrowserItem): void {
		const chips: StripChip[] = [
			{
				label: `for ${item.selector}`,
				styled: theme.fg("muted", `for ${item.selector}`),
				action: "fallbackModel",
			},
			{
				label: `for ${item.model.provider}/*`,
				styled: theme.fg("muted", `for ${item.model.provider}/*`),
				action: "fallbackProvider",
			},
		];
		this.#strip = { kind: "role", item, chips, index: 0, returnToRoles: false };
	}

	/** Persist `role`'s chain through the host callback and rebuild dependent state. */
	#setFallbackChain(
		role: string,
		chain: string[],
		copiedSelections?: Readonly<Record<string, HubEffortSelection>>,
	): void {
		const applied =
			copiedSelections && Object.keys(copiedSelections).length > 0
				? this.#callbacks.onFallbackChainChange?.(role, chain, undefined, copiedSelections)
				: this.#callbacks.onFallbackChainChange?.(role, chain);
		if (applied !== false) this.#refreshAfterMutation();
	}

	/** Take a snapshot, including the Auto allowlist, before the source can change. */
	#snapshotFallback(role: string, selector: string): { selector: string; selection?: HubEffortSelection } {
		const selection = this.#settings.getFallbackEffortSelection(role, selector);
		return {
			selector,
			selection:
				selection?.mode === "auto"
					? { ...selection, allowed: selection.allowed ? [...selection.allowed] : undefined }
					: selection
						? { ...selection }
						: undefined,
		};
	}

	/** Paste appends missing entries in yank order without replacing existing target metadata. */
	#pasteFallback(role: string): void {
		if (!this.#yankedFallback) return;
		const existing = this.#fallbackChains()[role] ?? [];
		const chain = [...existing];
		const copiedSelections: Record<string, HubEffortSelection> = {};
		for (const { selector, selection } of this.#yankedFallback) {
			if (chain.includes(selector)) continue;
			chain.push(selector);
			if (selection) copiedSelections[selector] = structuredClone(selection);
		}
		if (chain.length !== existing.length) this.#setFallbackChain(role, chain, copiedSelections);
	}

	/** Remove one chain entry; the cursor stays on the nearest surviving row. */
	#removeFallback(row: { role: string; chainIndex: number }): void {
		const chain = [...(this.#fallbackChains()[row.role] ?? [])];
		if (row.chainIndex >= chain.length) return;
		chain.splice(row.chainIndex, 1);
		this.#setFallbackChain(row.role, chain);
		this.#roleIndex = Math.min(this.#roleIndex, Math.max(0, this.#rolesRows.length - 1));
	}

	/** Move a chain entry one slot earlier/later; the cursor follows the moved entry. */
	#moveFallback(row: { role: string; chainIndex: number }, delta: -1 | 1): void {
		const chain = [...(this.#fallbackChains()[row.role] ?? [])];
		const target = row.chainIndex + delta;
		if (row.chainIndex >= chain.length || target < 0 || target >= chain.length) return;
		[chain[row.chainIndex], chain[target]] = [chain[target], chain[row.chainIndex]];
		this.#setFallbackChain(row.role, chain);
		this.#roleIndex += delta;
	}

	#cancelAssign(): void {
		const destination = this.#assigning?.kind === "effortRule" ? "effort" : "roles";
		this.#assigning = null;
		this.#browser.setQuery("");
		this.#setActiveEntry(destination);
		this.#focus = "list";
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Quick-switch cycle (ctrl+p) editing
	// ═══════════════════════════════════════════════════════════════════════

	#cycleOrder(): string[] {
		try {
			return [...this.#settings.cycleOrder];
		} catch {
			return [];
		}
	}

	/** Toggle `role`'s membership in the quick-switch cycle (appended at the end). */
	#toggleCycleMembership(role: string): void {
		const order = this.#cycleOrder();
		const index = order.indexOf(role);
		if (index >= 0) {
			order.splice(index, 1);
		} else {
			order.push(role);
		}
		this.#callbacks.onCycleOrderChange?.(order);
		this.#refreshAfterMutation();
	}

	/** Move `role` one slot earlier/later within the cycle order. */
	#moveCycleMembership(role: string, delta: -1 | 1): void {
		const order = this.#cycleOrder();
		const index = order.indexOf(role);
		const target = index + delta;
		if (index < 0 || target < 0 || target >= order.length) return;
		[order[index], order[target]] = [order[target], order[index]];
		this.#callbacks.onCycleOrderChange?.(order);
		this.#refreshAfterMutation();
	}

	/** Open the footer name input: a new custom role, or saving the current setup as a model preset. */
	#openNameStrip(purpose: "role" | "preset"): void {
		const input = new Input();
		input.focused = true;
		this.#strip = { kind: "name", purpose, input };
	}

	#openDescriptionStrip(role: string): void {
		if (!this.#callbacks.onRoleDescriptionChange) return;
		const input = new Input();
		input.focused = true;
		input.setValue(this.#settings.getRoleInfo(role).description ?? "");
		this.#strip = { kind: "name", purpose: "description", role, input };
	}

	#openRoleBudgetStrip(role: string): void {
		if (!this.#callbacks.onRoleTokenBudgetChange) return;
		const input = new Input();
		input.focused = true;
		const value = this.#settings.getRoleTokenBudget?.(role);
		input.setValue(value === undefined ? "" : String(value));
		this.#strip = { kind: "name", purpose: "roleBudget", role, input };
	}

	/** The model a Roles row resolves to (assigned role or fallback), whose compaction point `m` edits. */
	#roleRowModel(): Model | undefined {
		const row = this.#rolesRows[this.#roleIndex];
		if (row?.kind === "role") return this.#roles[row.role]?.model;
		if (row?.kind === "fallback") return this.#resolveFallbackEntry(row.role, row.chainIndex)?.item.model;
		return undefined;
	}

	/** Open the footer input for the Roles row's model compaction point, prefilled with its own entry. */
	#openCompactionStrip(): void {
		if (!this.#callbacks.onCompactionPointChange) return;
		const model = this.#roleRowModel();
		if (!model) return;
		const input = new Input();
		input.focused = true;
		input.setValue(this.#settings.compactionPointFor?.(model)?.draft ?? "");
		this.#strip = { kind: "name", purpose: "compaction", model, input };
	}

	/** Validate and commit the name strip: a new role, a preset name, or a compaction point. */
	#submitNameStrip(): void {
		const strip = this.#strip;
		if (strip?.kind !== "name") return;
		if (strip.purpose === "contextRule") {
			const rules = [...(this.#settings.contextRules ?? [])].filter(rule => rule.selector !== strip.selector);
			const value = strip.input.getValue().trim();
			if (value) rules.push({ selector: strip.selector, limit: value });
			// Keep existing pattern order when editing a rule.
			const previous = this.#settings.contextRules?.findIndex(rule => rule.selector === strip.selector) ?? -1;
			if (value && previous >= 0) rules.splice(previous, 0, rules.pop()!);
			if (this.#callbacks.onContextRulesChange?.(rules) === false) return;
			this.#effortIndex = value
				? rules.findIndex(rule => rule.selector === strip.selector)
				: Math.min(this.#effortIndex, rules.length);
			this.#strip = null;
			this.#assigning = null;
			this.#frame.chipRanges = [];
			this.#refreshAfterMutation();
			return;
		}
		if (strip.purpose === "roleBudget") {
			const draft = strip.input.getValue().trim();
			const value = draft === "" ? undefined : Number(draft);
			if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
				this.#configError = "Role token budget must be a positive integer; empty inherits.";
				return;
			}
			if (this.#callbacks.onRoleTokenBudgetChange?.(strip.role, value) === false) return;
			this.#configError = undefined;
			this.#strip = null;
			this.#frame.chipRanges = [];
			this.#refreshAfterMutation();
			return;
		}
		if (strip.purpose === "description") {
			if (this.#callbacks.onRoleDescriptionChange?.(strip.role, strip.input.getValue().trim()) === false) return;
			this.#strip = null;
			this.#frame.chipRanges = [];
			this.#refreshAfterMutation();
			return;
		}
		if (strip.purpose === "compaction") {
			const value = strip.input.getValue();
			const result = this.#callbacks.onCompactionPointChange?.(strip.model, value, compactionConfirmPending(strip));
			if (result?.kind === "error") {
				strip.error = result.message;
				strip.confirm = undefined;
				return;
			}
			if (result?.kind === "confirm") {
				strip.error = undefined;
				strip.confirm = { value, message: result.message };
				return;
			}
			this.#strip = null;
			this.#frame.chipRanges = [];
			this.#refreshAfterMutation();
			return;
		}
		if (strip.purpose === "preset") {
			this.#submitPresetName();
			return;
		}
		this.#submitRoleName();
	}

	/** Validate and commit the new-role name: jump straight into assigning it. */
	#submitRoleName(): void {
		const strip = this.#strip;
		if (strip?.kind !== "name" || strip.purpose !== "role") return;
		const name = strip.input.getValue().trim();
		if (!/^[a-zA-Z][\w-]*$/.test(name)) return;
		if (this.#visibleRoleIds().includes(name)) return;
		this.#strip = null;
		this.#frame.chipRanges = [];
		this.#startAssign(name);
	}

	/** Validate and commit the preset name: save the current setup under it (overwrites). */
	#submitPresetName(): void {
		const strip = this.#strip;
		if (strip?.kind !== "name" || strip.purpose !== "preset") return;
		const name = strip.input.getValue().trim();
		if (!/^[a-zA-Z][\w-]*$/.test(name)) return;
		this.#strip = null;
		this.#frame.chipRanges = [];
		this.#callbacks.onSavePreset?.(name);
		this.#refreshAfterMutation();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Input
	// ═══════════════════════════════════════════════════════════════════════

	#moveModelKind(delta: -1 | 1): void {
		const current = MODEL_KIND_TABS.indexOf(this.#modelKindTab);
		const next = (Math.max(0, current) + delta + MODEL_KIND_TABS.length) % MODEL_KIND_TABS.length;
		this.#modelKindTab = MODEL_KIND_TABS[next] ?? "all";
		this.#applyModelKind();
	}

	#moveRoleTab(delta: -1 | 1): void {
		const current = ROLE_TABS.indexOf(this.#roleTab);
		const next = (Math.max(0, current) + delta + ROLE_TABS.length) % ROLE_TABS.length;
		this.#roleTab = ROLE_TABS[next] ?? "all";
		this.#roleIndex = 0;
		this.#roleViewport.setTop(0);
		this.#buildRolesRows();
	}

	/** Saved presets and the one the setup matches; empty unless the host can both list and switch. */
	#presets(): { names: readonly string[]; active: string | undefined } {
		if (!this.#callbacks.onSwitchPreset || !this.#settings.getModelPresets) return { names: [], active: undefined };
		const revision = this.#settings.revision;
		if (this.#presetsMemo?.revision !== revision) {
			const { names, active } = this.#settings.getModelPresets();
			this.#presetsMemo = { revision, names, active };
		}
		return this.#presetsMemo;
	}

	/**
	 * The preset ctrl+←/→ steps from: the last one tried here while settings are
	 * unchanged since (a refused switch writes nothing, so the next press moves
	 * past it) or nothing matches; otherwise the preset the setup matches.
	 */
	#presetBase(active: string | undefined): string | undefined {
		const cursor = this.#presetCursor;
		if (cursor && (active === undefined || cursor.revision === this.#settings.revision)) return cursor.name;
		return active;
	}

	/** Apply the previous/next saved preset (wrapping), as `/modelpreset switch` does. */
	#switchPreset(delta: -1 | 1): void {
		const onSwitchPreset = this.#callbacks.onSwitchPreset;
		const { names, active } = this.#presets();
		if (!onSwitchPreset || names.length === 0) return;
		const base = this.#presetBase(active);
		const current = base === undefined ? -1 : names.indexOf(base);
		const next = current < 0 ? (delta > 0 ? 0 : names.length - 1) : (current + delta + names.length) % names.length;
		const name = names[next];
		if (name === undefined) return;
		const settle = () => {
			this.#presetCursor = { name, revision: this.#settings.revision };
			this.#refreshAfterMutation();
		};
		// Stepping onto the preset already in effect has nothing to apply.
		if (name === active) {
			settle();
			return;
		}
		// The host reports refusals itself, so the cursor moves once the switch
		// resolves, refused or not (`#presetBase` sees a refusal left the revision alone).
		this.#finishAssignment(onSwitchPreset(name), settle);
	}

	handleInput(rawData: string): void {
		if (rawData.startsWith("\x1b[<")) {
			this.#nativeVersion++;
			routeSgrMouseInput(rawData, event => {
				if (!event.leftClick) return this.#routeMouseEvent(event);
				let handled: boolean | undefined;
				this.#withNavigationVisit(() => {
					handled = this.#routeMouseEvent(event);
				});
				return handled;
			});
			return;
		}
		const strip = this.#strip;
		const fieldFocused =
			this.#filterEditing || ((strip?.kind === "name" || strip?.kind === "pattern") && strip.input.focused);
		if (this.#filterEditing || (fieldFocused && extractPrintableText(rawData) !== undefined)) {
			this.#handleInput(rawData);
			return;
		}
		const overridesEditing =
			this.#activeEntry().kind === "overrides" && this.#assigning === null && this.#overrides().editing;
		if (!fieldFocused && !overridesEditing && this.#help.handleInput(rawData)) {
			this.#requestRender();
			return;
		}
		this.#withNavigationVisit(() => this.#handleInput(rawData));
	}

	#handleInput(rawData: string): void {
		this.#nativeVersion++;
		if (
			!this.#sessionOnly &&
			matchesKey(rawData, "ctrl+g") &&
			!this.#keys.read(rawData) &&
			this.#callbacks.onOpenConfigFile
		) {
			if (!this.#externalEditPending && !this.#assignmentPending) {
				const entry = this.#activeEntry();
				const editingCompaction = this.#strip?.kind === "name" && this.#strip.purpose === "compaction";
				const section = editingCompaction
					? "context"
					: entry.kind === "roles"
						? "roles"
						: entry.kind === "effort"
							? entry.id === "context"
								? "context"
								: "effort"
							: "overrides";
				const row = this.#rolesRows[this.#roleIndex];
				const source =
					section === "roles" &&
					this.#strip?.kind !== "name" &&
					this.#settings.modelRoleStorage === "project" &&
					row?.kind === "role"
						? this.#settings.getModelRoleSource(row.role)
						: "global";
				const scope = source === "project" ? "project" : "global";
				this.#externalEditPending = true;
				void this.#callbacks.onOpenConfigFile(section, scope).finally(() => {
					this.#externalEditPending = false;
					this.#refreshAfterMutation();
					this.#tui.requestRender();
				});
			}
			return;
		}
		if (this.#assignmentPending) {
			if (matchesSelectCancel(rawData)) this.#callbacks.onCancel();
			return;
		}

		if (this.#strip) {
			this.#handleStripInput(rawData);
			return;
		}
		if (this.#activeEntry().kind === "overrides" && this.#assigning === null) {
			const panel = this.#overrides();
			if (this.#focus === "list" || panel.editing) {
				if (!panel.editing && (matchesKey(rawData, "tab") || matchesKey(rawData, "left") || rawData === "h")) {
					this.#focus = "scope";
				} else panel.handleInput(rawData);
				return;
			}
			if (
				matchesKey(rawData, "enter") ||
				matchesKey(rawData, "right") ||
				matchesKey(rawData, "tab") ||
				rawData === "l"
			) {
				this.#focus = "list";
				return;
			}
		}
		const rolesSearching = this.#activeEntry().kind === "roles" && this.#assigning === null;
		const effortSearching = this.#activeEntry().kind === "effort" && this.#assigning === null;
		if (this.#filterEditing) {
			// Shared field ownership keeps literal text and editing keys out of navigation.
			if (!rolesSearching && !effortSearching) {
				this.#browser.handleInput(rawData);
				if (!this.#browser.filterFocused) this.#keys.reset();
				return;
			}
			const search = rolesSearching ? this.#rolesSearch : this.#effortSearch;
			const before = search.query;
			search.handleInput(rawData);
			if (before !== search.query) {
				if (rolesSearching) {
					this.#roleIndex = 0;
					this.#roleViewport.setTop(0);
					this.#buildRolesRows();
				} else {
					this.#effortIndex = -1;
					this.#effortViewport.setTop(0);
					this.#syncEffortSelection();
				}
			}
			this.#keys.reset();
			return;
		}
		const data = rawData;
		const action = this.#keys.read(data);
		if (action === "pending") return;
		if (action?.kind === "cancel") {
			this.#cancel();
			return;
		}

		const entry = this.#activeEntry();
		const rolesView = entry.kind === "roles" && this.#assigning === null;
		const effortView = entry.kind === "effort" && this.#assigning === null;
		const lockedView = entry.kind === "provider" && entry.locked && this.#assigning === null;

		if (action?.kind === "search") {
			if (rolesView || effortView || this.#isBrowserView(entry)) {
				this.#filterEditing = true;
				this.#focus = "list";
				this.#keys.reset();
				if (!rolesView && !effortView) this.#browser.focusFilter();
			}
			return;
		}
		if (action?.kind === "context") {
			this.#focus = this.#focus === "scope" ? "list" : "scope";
			return;
		}
		if (matchesKey(data, "f5")) {
			if (
				entry.kind === "provider" &&
				!entry.locked &&
				!this.#pinnedProviders.some(provider => provider.id === entry.providerId)
			) {
				this.#scheduleProviderRefresh(entry.providerId ?? "", { force: true });
			}
			return;
		}
		if (matchesKey(data, "f6")) {
			this.#editFacts();
			return;
		}
		// Ctrl+←/→ in the Roles view steps through saved model presets, wrapping.
		if (rolesView && (matchesKey(data, "ctrl+left") || matchesKey(data, "ctrl+right"))) {
			this.#switchPreset(matchesKey(data, "ctrl+left") ? -1 : 1);
			return;
		}
		// Alt+←/→ cycles whichever tab strip is on screen: role tabs in the
		// Roles view, kind tabs in every browser view. Ctrl+←/→ is unusable on
		// macOS (Spaces shortcut). macOS terminals (ghostty, Terminal.app,
		// iTerm) send ESC b / ESC f for Option+←/→, which parse as alt+b /
		// alt+f — the same aliases the editor's word-motion bindings accept.
		if (matchesKey(data, "alt+left") || matchesKey(data, "alt+b")) {
			if (rolesView) this.#moveRoleTab(-1);
			else this.#moveModelKind(-1);
			return;
		}
		if (matchesKey(data, "alt+right") || matchesKey(data, "alt+f")) {
			if (rolesView) this.#moveRoleTab(1);
			else this.#moveModelKind(1);
			return;
		}

		if (action?.kind === "horizontal") {
			if (action.delta < 0) this.#focus = "scope";
			else if (rolesView || effortView || this.#isBrowserView(entry)) this.#focus = "list";
			return;
		}
		if (action && (this.#focus === "scope" || rolesView || effortView) && this.#applyPanelMotion(action)) return;

		if (rolesView) {
			if (action?.kind === "confirm" || action?.kind === "toggle") {
				if (this.#focus === "scope") this.#focus = "list";
				else {
					this.#filterEditing = false;
					this.#runRolesAction("pick");
				}
				return;
			}
			this.#handleRolesViewInput(data);
			return;
		}
		if (effortView) {
			this.#handleEffortRulesInput(action?.kind === "toggle" ? "\r" : data);
			return;
		}
		if (lockedView) {
			// Locked provider scopes have no model rows until credentials are supplied.
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				this.#requestLogin(entry);
			}
			return;
		}

		const pinned =
			entry.kind === "provider" && this.#assigning === null
				? this.#pinnedProviders.find(provider => provider.id === entry.providerId)
				: undefined;
		if (pinned && this.#focus === "list") {
			if (data === "e" && !this.#pinnedActionFocused) {
				const selected = this.#browser.getSelected();
				if (selected) this.#callbacks.onDefineMixture?.(selected.model.id);
				return;
			}
			if (action?.kind === "confirm" || action?.kind === "toggle") {
				if (this.#pinnedActionFocused) {
					pinned.action.onSelect();
					return;
				}
			}
			if (action?.kind === "move" && action.delta > 0) {
				if (!this.#pinnedActionFocused) {
					const selected = this.#browser.getSelected();
					this.#browser.moveSelection(1, { wrap: false });
					if (!selected || selected === this.#browser.getSelected()) this.#pinnedActionFocused = true;
				}
				return;
			}
			if (action?.kind === "move" && action.delta < 0 && this.#pinnedActionFocused) {
				this.#pinnedActionFocused = false;
				return;
			}
			if (this.#pinnedActionFocused && extractPrintableText(data) !== undefined) {
				this.#pinnedActionFocused = false;
			}
		}

		// Enter on the sidebar is a pane switch, like →: it lands on the model
		// rows instead of acting on a row the user cannot see is selected.
		if (this.#focus === "scope" && (action?.kind === "confirm" || action?.kind === "toggle")) {
			this.#focus = "list";
			if (pinned && !this.#browser.getSelected()) this.#pinnedActionFocused = true;
			return;
		}

		if (action) this.#browser.handleNavigation(action);
	}

	#editFacts(): void {
		if (this.#sessionOnly || this.#strip || this.#filterEditing || this.#assigning !== null) return;
		const entry = this.#activeEntry();
		const model =
			entry.kind === "roles"
				? this.#roleRowModel()
				: this.#focus === "list"
					? this.#browser.getSelected()?.model
					: undefined;
		this.#callbacks.onEditFacts?.(model?.provider ?? entry.providerId, model);
	}

	#applyPanelMotion(action: MenuNavAction): boolean {
		const budget = Math.max(1, (this.#tui.terminal?.rows ?? 30) - 10);
		if (this.#focus === "scope") {
			const rows = this.#sidebarVisibleCount || budget;
			this.#scopeSelection.setItems(this.#entries, this.#activeEntryId);
			this.#scopeViewport.setTop(this.#frame.sidebarScroll);
			this.#scopeViewport.layout(
				this.#entries.map(() => 1),
				this.#scopeSelection.selectedIndex,
				rows,
			);
			const motion = applyMenuMotion(action, this.#scopeSelection, this.#scopeViewport);
			if (!motion.handled) return false;
			if (motion.selectionChanged) {
				const entry = this.#scopeSelection.selectedItem;
				if (entry) {
					if (entry.kind === "roles") this.#assigning = null;
					this.#setActiveEntry(entry.id);
				}
			}
			const window = this.#scopeViewport.layout(
				this.#entries.map(() => 1),
				this.#scopeSelection.selectedIndex,
				rows,
			);
			this.#frame.sidebarScroll = window.startIndex;
			this.#sidebarFollowActive = false;
			return true;
		}
		if (this.#activeEntry().kind === "roles") {
			this.#roleSelection.setItems(this.#rolesRows);
			this.#roleSelection.setSelectedIndex(this.#roleIndex);
			this.#roleViewport.layout(
				this.#rolesRows.map(() => 1),
				this.#roleIndex,
				this.#rolesVisibleCount || budget,
			);
			const motion = applyMenuMotion(action, this.#roleSelection, this.#roleViewport);
			if (!motion.handled) return false;
			this.#roleIndex = this.#roleSelection.selectedIndex;
			this.#roleLastIndex = this.#roleIndex;
			return true;
		}
		const indices = this.#syncEffortSelection();
		this.#effortViewport.layout(
			indices.map(() => 1),
			this.#effortSelection.selectedIndex,
			this.#effortVisibleCount || budget,
		);
		const motion = applyMenuMotion(action, this.#effortSelection, this.#effortViewport);
		if (!motion.handled) return false;
		this.#effortIndex = this.#effortSelection.selectedItem ?? -1;
		this.#effortLastIndex = this.#effortIndex;
		return true;
	}

	/** Esc leaves the focused field, then a nested strip/assignment, then the hub. */
	#cancel(): void {
		if (this.#assignmentPending) {
			this.#callbacks.onCancel();
			return;
		}
		if (this.#filterEditing) {
			this.#handleInput("\x1b");
			return;
		}
		if (!this.#strip) {
			const kind = this.#assigning === null ? this.#activeEntry().kind : undefined;
			const search = kind === "roles" ? this.#rolesSearch : kind === "effort" ? this.#effortSearch : undefined;
			if (search?.query) {
				search.setValue("");
				search.focused = false;
				if (kind === "roles") this.#buildRolesRows();
				else this.#syncEffortSelection();
				return;
			}
			if (!search && this.#browser.query) {
				this.#browser.setQuery("");
				this.#browser.focusFilter(false);
				this.#onQueryChanged("");
				return;
			}
		}
		const strip = this.#strip;
		if ((strip?.kind === "name" || strip?.kind === "pattern") && strip.input.focused) {
			strip.input.focused = false;
			return;
		}
		if ((this.#strip || this.#assigning) && this.#returnToParent()) return;
		if (this.#strip) {
			this.#closeStrip();
			return;
		}
		if (this.#assigning !== null) {
			this.#cancelAssign();
			return;
		}
		this.#callbacks.onCancel();
	}

	#isBrowserView(entry: SidebarEntry): boolean {
		if (this.#assigning !== null) return true;
		return entry.kind === "recent" || entry.kind === "all" || (entry.kind === "provider" && !entry.locked);
	}

	#handleStripInput(data: string): void {
		const strip = this.#strip;
		if (!strip) return;
		const textInput = strip.kind === "name" || strip.kind === "pattern" ? strip.input : undefined;
		const textFocused = textInput?.focused === true;
		const printable = textFocused ? extractPrintableText(data) : undefined;
		const cancel = matchesSelectCancel(data) || (textInput !== undefined && matchesKey(data, "escape"));
		if (cancel && (!textFocused || printable === undefined)) {
			this.#cancel();
			return;
		}
		if (strip.kind === "name" || strip.kind === "pattern") {
			if (!strip.input.focused) {
				const action = this.#keys.read(data);
				if (!action || action === "pending") return;
				if (action.kind === "search") {
					strip.input.focused = true;
					this.#keys.reset();
				} else if (action.kind === "confirm") {
					if (strip.kind === "name") this.#submitNameStrip();
					else this.#submitSelectorPattern(strip);
				} else if (action.kind === "horizontal" || action.kind === "context") {
					const focus =
						action.kind === "horizontal"
							? action.delta < 0
								? "scope"
								: "list"
							: this.#focus === "scope"
								? "list"
								: "scope";
					this.#closeStrip();
					this.#focus = focus;
				}
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				if (strip.kind === "name") this.#submitNameStrip();
				else this.#submitSelectorPattern(strip);
				return;
			}
			if (printable !== undefined) strip.input.insertText(printable);
			else strip.input.handleInput(data);
			if (strip.kind === "name" && strip.purpose === "compaction") strip.error = undefined;
			return;
		}
		const action = this.#keys.read(data);
		if (!action || action === "pending") return;
		const effort = strip.kind === "effortLevels" || strip.kind === "thinking" || strip.kind === "patternEffort";
		if (action.kind === "context" || (action.kind === "horizontal" && !effort)) {
			const focus =
				action.kind === "horizontal"
					? action.delta < 0
						? "scope"
						: "list"
					: this.#focus === "scope"
						? "list"
						: "scope";
			this.#closeStrip();
			this.#focus = focus;
			return;
		}
		const count = strip.kind === "effortLevels" ? strip.toggle.options.length : strip.chips.length;
		if (count === 0) return;
		if (action.kind === "move" || (action.kind === "horizontal" && effort)) {
			strip.index = Math.max(0, Math.min(count - 1, strip.index + action.delta));
			return;
		}
		if (action.kind === "boundary") {
			strip.index = action.edge === "first" ? 0 : count - 1;
			return;
		}
		if (action.kind === "halfPage" || action.kind === "page") {
			const step = action.kind === "page" ? count : Math.max(1, Math.floor(count / 2));
			strip.index = Math.max(0, Math.min(count - 1, strip.index + step * action.delta));
			return;
		}
		if (strip.kind === "effortLevels") {
			if (action.kind === "toggle") {
				const level = strip.toggle.options[strip.index];
				if (level) strip.toggle.toggle(level);
				this.#configError = undefined;
			} else if (action.kind === "confirm") this.#confirmEffortLevels(strip);
			return;
		}
		if (action.kind === "confirm" || (action.kind === "toggle" && strip.chips[strip.index]?.action !== "unassign")) {
			if (strip.kind === "selectorChoice") this.#activateSelectorChoice(strip);
			else this.#activateStripChip();
		}
	}

	/** Row count of the roles view (roles, their fallback entries, and the trailing "+ New role…" row). */
	get #rolesRowCount(): number {
		return this.#rolesRows.length;
	}

	/** Enter/click activation for a Roles-view row. */
	#activateRolesRow(row: RolesRow): void {
		switch (row.kind) {
			case "role":
				this.#openRoleSelectorChoice(row.role);
				return;
			case "chainKey":
				this.#openSelectorPattern("fallbackKey", undefined, row.role);
				return;
			case "fallback":
				this.#openFallbackSelectorChoice(row.role, row.chainIndex);
				return;
			case "newFallback":
				this.#openFallbackKeySelectorChoice();
				return;
			case "newRole":
				this.#openNameStrip("role");
				return;
			case "separator":
				return;
		}
	}

	/** Step the roles cursor by one row, skipping separator rows. Wraps at the ends unless `wrap: false` (then the cursor stays put). */
	#stepRoleIndex(from: number, delta: -1 | 1, options: { wrap?: boolean } = {}): number {
		const wrap = options.wrap ?? true;
		const count = this.#rolesRows.length;
		if (count === 0) return 0;
		let index = from;
		for (let i = 0; i < count; i++) {
			const next = index + delta;
			if (next < 0 || next >= count) {
				if (!wrap) return from;
				index = (next + count) % count;
			} else {
				index = next;
			}
			if (this.#rolesRows[index]?.kind !== "separator") return index;
		}
		return from;
	}

	#handleRolesViewInput(data: string): void {
		if (this.#focus === "scope") return;
		if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
			this.#runRolesAction("clear");
			return;
		}
		// Reordering: [ / shift+↑ moves the row earlier, ] / shift+↓ later —
		// cycle order on a role row, chain order on a fallback row.
		if (matchesKey(data, "shift+up")) {
			this.#runRolesAction("earlier");
			return;
		}
		if (matchesKey(data, "shift+down")) {
			this.#runRolesAction("later");
			return;
		}
		const row = this.#rolesRows[this.#roleIndex];
		const printable = extractPrintableText(data);
		if (printable === "y") {
			if (row?.kind === "role") {
				const model = this.#roles[row.role]?.model;
				if (model) {
					const selector = this.#settings.formatModelSelector(model);
					const saved = this.#settings.getRoleEffortSelection(row.role);
					const modelSelector = `${model.provider}/${model.id}`;
					let selection =
						saved?.mode === "auto" &&
						saved.selector &&
						saved.selector !== modelSelector &&
						saved.selector !== selector
							? undefined
							: saved;
					if (!selection) {
						const resolved = this.#settings.resolveRoleValue(this.#settings.getModelRole(row.role), [model]);
						if (resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined) {
							selection =
								resolved.thinkingLevel === AUTO_THINKING
									? { mode: "auto" }
									: this.#effortSelectionFor(resolved.thinkingLevel);
						}
					}
					this.#yankedFallback = [
						{
							selector,
							selection:
								selection?.mode === "auto"
									? { ...selection, allowed: selection.allowed ? [...selection.allowed] : undefined }
									: selection
										? { ...selection }
										: undefined,
						},
						...(this.#fallbackChains()[row.role] ?? []).map(entry => this.#snapshotFallback(row.role, entry)),
					];
				}
			} else if (row?.kind === "fallback") {
				this.#yankedFallback = [this.#snapshotFallback(row.role, row.selector)];
			}
			return;
		}
		if (printable === "Y") {
			if (row?.kind === "fallback") {
				this.#yankedFallback = (this.#fallbackChains()[row.role] ?? []).map(selector =>
					this.#snapshotFallback(row.role, selector),
				);
			}
			return;
		}
		if (printable === "p") {
			if (row?.kind === "role" || row?.kind === "fallback" || row?.kind === "chainKey") {
				this.#pasteFallback(row.role);
			}
			return;
		}
		if (printable !== undefined && Object.hasOwn(ROLES_ACTION_KEYS, printable)) {
			this.#runRolesAction(ROLES_ACTION_KEYS[printable]!);
		}
	}

	/** One Roles-view command on the selected row (keys and action-bar buttons share it). */
	#runRolesAction(action: RolesAction): void {
		const row = this.#rolesRows[this.#roleIndex];
		const role = row?.kind === "role" ? row.role : undefined;
		switch (action) {
			case "pick":
				if (row) this.#activateRolesRow(row);
				return;
			case "description":
				if (role) this.#openDescriptionStrip(role);
				return;
			case "budget":
				if (role) this.#openRoleBudgetStrip(role);
				return;
			case "clear":
				if (role) this.#unassignRole(role);
				else if (row?.kind === "fallback") this.#removeFallback(row);
				else if (row?.kind === "chainKey") this.#setFallbackChain(row.role, []);
				return;
			case "fallback":
				if (row?.kind === "newFallback") this.#openFallbackKeySelectorChoice();
				else if (row && row.kind !== "newRole" && row.kind !== "separator") {
					this.#openFallbackSelectorChoice(row.role, null);
				}
				return;
			case "cycle":
				if (role) this.#toggleCycleMembership(role);
				return;
			case "earlier":
			case "later": {
				const delta = action === "earlier" ? -1 : 1;
				if (role) this.#moveCycleMembership(role, delta);
				else if (row?.kind === "fallback") this.#moveFallback(row, delta);
				return;
			}
			case "new":
				this.#openNameStrip("role");
				return;
			case "save":
				if (this.#callbacks.onSavePreset) this.#openNameStrip("preset");
				return;
			case "nextPreset":
			case "prevPreset":
				this.#switchPreset(action === "nextPreset" ? 1 : -1);
				return;
			case "compaction":
				this.#openCompactionStrip();
				return;
			case "thinking":
				if (role) {
					const target = this.#roleThinkingTarget(role);
					if (target) this.#openThinkingStrip(target.item, role, true, target.scope);
				} else if (row?.kind === "fallback") {
					this.#openFallbackThinkingStrip(row);
				}
				return;
		}
	}

	#requestLogin(entry: SidebarEntry): void {
		if (!entry.providerId) return;
		if (entry.oauth) {
			this.#callbacks.onLoginRequest?.(entry.providerId);
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Mouse
	// ═══════════════════════════════════════════════════════════════════════

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		if (this.#assignmentPending) return true;
		const { footerColumn, bodyHeight, contentLine, overSidebar, overBody, bodyLine } = this.#frame.locate(
			event.row,
			event.col,
		);
		const entry = this.#activeEntry();
		if (overBody && entry.kind === "overrides" && this.#assigning === null) {
			if (event.leftClick) this.#focus = "list";
			this.#overrides().routeMouse(event, bodyLine - 1, event.col);
			return true;
		}

		// Footer strip chips (columns stay in frame coordinates).
		if (footerColumn !== undefined && this.#strip) {
			const strip = this.#strip;
			if (event.leftClick && strip.kind === "effortLevels") {
				const hit = this.#frame.chipRanges.find(range => footerColumn >= range.start && footerColumn < range.end);
				if (hit) {
					strip.index = hit.index;
					const level = strip.toggle.options[hit.index];
					if (level) strip.toggle.toggle(level);
					this.#configError = undefined;
				}
			} else if (
				event.leftClick &&
				strip.kind !== "effortLevels" &&
				strip.kind !== "name" &&
				strip.kind !== "pattern" &&
				this.#frame.selectChipAt(strip, footerColumn)
			) {
				if (strip.kind === "selectorChoice") this.#activateSelectorChoice(strip);
				else this.#activateStripChip();
			}
			return true;
		}

		if (event.wheel !== null) {
			if (overSidebar) {
				// Wheel pans the sidebar viewport; picking a scope is click/keys only.
				this.#frame.scrollSidebar(event.wheel, bodyHeight, this.#entries.length);
				this.#sidebarHover = this.#sidebarEntryIndexAt(contentLine);
			} else if (overBody) {
				if (entry.kind === "roles" && this.#assigning === null) {
					this.#roleIndex = this.#stepRoleIndex(this.#roleIndex, event.wheel > 0 ? 1 : -1, { wrap: false });
				} else if (entry.kind === "effort" && this.#assigning === null) {
					this.#syncEffortSelection();
					this.#effortSelection.move(event.wheel > 0 ? 1 : -1);
					this.#effortIndex = this.#effortSelection.selectedItem ?? -1;
					this.#effortViewport.reveal();
				} else if (this.#isBrowserView(entry) && bodyLine > 0) {
					this.#browser.routeMouse(event, bodyLine - 1);
				}
			}
			return true;
		}

		if (event.motion) {
			this.#sidebarHover = overSidebar ? this.#sidebarEntryIndexAt(contentLine) : null;
			if (overBody && entry.kind === "roles" && this.#assigning === null) {
				const roleLine = bodyLine - this.#rolesRowStart;
				this.#roleHover =
					roleLine >= 0 && roleLine < this.#rolesVisibleCount ? roleLine + this.#roleScrollStart : null;
			} else {
				this.#roleHover = null;
				if (overBody && this.#isBrowserView(entry) && bodyLine > 0) {
					this.#browser.routeMouse(event, bodyLine - 1);
				} else {
					// Pointer left the browser pane: without this, the last
					// hovered row keeps its band while the sidebar hovers too.
					this.#browser.clearHover();
				}
			}
			return true;
		}

		if (!event.leftClick) return true;

		if (overSidebar) {
			const index = this.#sidebarEntryIndexAt(contentLine);
			this.#clickSidebarEntry(index !== null ? this.#entries[index] : undefined);
			return true;
		}

		if (overBody) {
			if (entry.kind === "roles" && this.#assigning === null) {
				this.#focus = "list";
				const listLine = bodyLine - this.#rolesRowStart;
				if (listLine >= 0 && listLine < this.#rolesVisibleCount) {
					const roleLine = listLine + this.#roleScrollStart;
					const rowDef = this.#rolesRows[roleLine];
					if (rowDef && rowDef.kind !== "separator") {
						if (roleLine === this.#roleIndex) {
							this.#activateRolesRow(rowDef);
						} else {
							this.#roleIndex = roleLine;
						}
					}
				}
			} else if (entry.kind === "effort" && this.#assigning === null) {
				this.#focus = "list";
				const indices = this.#syncEffortSelection();
				const index = indices[bodyLine - this.#ruleHeaderRows + this.#effortScrollStart];
				if (index !== undefined) {
					if (this.#effortIndex === index) this.#handleEffortRulesInput("\r");
					else this.#effortIndex = index;
				}
			} else if (entry.kind === "provider" && entry.locked && this.#assigning === null) {
				if (this.#lockedLoginLine !== null && bodyLine === this.#lockedLoginLine) {
					this.#requestLogin(entry);
				}
			} else if (this.#isBrowserView(entry) && bodyLine > 0) {
				const pinned =
					entry.kind === "provider" && this.#assigning === null
						? this.#pinnedProviders.find(provider => provider.id === entry.providerId)
						: undefined;
				if (pinned && bodyLine === this.#pinnedActionLine && event.leftClick) {
					if (this.#pinnedActionFocused && this.#focus === "list") pinned.action.onSelect();
					else {
						this.#focus = "list";
						this.#pinnedActionFocused = true;
					}
				} else {
					this.#pinnedActionFocused = false;
					this.#browser.routeMouse(event, bodyLine - 1);
				}
			}
		}
		return true;
	}

	/** Pointer activation of a sidebar entry: pick the scope; a second click on a locked provider logs in. */
	#clickSidebarEntry(clicked: SidebarEntry | undefined): void {
		if (!clicked || clicked.kind === "separator") return;
		this.#filterEditing = false;
		if (this.#strip) this.#closeStrip();
		const already = clicked.id === this.#activeEntryId;
		if (clicked.kind === "roles" || clicked.kind === "effort" || clicked.kind === "overrides") this.#assigning = null;
		this.#setActiveEntry(clicked.id);
		// A click on settings deliberately dives into its rows.
		if (clicked.kind === "roles" || clicked.kind === "effort" || clicked.kind === "overrides") this.#focus = "list";
		if (already && clicked.kind === "provider" && clicked.locked) {
			this.#requestLogin(clicked);
		}
	}

	/** Map a content-line index to a sidebar entry index (accounting for scroll). */
	#sidebarEntryIndexAt(contentLine: number): number | null {
		const index = this.#frame.sidebarScroll + contentLine;
		if (index < 0 || index >= this.#entries.length) return null;
		return index;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════════

	#renderSidebar(width: number, rows: number): string[] {
		this.#sidebarVisibleCount = rows;
		const lines = this.#frame.renderSidebar(
			this.#entries,
			width,
			rows,
			{ id: this.#activeEntryId, focused: this.#focus === "scope", follow: this.#sidebarFollowActive, clamp: true },
			this.#sidebarStyle,
		);
		this.#sidebarFollowActive = false;
		return lines;
	}

	#sidebarStyle = (entry: SidebarEntry, index: number): SidebarStyle => {
		const searching = this.#searchCounts !== null && this.#activeEntry().kind === "all";
		let matchCount: number | undefined;
		if (searching) {
			if (entry.kind === "provider" && !entry.locked) {
				matchCount = this.#searchCounts?.get(entry.providerId ?? "") ?? 0;
			} else if (entry.kind === "recent") {
				matchCount = this.#recentSearchCount;
			} else if (entry.kind === "all") {
				matchCount = this.#searchTotal;
			}
		}
		// Only model scopes without matches gray out; Roles has its own search.
		const muted = entry.locked || matchCount === 0;
		let icon: string;
		if (entry.kind === "recent") {
			icon = theme.icon.time;
		} else if (entry.kind === "roles") {
			icon = theme.icon.extensionSkill;
		} else if (entry.kind === "all") {
			icon = theme.icon.model;
		} else {
			icon = muted ? theme.status.shadowed : theme.status.enabled;
		}
		const refreshing = entry.providerId ? this.#refreshingProviders.has(entry.providerId) : false;
		const annotationText = matchCount !== undefined ? String(matchCount) : (entry.annotation ?? "");
		return {
			icon: theme.fg(muted ? "dim" : entry.kind === "provider" ? "success" : "accent", icon),
			annotation: refreshing
				? theme.fg("warning", theme.spinnerFrames[this.#refreshSpinnerFrame % theme.spinnerFrames.length] ?? "")
				: theme.fg("dim", annotationText),
			muted,
			hovered: index === this.#sidebarHover,
			padTruncated: true,
		};
	};

	#renderModelKindTabs(width: number): string {
		const active = MODEL_KIND_TABS.indexOf(this.#modelKindTab);
		const track = renderSegmentTrack(
			MODEL_KIND_TABS.map(kind => ({ label: kind })),
			Math.max(0, active),
		);
		return truncateToWidth(
			` ${theme.fg("dim", "Kind:")} ${track}  ${theme.fg("dim", formatKeyHints(["alt+left", "alt+right"]))}`,
			width,
		);
	}

	#renderRoleTabs(width: number): string {
		const active = ROLE_TABS.indexOf(this.#roleTab);
		const track = renderSegmentTrack(
			ROLE_TABS.map(tab => ({ label: tab === "kind" ? "kinds" : tab })),
			Math.max(0, active),
		);
		const { names, active: activePreset } = this.#presets();
		const presetKeys = formatKeyHints(["ctrl+left", "ctrl+right"]);
		const preset =
			names.length > 0
				? `   ${theme.fg("dim", "Preset:")} ${activePreset ? theme.fg("accent", activePreset) : theme.fg("muted", "custom")}  ${theme.fg("dim", presetKeys)}`
				: "";
		return truncateToWidth(
			` ${theme.fg("dim", "Roles:")} ${track}  ${theme.fg("dim", formatKeyHints(["alt+left", "alt+right"]))}${preset}`,
			width,
		);
	}

	#statusRow(width: number): string {
		if (this.#assignmentPending) {
			return truncateToWidth(theme.fg("accent", " Applying model…"), width);
		}
		if (this.#assigning !== null) {
			const enter = formatKeyHint("enter");
			const cancel = editorKey("tui.select.cancel");
			if (this.#assigning.kind === "effortRule") {
				return truncateToWidth(
					theme.fg(
						"accent",
						` New exact ${this.#contextRulesView() ? "context" : "effort"} rule · ${enter} picks model, ${cancel} cancels`,
					),
					width,
				);
			}
			if (this.#assigning.kind === "fallbackKey") {
				return truncateToWidth(
					theme.fg("accent", ` New fallback chain — ${enter} picks the model it protects, ${cancel} cancels`),
					width,
				);
			}
			const info = this.#settings.getRoleInfo(this.#assigning.role);
			const label = info.tag ?? info.name ?? this.#assigning.role;
			if (this.#assigning.kind === "fallback") {
				const verb = this.#assigning.index === null ? "Adding fallback for" : "Replacing fallback of";
				return truncateToWidth(
					theme.fg(
						"accent",
						` ${verb} ${theme.bold(label)} — ${enter} picks the fallback model, ${cancel} cancels`,
					),
					width,
				);
			}
			return truncateToWidth(
				theme.fg("accent", ` Assigning ${theme.bold(label)} — ${enter} assigns, ${cancel} cancels`),
				width,
			);
		}
		const entry = this.#activeEntry();
		const scopedSuffix = this.#scopedModels.length > 0 ? " · --models scope" : "";
		let text: string;
		switch (entry.kind) {
			case "recent":
				text = `Recently used models${scopedSuffix}`;
				break;
			case "roles": {
				const row = this.#rolesRows[this.#roleIndex];
				text = row && "role" in row ? (this.#settings.getRoleInfo(row.role).description ?? "") : "";
				text = sanitizeDisplayWarning(text);
				break;
			}
			case "effort":
				text = this.#contextRulesView() ? CONTEXT_RULE_DESCRIPTION : EFFORT_RULE_DESCRIPTION;
				break;
			case "provider":
				if (entry.locked) {
					text = `${entry.label} · not configured`;
				} else if (entry.providerId && this.#refreshingProviders.has(entry.providerId)) {
					text = `${entry.label} · refreshing model list…`;
				} else {
					text = `${entry.label} · ${entry.annotation ?? "0"} models${scopedSuffix}`;
				}
				break;
			default:
				text = `All available models${scopedSuffix}`;
				break;
		}
		if (this.#configError && entry.kind !== "provider") {
			text = this.#configError;
			return truncateToWidth(theme.fg("error", ` ${text}`), width);
		}
		return truncateToWidth(theme.fg("muted", ` ${text}`), width);
	}

	/** Clamp a roles row to `width`; the bg band is reserved for mouse hover. */
	#finishRolesRow(line: string, width: number, hovered: boolean): string {
		let out = truncateToWidth(line, width);
		if (hovered) {
			const w = visibleWidth(out);
			if (w < width) out += " ".repeat(width - w);
			return theme.bg("selectedBg", out);
		}
		return out;
	}

	#renderRolesView(width: number, rows: number): string[] {
		const lines: string[] = [];
		lines.push(this.#renderRoleTabs(width));
		lines.push(this.#rolesSearch.render(width, { muted: value => theme.fg("muted", value) }));
		// First row's offset in bodyLine coordinates: the mouse router's
		// `bodyLine` has already dropped the status row, leaving the tabs row.
		this.#rolesRowStart = lines.length;

		let tagWidth = 0;
		for (const rowDef of this.#rolesRows) {
			if (rowDef.kind !== "role") continue;
			const info = this.#settings.getRoleInfo(rowDef.role);
			tagWidth = Math.max(
				tagWidth,
				visibleWidth((info.tag ?? info.name ?? rowDef.role) + uiProvenanceSuffix("roles", rowDef.role)),
			);
		}

		const cycleOrder = this.#cycleOrder();
		const listFocused = this.#focus === "list";
		// Window the list around the cursor so entries past the panel height stay
		// reachable; the trailing indicator line steals one row when clipped.
		const total = this.#rolesRows.length;
		const capacity = Math.max(0, rows - 2 - this.#rolesRowStart);
		const overflow = total > capacity;
		const viewHeight = overflow ? Math.max(0, capacity - 1) : capacity;
		if (this.#roleIndex !== this.#roleLastIndex) this.#roleViewport.reveal();
		this.#roleLastIndex = this.#roleIndex;
		const view = this.#roleViewport.layout(
			this.#rolesRows.map(() => 1),
			this.#roleIndex,
			Math.max(1, viewHeight),
		);
		this.#roleScrollStart = view.startIndex;
		const endIndex = view.endIndex;
		this.#rolesVisibleCount = Math.min(viewHeight, Math.max(0, endIndex - this.#roleScrollStart - view.lineOffset));
		const body: string[] = [];
		for (let i = this.#roleScrollStart; i < endIndex; i++) {
			const rowDef = this.#rolesRows[i];
			if (!rowDef) continue;
			const selected = i === this.#roleIndex;
			const hovered = i === this.#roleHover;
			// The unfocused pane draws no cursor; accent text still marks the row.
			const cursor = selected && listFocused ? theme.fg("accent", theme.nav.cursor) : " ";

			if (rowDef.kind === "separator") {
				body.push(`   ${theme.fg("border", "─".repeat(Math.max(1, width - 6)))}`);
				continue;
			}

			if (rowDef.kind === "newRole" || rowDef.kind === "newFallback") {
				const label = rowDef.kind === "newRole" ? "+ New role…" : "+ New fallback…";
				let line = ` ${cursor} ${theme.fg(selected ? "accent" : "dim", label)}`;
				line = this.#finishRolesRow(line, width, hovered);
				body.push(line);
				continue;
			}

			if (rowDef.kind === "chainKey") {
				const key = rowDef.role;
				// A regex key's slashes belong to the expression, so only a
				// provider/model key dims its provider half.
				const slash = selectorKind(key) === "regex" ? -1 : key.lastIndexOf("/");
				const tail = key.slice(slash + 1);
				const keyStyled = theme.fg("dim", key.slice(0, slash + 1)) + (selected ? theme.fg("accent", tail) : tail);
				let line = ` ${cursor} ${theme.fg("dim", theme.status.shadowed)} ${keyStyled}`;
				line = this.#finishRolesRow(line, width, hovered);
				body.push(line);
				continue;
			}

			if (rowDef.kind === "fallback") {
				const branch = theme.fg("dim", `${"".padEnd(tagWidth + 3)}↳`);
				const selector = selected ? theme.fg("accent", rowDef.selector) : theme.fg("muted", rowDef.selector);
				const policy = this.#settings.getFallbackEffortSelection(rowDef.role, rowDef.selector);
				const suffix =
					policy?.mode === "auto"
						? `  Auto [${policy.allowed?.join(", ") ?? "all"}]`
						: policy?.mode === "fixed"
							? `  ${policy.level}`
							: "";
				const model = this.#resolveFallbackEntry(rowDef.role, rowDef.chainIndex)?.item.model;
				const limit = model && this.#settings.compactionPointFor?.(model)?.limit;
				const compaction = limit ? `  compact ${limit}` : "";
				let line = ` ${cursor} ${branch} ${selector}${theme.fg("dim", suffix + compaction)}`;
				line = this.#finishRolesRow(line, width, hovered);
				body.push(line);
				continue;
			}

			const role = rowDef.role;
			const info = this.#settings.getRoleInfo(role);
			const assignment = this.#roles[role];
			const roleTag = (info.tag ?? info.name ?? role) + uiProvenanceSuffix("roles", role);
			const tag = roleTag + " ".repeat(Math.max(0, tagWidth - visibleWidth(roleTag)));

			let dot: string;
			let tagStyled: string;
			let value: string;
			let levelStyled = "";
			if (assignment && !assignment.autoSelected) {
				dot = theme.fg(info.color ?? "muted", theme.status.enabled);
				tagStyled = theme.fg(info.color ?? "muted", tag);
				value = `${theme.fg("dim", `${assignment.model.provider}/`)}${selected ? theme.fg("accent", assignment.model.id) : assignment.model.id}`;
				const source = this.#settings.getModelRoleSource(role);
				const policy =
					this.#settings.editingScope
						? this.#settings.getRoleEffortSelection(role)
						: source === "project"
							? this.#settings.getProjectRoleEffortSelection(role)
							: this.#settings.getGlobalRoleEffortSelection(role);
				const effective =
					policy?.mode === "auto"
						? AUTO_THINKING
						: policy?.mode === "fixed"
							? policy.level
							: assignment.thinkingLevel;
				const glyph = thinkingLevelGlyph(effective, theme);
				const label =
					policy?.mode === "auto" && policy.allowed
						? `Auto [${policy.allowed.join(", ")}]`
						: getConfiguredThinkingLevelMetadata(effective).label;
				if (effective !== ThinkingLevel.Inherit) {
					levelStyled = theme.fg(selected ? "accent" : "dim", glyph ? `${glyph} ${label}` : label);
				}
			} else if (assignment) {
				dot = theme.fg("dim", theme.status.shadowed);
				tagStyled = theme.fg("dim", tag);
				value = theme.fg("dim", `auto → ${assignment.model.provider}/${assignment.model.id}`);
			} else {
				dot = theme.fg("dim", theme.status.shadowed);
				tagStyled = theme.fg("dim", tag);
				value = theme.fg("dim", "—");
			}

			// Quick-cycle membership badge (`⟳ 2` = second stop of the ctrl+p cycle).
			const cycleIndex = cycleOrder.indexOf(role);
			const cycleStyled = cycleIndex >= 0 ? theme.fg("accent", `${theme.icon.loop} ${cycleIndex + 1}`) : "";

			const limit = assignment && this.#settings.compactionPointFor?.(assignment.model)?.limit;
			const compactionStyled = limit ? theme.fg("dim", `compact ${limit}`) : "";
			let line = ` ${cursor} ${dot} ${tagStyled}  ${value}`;
			const scopeNote = this.#settings.getRoleScopeNote?.(role);
			if (scopeNote) line += theme.fg("dim", `  [${scopeNote}]`);
			const budget = this.#settings.getRoleTokenBudget?.(role);
			const budgetStyled = budget === undefined ? "" : theme.fg("dim", `budget ${budget.toLocaleString("en-US")}`);
			const right = [budgetStyled, levelStyled, compactionStyled, cycleStyled].filter(part => part.length > 0).join("  ");
			const rightWidth = visibleWidth(right);
			const lineWidth = visibleWidth(line);
			if (rightWidth > 0 && lineWidth + rightWidth + 2 <= width) {
				line = `${line}${" ".repeat(width - lineWidth - rightWidth - 1)}${right}`;
			}
			line = this.#finishRolesRow(line, width, hovered);
			body.push(line);
		}
		lines.push(
			...(view.lineOffset === 0 && body.length <= viewHeight
				? body
				: body.slice(view.lineOffset, view.lineOffset + viewHeight)),
		);

		if (overflow) {
			const hiddenAbove = this.#roleScrollStart;
			const hiddenBelow = total - endIndex;
			const parts: string[] = [];
			if (hiddenAbove > 0) parts.push(`↑ ${hiddenAbove} more`);
			if (hiddenBelow > 0) parts.push(`↓ ${hiddenBelow} more`);
			lines.push(truncateToWidth(theme.fg("dim", `   ${parts.join("   ")}`), width));
		}

		// Live preview of the quick-switch cycle, rendered with the exact
		// segment track the ctrl+p status uses; the selected role's chip fills.
		while (lines.length < rows - 1) lines.push("");
		if (rows >= 2) {
			const cycleKey = editorKey("app.model.cycleForward") || formatKeyHint("ctrl+p");
			if (cycleOrder.length > 0) {
				const selectedRow = this.#rolesRows[this.#roleIndex];
				const selectedRole =
					selectedRow && (selectedRow.kind === "role" || selectedRow.kind === "fallback") ? selectedRow.role : "";
				const activeIndex = cycleOrder.indexOf(selectedRole);
				const track = renderSegmentTrack(
					cycleOrder.map(role => ({ label: role })),
					activeIndex,
				);
				lines[rows - 1] = truncateToWidth(`  ${theme.fg("dim", `${cycleKey} cycle:`)} ${track}`, width);
			} else {
				lines[rows - 1] = truncateToWidth(
					theme.fg("dim", `  ${cycleKey} cycle is empty — press ${formatKeyHint("c")} on a role to add it`),
					width,
				);
			}
		}
		return lines;
	}

	#renderLockedView(entry: SidebarEntry, width: number, rows: number): string[] {
		const lines: string[] = [];
		this.#lockedLoginLine = null;
		lines.push("");
		lines.push(truncateToWidth(theme.fg("warning", `  ${entry.label} has no credentials configured`), width));
		lines.push("");
		const envVars = entry.providerId ? (providerEntry(entry.providerId)?.envVars ?? []) : [];
		if (envVars.length > 0) {
			lines.push(
				truncateToWidth(
					theme.fg("muted", `  Set ${envVars.join(" or ")} in your environment, or add a key in config.`),
					width,
				),
			);
		} else {
			lines.push(truncateToWidth(theme.fg("muted", "  Add an API key for this provider in config."), width));
		}
		if (entry.oauth) {
			this.#lockedLoginLine = lines.length + 1; // +1 for the status row offset handled by caller
			lines.push(
				truncateToWidth(
					theme.fg("accent", `  ${theme.nav.cursor} Log in with OAuth (${formatKeyHint("enter")})`),
					width,
				),
			);
		}
		lines.push("");
		const catalogCount = entry.catalogCount ?? 0;
		if (catalogCount > 0) {
			lines.push(truncateToWidth(theme.fg("dim", `  ${catalogCount} models in catalog:`), width));
			const preview = this.#scopedModels.length > 0 ? [] : this.#registry.getAll("all");
			for (const model of preview) {
				if (model.provider !== entry.providerId) continue;
				if (lines.length >= rows) break;
				lines.push(truncateToWidth(theme.fg("dim", `    ${model.id}`), width));
			}
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	#footerHint(): string {
		const entry = this.#activeEntry();
		const configFile = !this.#sessionOnly && this.#callbacks.onOpenConfigFile ? " · Ctrl+G config file" : "";
		if (entry.kind === "overrides" && this.#assigning === null) return `${this.#overrides().hint}${configFile}`;
		const facts =
			!this.#sessionOnly && this.#callbacks.onEditFacts && this.#assigning === null
				? ` · ${formatKeyHint("f6")} model facts`
				: "";
		if (
			!this.#strip &&
			!this.#filterEditing &&
			this.#assigning === null &&
			this.#focus === "scope" &&
			this.#isBrowserView(entry) &&
			!(entry.kind === "provider" && this.#pinnedProviders.some(provider => provider.id === entry.providerId))
		)
			return `${MODEL_SCOPE_HINT}${facts}${configFile}`;
		const detail = this.#surfaceFooterHint();
		if (this.#strip || this.#filterEditing) return detail;
		return `/ search · ${detail}${facts}${configFile}`;
	}

	#surfaceFooterHint(): string {
		const enter = formatKeyHint("enter");
		const cancel = editorKey("tui.select.cancel");
		const upDown = editorKeys("tui.select.up", "tui.select.down");
		const left = formatKeyHint("left");
		const leftRight = formatKeyHints(["left", "right"]);
		const enterRight = formatKeyHints(["enter", "right"]);
		const altLeftRight = formatKeyHints(["alt+left", "alt+right"]);
		const strip = this.#strip;
		if (strip) {
			if (strip.kind === "name") {
				if (!strip.input.focused) return `/ edit · ${enter} set · ${cancel} parent`;
				if (strip.purpose === "description") return `${enter} save description · ${cancel} leave field`;
				if (strip.purpose === "roleBudget") return `${enter} save token budget · empty inherits · ${cancel} leave field`;
				if (strip.purpose === "compaction") {
					return `${enter} ${compactionConfirmPending(strip) ? "accept" : "set"} compaction point · ${cancel} leave field`;
				}
				if (strip.purpose === "contextRule") return `${enter} save context limit · ${cancel} leave field`;
				if (strip.purpose === "preset") {
					return `${enter} save preset · ${cancel} leave field`;
				}
				return `${enter} create + pick model · ${cancel} leave field`;
			}
			if (strip.kind === "pattern")
				return strip.input.focused
					? `${enter} continue to ${strip.target === "rule" && this.#contextRulesView() ? "limit" : "effort"} · ${cancel} leave field`
					: `/ edit · ${enter} continue · ${cancel} parent`;
			if (strip.kind === "effortLevels")
				return `${leftRight} effort · ${formatKeyHint("space")} toggle · ${enter} save · ${cancel} discard`;
			if (strip.kind === "selectorChoice")
				return `${upDown} exact/pattern · ${enter}/Space set · Tab context · ${cancel} cancel`;
			if (strip.kind === "role") return `${upDown} role · ${enter} assign/clear · Tab context · ${cancel} cancel`;
			if (strip.kind === "scope")
				return `${upDown} save scope · ${enter}/Space set · Tab context · ${cancel} cancel`;
			return `${leftRight} effort · ${enter}/Space apply · ${cancel} keep`;
		}
		if (this.#filterEditing) return "Search · Enter confirm · Esc clear";
		if (this.#sessionOnly && this.#isBrowserView(this.#activeEntry())) {
			return `${enter} use for session · ${upDown} models · ${left} providers · ${cancel} close`;
		}
		if (this.#assigning !== null) {
			if (this.#focus === "scope") {
				return `${enterRight} models · ${upDown} providers · / search · ${altLeftRight} kind · ${cancel} cancel`;
			}
			const browse = `${upDown} models · ${left} providers · / search · ${altLeftRight} kind · ${cancel} cancel`;
			switch (this.#assigning.kind) {
				case "fallback":
					return `${enter} pick fallback · ${browse}`;
				case "fallbackKey":
					return `${enter} pick the protected model · ${browse}`;
				default:
					return `${enter} assign · ${browse}`;
			}
		}
		const entry = this.#activeEntry();
		if (entry.kind === "effort") {
			return this.#focus === "list"
				? "↑/↓ rules · Enter edit/add · x remove · [/] reorder patterns · ← scopes"
				: "↑/↓ scopes · Enter/→ effort rules · Esc close";
		}
		if (entry.kind === "roles") {
			if (this.#focus !== "list") {
				const presets =
					this.#presets().names.length > 0 ? ` · ${formatKeyHints(["ctrl+left", "ctrl+right"])} preset` : "";
				return `${upDown} providers · ${enterRight} roles · ${altLeftRight} tabs${presets} · ${cancel} close`;
			}
			const row = this.#rolesRows[this.#roleIndex];
			const compaction =
				this.#callbacks.onCompactionPointChange && this.#roleRowModel()
					? ` · ${formatKeyHint("m")} compaction limit`
					: "";
			if (row?.kind === "fallback") {
				// Advertise thinking only when the entry resolves to an editable model.
				const editable = this.#resolveFallbackEntry(row.role, row.chainIndex) !== undefined;
				const thinking = editable ? ` · ${formatKeyHint("t")} effort` : "";
				return `${upDown} rows · ${enter} exact/pattern · ${formatKeyHint("f")} add · ${formatKeyHints(["y", "shift+y"])} yank · ${formatKeyHint("p")} append · ${formatKeyHint("x")} remove${thinking}${compaction} · [/] reorder · ${left} scopes`;
			}
			if (row?.kind === "chainKey") {
				return `${upDown} rows · ${enter} edit key · ${formatKeyHint("f")} add fallback · ${formatKeyHint("p")} append · ${formatKeyHint("x")} clear chain · ${left} providers`;
			}
			if (row?.kind === "newFallback") {
				return `${upDown} rows · ${enter} new exact/pattern fallback chain · ${left} providers`;
			}
			// Thinking is editable only when the assigned model has reasoning levels.
			const editable = row?.kind === "role" && this.#roleThinkingTarget(row.role) !== undefined;
			const thinking = editable ? ` · ${formatKeyHint("t")} thinking` : "";
			const savePreset = this.#callbacks.onSavePreset ? ` · ${formatKeyHint("s")} save preset` : "";
			const switchPreset =
				this.#presets().names.length > 0 ? ` · ${formatKeyHints(["ctrl+left", "ctrl+right"])} preset` : "";
			const yank =
				row?.kind === "role" && (this.#fallbackChains()[row.role]?.length ?? 0) > 0 ? "yank chain" : "yank model";
			return `${upDown} rows · ${enter} pick · D description · ${formatKeyHint("f")} fallback · ${formatKeyHint("y")} ${yank} · ${formatKeyHint("p")} append · ${formatKeyHint("x")} clear${thinking}${compaction} · ${formatKeyHint("c")} cycle · [/] reorder · ${formatKeyHint("n")} new${savePreset}${switchPreset}`;
		}
		if (entry.kind === "provider" && entry.locked) {
			return entry.oauth
				? `${enter} log in · ${upDown} providers · ${cancel} close`
				: `${upDown} providers · ${cancel} close`;
		}
		if (entry.kind === "provider" && this.#pinnedProviders.some(provider => provider.id === entry.providerId)) {
			return this.#focus === "scope"
				? "Enter/→ mixtures · ↑/↓ providers · Esc close"
				: "Enter pick · e edit graph · ↓ define mixture · ← providers · Esc close";
		}
		const refresh = entry.kind === "provider" ? ` · ${formatKeyHint("f5")} refresh` : "";
		if (this.#focus === "scope") {
			return `${enterRight} models · ${upDown} providers · / search · ${altLeftRight} kind${refresh} · ${cancel} close`;
		}
		return `${enter} assign roles · ${upDown} models · ${left} providers · / search · ${altLeftRight} kind${refresh} · ${cancel} close`;
	}

	#renderFooter(width: number): string {
		const strip = this.#strip;
		return this.#frame.renderFooter(
			width,
			this.#footerHint(),
			strip
				? () => {
						const label =
							strip.kind === "name" || strip.kind === "pattern"
								? strip.input.focused
									? "Enter set · Esc leave field"
									: "/ edit · Esc parent"
								: strip.kind === "effortLevels"
									? "←/→ effort · Space toggle"
									: strip.kind === "thinking" || strip.kind === "patternEffort"
										? "←/→ effort · Enter set"
										: "↑/↓ choose · Enter set";
						const hint = truncateToWidth(label, Math.max(0, width - 36));
						const columns = Math.max(1, width - visibleWidth(hint) - (hint ? 3 : 0));
						const line = this.#renderStrip(columns, strip);
						return hint
							? `${line}${" ".repeat(Math.max(0, columns - visibleWidth(line)))} · ${theme.fg("dim", hint)}`
							: line;
					}
				: undefined,
		);
	}

	#renderStrip(width: number, strip: StripState): string {
		if (strip.kind === "name") {
			const labelText =
				strip.purpose === "roleBudget"
					? `${strip.role} token budget:`
					: strip.purpose === "compaction"
					? `${strip.model.id} limit:`
					: strip.purpose === "contextRule"
						? `${strip.selector} limit:`
						: strip.purpose === "description"
							? `${strip.role} description:`
							: strip.purpose === "preset"
								? "Preset name:"
								: "New role name:";
			const label = theme.fg("accent", labelText);
			// A compaction point is at most a few characters (`1500k`, `12.5%`); a
			// narrow field leaves the row for its notice.
			const maxInputWidth = strip.purpose === "compaction" ? 10 : strip.purpose === "description" ? width : 32;
			const inputWidth = Math.max(8, Math.min(maxInputWidth, width - visibleWidth(labelText) - 24));
			const inputLine = strip.input.render(inputWidth)[0] ?? "";
			let hint: string;
			if (strip.purpose === "compaction") {
				const notice = compactionNotice(strip, this.#callbacks.previewCompactionPoint);
				hint = theme.fg(notice.style, notice.text);
			} else if (strip.purpose === "contextRule") {
				hint = theme.fg("dim", "400k base · f400k fixed · 80% · empty resets");
			} else if (strip.purpose === "description") {
				hint = "";
			} else if (strip.purpose === "roleBudget") {
				hint = theme.fg("dim", "positive tokens · empty inherits");
			} else {
				hint = theme.fg("dim", "(letters, digits, - and _)");
			}
			return truncateToWidth(`${label} ${inputLine} ${hint}`, width);
		}
		if (strip.kind === "pattern") {
			const label = theme.fg(
				"accent",
				strip.target === "rule"
					? `Model ${this.#contextRulesView() ? "context" : "effort"} pattern:`
					: strip.target === "role"
						? "Role model pattern:"
						: strip.target === "fallbackKey"
							? "Fallback chain key:"
							: "Fallback model pattern:",
			);
			const hint =
				strip.target === "fallbackKey"
					? theme.fg("dim", "provider/*, provider/prefix/*, or re: regex")
					: patternStripHint(strip.input.getValue().trim());
			const inputWidth = Math.max(8, width - visibleWidth(label) - visibleWidth(hint) - 4);
			return truncateToWidth(`${label} ${strip.input.render(inputWidth)[0] ?? ""} ${hint}`, width);
		}
		if (strip.kind === "effortLevels") {
			const chips = strip.toggle.options.map(level => ({
				label: level,
				styled: `${theme.fg(
					strip.toggle.selected.has(level) ? "success" : "dim",
					strip.toggle.selected.has(level) ? theme.status.enabled : theme.status.disabled,
				)} ${level}`,
				action: "thinking" as const,
			}));
			const label = strip.pendingRuleSelector ?? strip.selector ?? strip.item?.id ?? "Effort";
			return this.#renderChipWindow(
				width,
				theme.fg("accent", `${truncateToWidth(label, Math.max(12, Math.floor(width / 3)))} → `),
				{ chips, index: strip.index },
			);
		}
		if (strip.kind === "selectorChoice" || strip.kind === "patternEffort") {
			return this.#renderChipWindow(width, theme.fg("accent", `${this.#selectorStripLabel(strip)} → `), strip);
		}

		const prefix =
			strip.kind === "role"
				? `${theme.fg("accent", strip.item.id)}${theme.fg("dim", " →")} `
				: `${theme.fg(this.#settings.getRoleInfo(strip.role ?? "").color ?? "muted", (this.#settings.getRoleInfo(strip.role ?? "").tag ?? strip.role ?? "").toLowerCase())}${theme.fg("dim", ` · ${strip.item.id} →`)} `;
		return this.#renderChipWindow(width, prefix, strip);
	}

	#renderChipWindow(width: number, prefix: string, strip: HubStripState<HubStripChip<unknown>>): string {
		// Horizontal window: once the strip overflows, drop leading chips behind
		// a dim ellipsis so the selected chip (plus one chip of lookahead when it
		// fits) stays visible while cycling right.
		const prefixWidth = visibleWidth(prefix);
		const available = Math.max(1, width - prefixWidth);
		const chipWidths = strip.chips.map(
			(chip, i) => visibleWidth(` ${chip.styled} `) + (i === strip.index ? 2 : 0) + 1,
		);
		// Smallest start index whose window [start..target] (with its "… " lead-in
		// when start > 0) fits in the available width; `target` itself may still
		// overflow when a single chip is wider than the row.
		const startFor = (target: number): number => {
			let start = 0;
			while (start < target) {
				let sum = start > 0 ? 2 : 0;
				for (let i = start; i <= target; i++) sum += chipWidths[i] ?? 0;
				if (sum <= available) break;
				start++;
			}
			return start;
		};
		let start = startFor(Math.min(strip.index + 1, strip.chips.length - 1));
		if (start > strip.index) start = startFor(strip.index);

		return this.#frame.renderChips(width, prefix, strip, start);
	}

	render(width: number): readonly string[] {
		const height = Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		const innerWidth = Math.max(1, width - 4);
		const strip = this.#strip;
		const textFocused =
			this.#filterEditing ||
			((strip?.kind === "name" || strip?.kind === "pattern") && strip.input.focused) ||
			(this.#activeEntry().kind === "overrides" && this.#assigning === null && this.#overrides().editing);
		const footer = menuHintLines(
			`${this.#footerHint()}${textFocused ? "" : " · ? help"}`,
			innerWidth,
			textFocused ? "" : undefined,
		).map(line => theme.fg("dim", line));
		if (strip) footer.unshift(this.#renderFooter(innerWidth));
		else this.#frame.chipRanges = [];
		return this.#help.render(this.#frame.render(width, height, this.#entries, footer), width);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Native (TSP) description
	// ═══════════════════════════════════════════════════════════════════════

	/** A `picker` is its own sheet: the backend mounts it in `layer` without an `overlay` wrapper. */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker") && (this.#activeEntry().kind !== "overrides" || this.#assigning !== null);
	}

	describe(cx: DescribeContext): NativeNode {
		if (this.#help.open) return this.#help.describe();
		const usePicker = this.nativeSheet(cx);
		const cached = this.#nativeCache;
		if (cached?.version === this.#nativeVersion && cached.picker === usePicker) return cached.node;
		if (usePicker) {
			const described = this.#describePicker();
			this.#nativeCache = { version: this.#nativeVersion, picker: true, node: described };
			return described;
		}
		const footer: NativeChild[] = [];
		const strip = this.#describeStrip();
		if (strip) footer.push(strip);
		footer.push(hintsRow(this.#footerHints()));
		const described = describeHubFrame(
			"omp.overlay.model-hub",
			"Models",
			describeHubSidebar(this.#entries, this.#activeEntryId, this.#nativeSidebarStyle, "scopes"),
			this.#describeBody(),
			node("col", { gap: "xs" }, footer, "footer"),
		);
		this.#nativeCache = { version: this.#nativeVersion, picker: false, node: described };
		return described;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#help.open) {
			if (event.type === "action") this.#help.handleInput("\x1b");
			this.#requestRender();
			return;
		}
		this.#withNavigationVisit(() => this.#handleNativeEvent(event));
	}

	#handleNativeEvent(event: NativeUiEvent): void {
		const picked = pickerEvent(event);
		if (picked) {
			this.#handlePickerEvent(picked);
			this.#requestRender();
			return;
		}
		// Same gate as the mouse router: nothing is interactive while an assignment applies.
		if (this.#assignmentPending) return;
		const target = event.key.slice(event.key.lastIndexOf("/") + 1);
		if (
			this.#activeEntry().kind === "overrides" &&
			this.#assigning === null &&
			event.key.includes("modelOverrides")
		) {
			this.#focus = "list";
			this.#overrides().handleNativeEvent(event);
			this.#requestRender();
			return;
		}
		if (event.type === "action") {
			const entry = this.#activeEntry();
			if (target !== "login" || event.act !== "login") return;
			if (entry.kind !== "provider" || !entry.locked || this.#assigning !== null) return;
			this.#requestLogin(entry);
		} else if (event.type === "select" || event.type === "activate") {
			switch (target) {
				case "scopes":
					this.#clickSidebarEntry(this.#entries.find(entry => entry.id === event.item));
					break;
				case "roles": {
					if (this.#activeEntry().kind !== "roles" || this.#assigning !== null) return;
					const index = this.#rolesRows.findIndex((rowDef, i) => rolesRowKey(rowDef, i) === event.item);
					const rowDef = this.#rolesRows[index];
					if (!rowDef || rowDef.kind === "separator") return;
					this.#focus = "list";
					this.#roleIndex = index;
					this.#activateRolesRow(rowDef);
					break;
				}
				case "effortRules": {
					if (this.#activeEntry().kind !== "effort" || this.#assigning !== null) return;
					const index = Number(event.item);
					if (!Number.isInteger(index) || !this.#syncEffortSelection().includes(index)) return;
					this.#focus = "list";
					this.#effortIndex = index;
					if (event.type === "activate") this.#handleEffortRulesInput("\r");
					break;
				}
				case "roleTabs": {
					const tab = ROLE_TABS.find(candidate => candidate === event.item);
					if (!tab) return;
					this.#roleTab = tab;
					this.#roleIndex = 0;
					this.#roleViewport.setTop(0);
					this.#buildRolesRows();
					break;
				}
				case "kinds": {
					const kind = MODEL_KIND_TABS.find(candidate => candidate === event.item);
					if (!kind) return;
					this.#modelKindTab = kind;
					this.#applyModelKind();
					break;
				}
				case "strip": {
					// A chip click picks and applies it, like the footer mouse path.
					const strip = this.#strip;
					const index = Number(event.item);
					if (!strip || !Number.isInteger(index)) return;
					if (strip.kind === "effortLevels") {
						const level = strip.toggle.options[index];
						if (!level) return;
						strip.index = index;
						strip.toggle.toggle(level);
						this.#configError = undefined;
					} else {
						if (strip.kind === "name" || strip.kind === "pattern" || !strip.chips[index]) return;
						strip.index = index;
						if (strip.kind === "selectorChoice") this.#activateSelectorChoice(strip);
						else this.#activateStripChip();
					}
					break;
				}
				default:
					return;
			}
		} else {
			return;
		}
		this.#requestRender();
	}

	/** Sidebar decoration for the native list: refreshing providers show an ellipsis, the status row spins. */
	#nativeSidebarStyle = (entry: SidebarEntry, index: number): Pick<SidebarStyle, "icon" | "annotation" | "muted"> => {
		const style = this.#sidebarStyle(entry, index);
		const refreshing = entry.providerId !== undefined && this.#refreshingProviders.has(entry.providerId);
		return { ...style, annotation: refreshing ? "…" : plainText(style.annotation) };
	};

	#describeBody(): NativeNode {
		const children: NativeChild[] = [this.#describeStatus()];
		const entry = this.#activeEntry();
		if (entry.kind === "overrides" && this.#assigning === null) return this.#overrides().describe();
		if (entry.kind === "roles" && this.#assigning === null) {
			children.push(...this.#describeRolesView());
		} else if (entry.kind === "effort" && this.#assigning === null) {
			const indices = this.#syncEffortSelection();
			const items = indices.map(index =>
				node("item", { label: this.#effortRowText(index) }, undefined, String(index)),
			);
			children.push(this.#effortSearch.input);
			const queryError = compileMenuRegex(this.#effortSearch.value)?.error;
			if (queryError) children.push(text([span(queryError, "error")]));
			children.push(
				node(
					"list",
					{
						selected: this.#effortIndex < 0 ? null : String(this.#effortIndex),
						virtual: true,
						grow: 1,
						aria: this.#contextRulesView() ? "Context rules" : "Effort rules",
					},
					items,
					"effortRules",
				),
			);
		} else if (entry.kind === "provider" && entry.locked && this.#assigning === null) {
			children.push(this.#describeLockedView(entry));
		} else {
			children.push(
				node(
					"row",
					{ gap: "sm", align: "center" },
					[
						text([span("Kind:", "dim")]),
						node(
							"tabs",
							{ items: MODEL_KIND_TABS.map(kind => ({ id: kind, label: kind })), active: this.#modelKindTab },
							undefined,
							"kinds",
						),
					],
					"kindTabs",
				),
				this.#browser,
			);
		}
		// Zero basis: the body takes the space left of the sidebar instead of sizing to its widest line.
		return node("col", { gap: "sm", grow: 1, basis: 0, min: { w: 0 } }, children, "body");
	}

	#describeStatus(): NativeNode {
		if (this.#assignmentPending) {
			return node("spinner", { label: [span("Applying model…", "accent")] }, undefined, "status");
		}
		let spans: TspSpan[];
		const assigning = this.#assigning;
		if (assigning !== null) {
			if (assigning.kind === "fallbackKey") {
				spans = [span("New fallback chain — pick the model it protects", "accent")];
			} else if (assigning.kind === "effortRule") {
				spans = [
					span(`New exact ${this.#contextRulesView() ? "context" : "effort"} rule · pick a model`, "accent"),
				];
			} else {
				const info = this.#settings.getRoleInfo(assigning.role);
				const label = info.tag ?? info.name ?? assigning.role;
				const verb =
					assigning.kind === "role"
						? "Assigning"
						: assigning.index === null
							? "Adding fallback for"
							: "Replacing fallback of";
				spans = [span(`${verb} `, "accent"), span(label, "accent strong")];
			}
			return node("text", { spans, truncate: "end" }, undefined, "status");
		}
		const entry = this.#activeEntry();
		if (this.#configError && entry.kind !== "provider") {
			return node("text", { spans: [span(this.#configError, "error")], wrap: "word" }, undefined, "status");
		}
		const scopedSuffix = this.#scopedModels.length > 0 ? " · --models scope" : "";
		switch (entry.kind) {
			case "recent":
				spans = [span(`Recently used models${scopedSuffix}`, "muted")];
				break;
			case "roles":
				spans = [
					span("Model roles — ", "muted"),
					span("f", "key"),
					span(" adds a retry fallback, cleared roles fall back to auto-selection", "muted"),
				];
				break;
			case "provider":
				if (entry.locked) {
					spans = [span(`${entry.label} · not configured`, "muted")];
				} else if (entry.providerId && this.#refreshingProviders.has(entry.providerId)) {
					return node(
						"spinner",
						{ label: [span(`${entry.label} · refreshing model list…`, "muted")] },
						undefined,
						"status",
					);
				} else {
					spans = [span(`${entry.label} · ${entry.annotation ?? "0"} models${scopedSuffix}`, "muted")];
				}
				break;
			default:
				spans = [span(`All available models${scopedSuffix}`, "muted")];
				break;
		}
		return node("text", { spans, truncate: "end" }, undefined, "status");
	}

	#describeRolesView(): NativeChild[] {
		const tabs = node(
			"row",
			{ gap: "sm", align: "center" },
			[
				text([span("Roles:", "dim")]),
				node(
					"tabs",
					{
						items: ROLE_TABS.map(tab => ({ id: tab, label: tab === "kind" ? "kinds" : tab })),
						active: this.#roleTab,
					},
					undefined,
					"roleTabs",
				),
			],
			"roleTabsRow",
		);
		const cycleOrder = this.#cycleOrder();
		const items = this.#rolesRows.map((rowDef, index) => this.#describeRolesRow(rowDef, index, cycleOrder));
		const selectedRow = this.#rolesRows[this.#roleIndex];
		const list = node(
			"list",
			{
				selected: selectedRow ? rolesRowKey(selectedRow, this.#roleIndex) : null,
				virtual: true,
				grow: 1,
				tone: this.#focus === "list" ? "accent" : undefined,
				aria: "Roles",
			},
			items,
			"roles",
		);
		const queryError = compileMenuRegex(this.#rolesSearch.value)?.error;
		return [
			tabs,
			this.#rolesSearch.input,
			...(queryError ? [text([span(queryError, "error")])] : []),
			list,
			this.#describeCycle(cycleOrder),
		];
	}

	#describeRolesRow(rowDef: RolesRow, index: number, cycleOrder: readonly string[]): NativeNode {
		const key = rolesRowKey(rowDef, index);
		switch (rowDef.kind) {
			case "separator":
				return node("rule", undefined, undefined, key);
			case "newRole":
				return node("item", { label: [span("+ New role…", "dim")] }, undefined, key);
			case "newFallback":
				return node("item", { label: [span("+ New fallback…", "dim")] }, undefined, key);
			case "chainKey": {
				const slash = rowDef.role.lastIndexOf("/");
				return node(
					"item",
					{
						label: [
							span(`${theme.status.shadowed} `, "dim"),
							span(rowDef.role.slice(0, slash + 1), "dim"),
							span(rowDef.role.slice(slash + 1)),
						],
					},
					undefined,
					key,
				);
			}
			case "fallback": {
				const model = this.#resolveFallbackEntry(rowDef.role, rowDef.chainIndex)?.item.model;
				const limit = model && this.#settings.compactionPointFor?.(model)?.limit;
				return node(
					"item",
					{
						label: [span("  ↳ ", "dim"), span(rowDef.selector, "muted")],
						value: limit ? [span(`compact ${limit}`, "dim")] : undefined,
					},
					undefined,
					key,
				);
			}
			case "role":
				break;
		}
		const role = rowDef.role;
		const info = this.#settings.getRoleInfo(role);
		const assignment = this.#roles[role];
		const tag = (info.tag ?? info.name ?? role) + uiProvenanceSuffix("roles", role);
		let label: TspSpan[];
		let detail: TspSpan[];
		const value: TspSpan[] = [];
		if (assignment && !assignment.autoSelected) {
			const color = info.color ?? "muted";
			label = [span(`${theme.status.enabled} `, color), span(tag, color)];
			detail = [span(`${assignment.model.provider}/`, "dim"), span(assignment.model.id)];
			if (assignment.thinkingLevel !== ThinkingLevel.Inherit) {
				const glyph = thinkingLevelGlyph(assignment.thinkingLevel, theme);
				const levelLabel = getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label;
				value.push(
					span(glyph ? `${glyph} ${levelLabel}` : levelLabel, index === this.#roleIndex ? "accent" : "dim"),
				);
			}
		} else {
			label = [span(`${theme.status.shadowed} `, "dim"), span(tag, "dim")];
			detail = assignment
				? [span(`auto → ${assignment.model.provider}/${assignment.model.id}`, "dim")]
				: [span("—", "dim")];
		}
		const limit = assignment && this.#settings.compactionPointFor?.(assignment.model)?.limit;
		if (limit) {
			if (value.length > 0) value.push(span("  "));
			value.push(span(`compact ${limit}`, "dim"));
		}
		// Quick-cycle membership badge (`⟳ 2` = second stop of the ctrl+p cycle).
		const cycleIndex = cycleOrder.indexOf(role);
		if (cycleIndex >= 0) {
			if (value.length > 0) value.push(span("  "));
			value.push(span(`${theme.icon.loop} ${cycleIndex + 1}`, "accent"));
		}
		return node("item", { label, detail, value: value.length > 0 ? value : undefined }, undefined, key);
	}

	/** Live preview of the quick-switch cycle; the selected row's role is emphasized. */
	#describeCycle(cycleOrder: readonly string[]): NativeNode {
		const [cycleKey] = boundKeys("app.model.cycleForward", ["ctrl+p"]);
		const keycap: NativeChild[] = cycleKey ? [kbd(cycleKey)] : [];
		if (cycleOrder.length === 0) {
			return node(
				"row",
				{ gap: "xs", align: "center", wrap: true },
				[
					...keycap,
					text([span("cycle is empty — press ", "dim"), span("c", "key"), span(" on a role to add it", "dim")]),
				],
				"cycle",
			);
		}
		const selectedRow = this.#rolesRows[this.#roleIndex];
		const selectedRole =
			selectedRow && (selectedRow.kind === "role" || selectedRow.kind === "fallback") ? selectedRow.role : "";
		const track: TspSpan[] = [];
		for (const role of cycleOrder) {
			if (track.length > 0) track.push(span(" › ", "dim"));
			track.push(span(role, role === selectedRole ? "accent strong" : "muted"));
		}
		return node(
			"row",
			{ gap: "xs", align: "center", wrap: true },
			[...keycap, text([span("cycle:", "dim")]), text(track, { wrap: "word" })],
			"cycle",
		);
	}

	#describeLockedView(entry: SidebarEntry): NativeNode {
		const children: NativeChild[] = [
			text([span(`${entry.label} has no credentials configured`, "warning")], { wrap: "word" }),
		];
		const envVars = entry.providerId ? (providerEntry(entry.providerId)?.envVars ?? []) : [];
		children.push(
			text(
				[
					span(
						envVars.length > 0
							? `Set ${envVars.join(" or ")} in your environment, or add a key in config.`
							: "Add an API key for this provider in config.",
						"muted",
					),
				],
				{ wrap: "word" },
			),
		);
		if (entry.oauth) {
			children.push(
				node(
					"row",
					{ gap: "sm", align: "center", actions: { click: "login" } },
					[text([span("Log in with OAuth", "accent")]), node("kbd", { keys: ["enter"] })],
					"login",
				),
			);
		}
		const catalogCount = entry.catalogCount ?? 0;
		if (catalogCount > 0) {
			const models = this.#scopedModels.length > 0 ? [] : this.#registry.getAll("all");
			const items: NativeNode[] = [];
			for (const model of models) {
				if (model.provider !== entry.providerId) continue;
				items.push(node("item", { label: model.id, disabled: true }, undefined, model.id));
			}
			children.push(
				node(
					"section",
					{ head: [span(`${catalogCount} models in catalog`, "dim")] },
					[node("list", { selected: null, virtual: true }, items, "catalog")],
					"catalog",
				),
			);
		}
		return node("col", { gap: "sm", grow: 1 }, children, "locked");
	}

	// ─── Picker (data-first `picker` kind, NATIVE_REDESIGN.md §4.7) ─────────

	#describePicker(): NativeNode {
		const entry = this.#activeEntry();
		const rolesView = entry.kind === "roles" && this.#assigning === null;
		const lockedView = entry.kind === "provider" && entry.locked === true && this.#assigning === null;
		const strip = this.#strip;
		const subtitle = this.#pickerSubtitle(entry, rolesView);
		const navigation =
			strip || this.#filterEditing
				? this.#surfaceFooterHint()
				: this.#focus === "scope"
					? this.#footerHint()
					: "/ search · ? help";
		const queryError = compileMenuRegex(
			entry.kind === "effort" && this.#assigning === null
				? this.#effortSearch.value
				: rolesView
					? this.#rolesSearch.value
					: this.#browser.query,
		)?.error;
		const props: TspPickerProps = {
			title: this.#sessionOnly ? "Session model" : this.#settings.editingScope ? `Models · ${this.#settings.editingScope}` : "Models",
			subtitle: [
				...(queryError ? [span(queryError, "error")] : []),
				...(typeof subtitle === "string" ? [span(subtitle)] : (subtitle ?? [])),
				span(` · ${plainText(navigation)}`, "dim"),
			],
			icon: "cpu",
			noun: rolesView ? "roles" : "models",
			size: "lg",
			layout: "rows",
			preview: "side",
			query: rolesView
				? this.#rolesSearch.value || this.#filterEditing
					? this.#rolesSearch.value
					: null
				: this.#browser.value,
			cursor: rolesView ? this.#rolesSearch.cursor : this.#browser.cursor,
			placeholder: rolesView ? "Search roles and fallback chains…" : "/ search models…",
			scopes: this.#pickerScopes(),
			scope: entry.id,
			actions: this.#pickerActions(entry, rolesView, lockedView),
			strip: strip ? this.#pickerStrip(strip) : null,
			focus: strip ? "strip" : this.#focus === "scope" ? "scopes" : "list",
		};
		if (entry.kind === "effort" && this.#assigning === null) {
			const rules = this.#rules();
			const indices = this.#syncEffortSelection();
			const items: TspPickerItem[] = rules.map((rule, index) => ({
				id: `effort:${index}`,
				label: rule.selector,
				detail: `${selectorKind(rule.selector)} · ${this.#ruleValue(rule)}`,
				mono: true,
			}));
			items.push(
				{ id: `effort:${rules.length}`, label: "Pick exact model…", icon: "plus" },
				{ id: `effort:${rules.length + 1}`, label: "Enter glob or re: regex…", icon: "plus" },
			);
			return picker(
				{
					...props,
					noun: "rules",
					query: this.#effortSearch.value,
					cursor: this.#effortSearch.cursor,
					placeholder: this.#contextRulesView() ? "Search context rules…" : "Search effort rules…",
					items,
					order: indices.map(index => `effort:${index}`),
					selected: this.#effortIndex < 0 ? null : `effort:${this.#effortIndex}`,
					total: rules.length,
					actions:
						this.#strip || this.#filterEditing
							? props.actions
							: compact([
									this.#effortIndex >= 0
										? pickerAction("effort:edit", "Edit / add", "enter", { primary: true })
										: undefined,
									this.#effortIndex >= 0 && this.#effortIndex < rules.length
										? pickerAction("effort:remove", "Remove", "x")
										: undefined,
									this.#effortSearch.value ? pickerAction("clear", "Clear search") : undefined,
									this.#pickerCancelAction(),
								]),
				},
				[],
			);
		}
		if (rolesView) {
			const row = this.#rolesRows[this.#roleIndex];
			return picker(
				{
					...props,
					tabs: ROLE_TABS.map(tab => ({
						id: tab,
						label: tab === "all" ? "All" : tab === "chat" ? "Chat" : "Kinds",
						count: this.#visibleRoleIds().filter(
							role => tab === "all" || this.#settings.getRoleInfo(role).section === tab,
						).length,
					})),
					tab: this.#roleTab,
					columns: ROLE_PICKER_COLUMNS,
					items: this.#rolePickerItems(),
					order: this.#rolePickerOrder(),
					selected: row && row.kind !== "separator" ? rolesRowKey(row, this.#roleIndex) : null,
					total: this.#allRolesRowCount(),
				},
				this.#rolePreview(row),
			);
		}
		const catalogue = this.#browser.pickerItems(this.#availableItems);
		const current = this.#currentSelector ? [this.#currentSelector] : undefined;
		if (lockedView) {
			return picker(
				{
					...props,
					columns: MODEL_PICKER_COLUMNS,
					...catalogue,
					order: [],
					selected: null,
					total: entry.catalogCount ?? 0,
					empty: this.#lockedMessage(entry),
					...(current ? { current } : {}),
				},
				this.#lockedPreview(entry),
			);
		}
		const query = this.#browser.query.trim();
		const view = this.#browser.pickerOrder({
			providers: entry.kind === "all" && query.length === 0,
			rest: entry.kind === "provider" ? entry.label : query ? "Matches" : "All models",
		});
		const refreshing =
			this.#catalogRefreshing ||
			(entry.kind === "provider" && this.#refreshingProviders.has(entry.providerId ?? ""));
		const state =
			view.count > 0 || query
				? "ready"
				: refreshing
					? "loading"
					: this.#configError && !this.#assigning
						? "error"
						: "ready";
		return picker(
			{
				...props,
				tabs: this.#pickerKindTabs(),
				tab: this.#modelKindTab,
				...this.#browser.pickerRows(catalogue, view, this.#currentSelector),
				state,
				...(state === "error" && this.#configError ? { message: this.#configError } : {}),
				empty:
					this.#emptyStateMessage()?.trim() ??
					(entry.kind === "provider" ? `No models from ${entry.label} yet` : "No models available in this scope"),
			},
			this.#browser.pickerPreview("full", this.#currentSelector),
		);
	}

	/** What the hub is doing when it is more than browsing: applying, assigning, refreshing, a config error. */
	#pickerSubtitle(entry: SidebarEntry, rolesView: boolean): TspPickerProps["subtitle"] {
		if (this.#assignmentPending) return "Applying model…";
		if (this.#sessionOnly) return "Current session only";
		if (rolesView && this.#settings.editingScope) return `Editing ${this.#settings.editingScope} · session > project > global`;
		const assigning = this.#assigning;
		if (assigning !== null) {
			if (assigning.kind === "fallbackKey") return "New fallback chain — pick the model it protects";
			if (assigning.kind === "effortRule")
				return `New exact ${this.#contextRulesView() ? "context" : "effort"} rule · pick a model`;
			const info = this.#settings.getRoleInfo(assigning.role);
			const label = info.tag ?? info.name ?? assigning.role;
			const verb =
				assigning.kind === "role"
					? "Assigning"
					: assigning.index === null
						? "Adding fallback for"
						: "Replacing fallback of";
			return [span(`${verb} `), span(label, "strong")];
		}
		if (this.#configError && entry.kind !== "provider") return [span(this.#configError, "error")];
		if (entry.kind === "provider" && entry.providerId && this.#refreshingProviders.has(entry.providerId)) {
			return `${entry.label} · refreshing model list…`;
		}
		if (entry.kind === "effort") return this.#contextRulesView() ? CONTEXT_RULE_DESCRIPTION : EFFORT_RULE_DESCRIPTION;
		const presets = rolesView ? this.#presets() : undefined;
		if (presets && presets.names.length > 0) {
			return [
				span("Preset ", "muted"),
				presets.active ? span(presets.active, "strong") : span("custom", "muted"),
				span(
					this.#scopedModels.length > 0 ? " · --models scope" : " · Cleared roles fall back to auto-selection",
					"muted",
				),
			];
		}
		if (this.#scopedModels.length > 0) return "--models scope";
		if (rolesView) return "Cleared roles fall back to auto-selection";
		return undefined;
	}

	/** The sidebar as picker scopes: Roles, All models, then signed-in and signed-out providers. */
	#pickerScopes(): TspPickerScope[] {
		const counts = this.#activeEntry().kind === "all" ? this.#searchCounts : null;
		const oauthIds = new Set(getOAuthProviders().map(provider => provider.id));
		const scopes: TspPickerScope[] = [];
		for (const entry of this.#entries) {
			switch (entry.kind) {
				case "separator":
					break;
				case "roles":
					scopes.push({ id: entry.id, label: "Roles", icon: "sparkles", count: this.#visibleRoleIds().length });
					break;
				case "effort":
					if (entry.id === "context") {
						scopes.push({
							id: entry.id,
							label: "Context rules",
							icon: "sliders",
							count: this.#settings.contextRules?.length ?? 0,
						});
						break;
					}
					scopes.push({
						id: entry.id,
						label: "Effort rules",
						icon: "sliders",
						count: this.#settings.effortRules.length,
					});
					break;
				case "all":
					scopes.push({
						id: entry.id,
						label: "All models",
						icon: "list",
						count: counts ? this.#searchTotal : this.#availableItems.length,
					});
					break;
				case "recent":
					scopes.push({
						id: entry.id,
						label: "Recent",
						icon: "clock",
						count: counts ? this.#recentSearchCount : this.#recentItems.length,
					});
					break;
				case "provider": {
					const providerId = entry.providerId ?? entry.label;
					const mark = providerMark(providerId);
					if (entry.locked) {
						const envVars = providerEntry(providerId)?.envVars ?? [];
						scopes.push({
							id: entry.id,
							label: entry.label,
							mark,
							group: "Not signed in",
							disabled: oauthIds.has(providerId)
								? "Sign in with /login"
								: envVars.length > 0
									? `Set ${envVars.join(" or ")} to sign in`
									: "Add an API key in config to sign in",
							dot: "muted",
						});
						break;
					}
					const dot = this.#providerDot(providerId);
					scopes.push({
						id: entry.id,
						label: entry.label,
						mark,
						group: "Providers",
						count: counts ? (counts.get(providerId) ?? 0) : Number(entry.annotation ?? 0),
						...(dot ? { dot } : {}),
					});
					break;
				}
			}
		}
		return scopes;
	}

	/** Discovery state as a scope dot: refreshing, ok, cached/empty, unavailable, signed out. */
	#providerDot(providerId: string): TspPickerScope["dot"] {
		if (this.#refreshingProviders.has(providerId)) return "pending";
		switch (this.#registry.getProviderDiscoveryState(providerId)?.status) {
			case "ok":
				return "success";
			case "cached":
			case "empty":
				return "warning";
			case "unavailable":
				return "error";
			case "unauthenticated":
				return "muted";
			default:
				return undefined;
		}
	}

	/** Kind tabs with their counts in the active scope; the same array while the scope's models are unchanged. */
	#pickerKindTabs(): TspPickerProps["tabs"] {
		const candidates = this.#candidateItems;
		if (this.#kindTabsMemo?.candidates === candidates) return this.#kindTabsMemo.tabs;
		const counts = new Map<string, number>();
		for (const item of candidates) {
			const kind = modelKind(item.model);
			counts.set(kind, (counts.get(kind) ?? 0) + 1);
		}
		const tabs = MODEL_KIND_TABS.map(kind => ({
			id: kind,
			label: MODEL_KIND_LABELS[kind],
			count: kind === "all" ? candidates.length : (counts.get(kind) ?? 0),
		}));
		this.#kindTabsMemo = { candidates, tabs };
		return tabs;
	}

	#pickerCancelAction(): TspPickerAction {
		if (this.#assignmentPending) return CLOSE_ACTION;
		const strip = this.#strip;
		const textFocused = (strip?.kind === "name" || strip?.kind === "pattern") && strip.input.focused;
		return {
			...CLOSE_ACTION,
			label: this.#filterEditing
				? "Clear search"
				: textFocused
					? "Leave field"
					: strip || this.#assigning
						? "Back"
						: "Close",
		};
	}

	/** The action bar for the current view; every button runs the path of the key it shows. */
	#pickerActions(entry: SidebarEntry, rolesView: boolean, lockedView: boolean): TspPickerAction[] {
		const strip = this.#strip;
		const cancel = this.#pickerCancelAction();
		if (this.#assignmentPending) return [cancel];
		if (this.#filterEditing) return [pickerAction("searchConfirm", "Search", "enter", { primary: true }), cancel];
		if (strip) {
			const apply =
				strip.kind === "name"
					? strip.purpose === "compaction"
						? pickerAction(
								"compactionPoint",
								compactionConfirmPending(strip) ? "Accept compaction point" : "Set compaction point",
								"enter",
								{ primary: true },
							)
						: pickerAction(
								strip.purpose === "description" || strip.purpose === "roleBudget"
									? "roleDescription"
									: strip.purpose === "preset"
										? "presetName"
										: "roleName",
								strip.purpose === "description"
									? "Save description"
									: strip.purpose === "roleBudget"
										? "Save token budget"
										: strip.purpose === "preset"
											? "Save preset"
											: "Create role",
								"enter",
								{ primary: true },
							)
					: pickerAction(
							"stripApply",
							strip.kind === "thinking" || strip.kind === "patternEffort"
								? "Apply"
								: strip.kind === "scope"
									? "Save to scope"
									: strip.kind === "effortLevels"
										? "Save efforts"
										: strip.kind === "pattern"
											? this.#contextRulesView()
												? "Continue to limit"
												: "Continue to effort"
											: strip.kind === "selectorChoice"
												? "Select"
												: "Assign / clear",
							"enter",
							{ primary: true },
						);
			return [apply, cancel];
		}
		const facts =
			!this.#sessionOnly && !this.#filterEditing && this.#callbacks.onEditFacts
				? pickerAction("modelFacts", "Model facts", "f6")
				: undefined;
		const refresh =
			entry.kind === "provider" && !entry.locked ? pickerAction("refresh", "Refresh provider", "f5") : undefined;
		if (this.#assigning !== null) {
			const label =
				this.#assigning.kind === "fallback"
					? "Pick fallback"
					: this.#assigning.kind === "fallbackKey"
						? "Pick protected model"
						: this.#assigning.kind === "effortRule"
							? "Pick rule model"
							: "Assign";
			return compact([pickerAction("assign", label, "enter", { primary: true }), refresh, cancel]);
		}
		if (rolesView) {
			const row = this.#rolesRows[this.#roleIndex];
			// Only the focused search owns printable keys.
			const searching = this.#filterEditing;
			const roleAction = (action: RolesAction, label: string, key: string, primary = false) =>
				pickerAction(
					`roles:${action}`,
					label,
					searching && key !== "enter" ? undefined : key,
					primary ? { primary: true } : undefined,
				);
			const actions: (TspPickerAction | undefined)[] = [];
			const compaction =
				this.#callbacks.onCompactionPointChange && this.#roleRowModel()
					? roleAction("compaction", "Compaction limit", "m")
					: undefined;
			switch (row?.kind) {
				case "role": {
					const assigned = this.#roles[row.role];
					actions.push(
						roleAction("pick", "Pick model", "enter", true),
						this.#callbacks.onRoleDescriptionChange
							? roleAction("description", "Description", "shift+d")
							: undefined,
						this.#callbacks.onRoleTokenBudgetChange ? roleAction("budget", "Token budget", "b") : undefined,
						roleAction("fallback", "Add fallback", "f"),
						assigned && !assigned.autoSelected ? roleAction("clear", "Clear", "x") : undefined,
						this.#roleThinkingTarget(row.role) ? roleAction("thinking", "Thinking", "t") : undefined,
						compaction,
						roleAction("cycle", this.#cycleOrder().includes(row.role) ? "Leave cycle" : "Add to cycle", "c"),
						roleAction("new", "New role", "n"),
						this.#callbacks.onSavePreset ? roleAction("save", "Save preset", "s") : undefined,
						this.#presets().names.length > 0 ? roleAction("nextPreset", "Next preset", "ctrl+right") : undefined,
					);
					break;
				}
				case "fallback":
					actions.push(
						roleAction("pick", "Replace", "enter", true),
						roleAction("fallback", "Add another", "f"),
						roleAction("clear", "Remove", "x"),
						this.#resolveFallbackEntry(row.role, row.chainIndex)
							? roleAction("thinking", "Thinking", "t")
							: undefined,
						compaction,
						roleAction("earlier", "Earlier", "["),
						roleAction("later", "Later", "]"),
					);
					break;
				case "chainKey":
					actions.push(roleAction("pick", "Add fallback", "enter", true), roleAction("clear", "Clear chain", "x"));
					break;
				case "newFallback":
					actions.push(roleAction("pick", "New fallback chain", "enter", true));
					break;
				case "newRole":
					actions.push(roleAction("pick", "New role", "enter", true));
					break;
			}
			return compact([
				...actions,
				this.#rolesSearch.value ? pickerAction("clear", "Clear search") : undefined,
				facts,
				cancel,
			]);
		}
		if (lockedView) {
			return compact([
				entry.oauth ? pickerAction("login", "Log in", "enter", { primary: true }) : undefined,
				facts,
				cancel,
			]);
		}
		return compact([
			pickerAction(
				"assign",
				this.#sessionOnly ? "Use for session" : "Assign role",
				"enter",
				this.#browser.pickerSelected ? { primary: true } : { primary: true, disabled: "No model selected" },
			),
			refresh,
			facts,
			this.#browser.query.length > 0 ? pickerAction("clear", "Clear search") : undefined,
			cancel,
		]);
	}

	/** The open strip as the picker's chip strip (role assignment, save scope, thinking level, new role name). */
	#pickerStrip(strip: StripState): NonNullable<TspPickerProps["strip"]> {
		if (strip.kind === "name" || strip.kind === "pattern") {
			if (strip.kind === "name" && strip.purpose === "compaction") {
				const notice = compactionNotice(strip, this.#callbacks.previewCompactionPoint);
				return {
					label: [
						span(strip.model.id, "mono"),
						span(" limit ", "muted"),
						span(strip.input.getValue(), "mono"),
						span("▏", "accent"),
						span(`  ${notice.text}`, notice.style),
					],
					items: [],
				};
			}
			return {
				label: [
					span(
						strip.kind === "name"
							? strip.purpose === "contextRule"
								? `${strip.selector} limit `
								: strip.purpose === "roleBudget"
									? `${strip.role} token budget `
								: strip.purpose === "description"
									? `${strip.role} description `
									: strip.purpose === "preset"
										? "Preset name "
										: "New role name "
							: strip.target === "rule"
								? `Model ${this.#contextRulesView() ? "context" : "effort"} pattern `
								: strip.target === "role"
									? "Role model pattern "
									: "Fallback model pattern ",
						"muted",
					),
					span(strip.input.getValue(), "mono"),
					span("▏", "accent"),
				],
				items: [],
			};
		}
		if (strip.kind === "effortLevels") {
			return {
				label: [span(strip.pendingRuleSelector ?? strip.selector ?? strip.item?.id ?? "Effort", "accent")],
				items: strip.toggle.options.map((level, index) => ({
					id: String(index),
					label: level,
					on: strip.toggle.selected.has(level),
				})),
				selected: String(strip.index),
			};
		}
		if (strip.kind === "selectorChoice" || strip.kind === "patternEffort") {
			return {
				label: [span(this.#selectorStripLabel(strip), "accent")],
				items: strip.chips.map((chip, index) => ({ id: String(index), label: chip.label })),
				selected: String(strip.index),
			};
		}
		let label: TspSpan[];
		if (strip.kind === "role") {
			// The second step of "New fallback chain…" reuses the role strip with key chips only.
			const keyStrip = strip.chips.every(chip => chip.label.startsWith("for "));
			label = keyStrip
				? [span("New fallback chain", "muted")]
				: [span("Assign ", "muted"), span(strip.item.id, "mono"), span(" to", "muted")];
		} else {
			const info = this.#settings.getRoleInfo(strip.role ?? "");
			const roleLabel = (info.tag ?? strip.role ?? "").toLowerCase();
			label = [
				span(strip.kind === "thinking" ? "Thinking for " : "Save ", "muted"),
				span(roleLabel, "strong"),
				span(" · ", "muted"),
				span(strip.item.id, "mono"),
				...(strip.kind === "scope" ? [span(" to", "muted")] : []),
			];
		}
		return {
			label,
			items: strip.chips.map((chip, index) => {
				const assigned = chip.role ? this.#roles[chip.role] : undefined;
				const level =
					chip.action === "thinking"
						? chip.thinkingLevel
						: chip.action === "unassign" && assigned && !assigned.autoSelected
							? assigned.thinkingLevel
							: undefined;
				const dot = level !== undefined ? thinkingDotToken(level) : undefined;
				const on =
					chip.action === "unassign" ||
					(strip.kind === "thinking" &&
						chip.thinkingLevel !== undefined &&
						chip.thinkingLevel === strip.initialThinkingLevel);
				return { id: String(index), label: chip.label, ...(on ? { on: true } : {}), ...(dot ? { dot } : {}) };
			}),
			selected: String(strip.index),
		};
	}

	/** Roles-view rows as picker items; rebuilt only when the rows, roles or cycle change. */
	#rolePickerItems(): readonly TspPickerItem[] {
		const cycleOrder = this.#cycleOrder();
		const cycle = cycleOrder.join("\0");
		const memo = this.#pickerRoleItems;
		const revision = this.#settings.revision;
		if (
			memo?.rows === this.#rolesRows &&
			memo.roles === this.#roles &&
			memo.cycle === cycle &&
			memo.revision === revision
		)
			return memo.items;
		const items: TspPickerItem[] = [];
		this.#rolesRows.forEach((row, index) => {
			const id = rolesRowKey(row, index);
			switch (row.kind) {
				case "separator":
					return;
				case "newRole":
					items.push({ id, label: "New role…", icon: "plus", tone: "muted" });
					return;
				case "newFallback":
					items.push({ id, label: "New fallback chain…", icon: "plus", tone: "muted" });
					return;
				case "chainKey":
					items.push({ id, label: row.role, mono: true, icon: "git-branch", detail: "fallback chain" });
					return;
				case "fallback": {
					const model = this.#resolveFallbackEntry(row.role, row.chainIndex)?.item.model;
					const limit = model && this.#settings.compactionPointFor?.(model)?.limit;
					items.push({
						id,
						label: row.selector,
						mono: true,
						depth: 1,
						detail: `fallback ${row.chainIndex + 1}`,
						...(limit ? { facts: { compaction: `compact ${limit}` } } : {}),
					});
					return;
				}
				case "role":
					break;
			}
			const info = this.#settings.getRoleInfo(row.role);
			const tag = (info.tag ?? info.name ?? row.role) + uiProvenanceSuffix("roles", row.role);
			const assignment = this.#roles[row.role];
			const facts: Record<string, string> = {};
			const budget = this.#settings.getRoleTokenBudget?.(row.role);
			if (budget !== undefined) facts.budget = String(budget);
			if (assignment) {
				const selector = `${assignment.model.provider}/${assignment.model.id}`;
				facts.model = assignment.autoSelected ? `auto → ${selector}` : selector;
				if (assignment.thinkingLevel !== ThinkingLevel.Inherit) {
					facts.thinking = getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label;
				}
				const limit = this.#settings.compactionPointFor?.(assignment.model)?.limit;
				if (limit) facts.compaction = `compact ${limit}`;
			} else {
				facts.model = "—";
			}
			const cycleIndex = cycleOrder.indexOf(row.role);
			items.push({
				id,
				label: tag,
				detail: [info.name && info.name !== (info.tag ?? info.name ?? row.role) ? info.name : "", this.#settings.getRoleScopeNote?.(row.role) ?? ""].filter(Boolean).join(" · "),
				facts,
				...(assignment && !assignment.autoSelected ? {} : { tone: "muted" as const }),
				...(cycleIndex >= 0
					? {
							badges: [
								{
									text: `cycle ${cycleIndex + 1}`,
									tone: "accent" as const,
									title: `Stop ${cycleIndex + 1} of the quick-switch cycle`,
								},
							],
						}
					: {}),
			});
		});
		this.#pickerRoleItems = { rows: this.#rolesRows, roles: this.#roles, cycle, revision, items };
		return items;
	}

	/** Roles-view order: the separators become group heads (chat roles, kind roles, model fallback chains). */
	#rolePickerOrder(): (string | TspPickerGroup)[] {
		const order: (string | TspPickerGroup)[] = [];
		let head: { group: string; label: string; count: number } | undefined;
		const open = (group: string, label: string) => {
			head = { group, label, count: 0 };
			order.push(head);
		};
		open(this.#roleTab === "kind" ? "kind" : "chat", this.#roleTab === "kind" ? "Kind roles" : "Chat roles");
		this.#rolesRows.forEach((row, index) => {
			if (row.kind === "separator") {
				const previous = this.#rolesRows[index - 1];
				if (previous?.kind === "newRole") open("chains", "Model fallback chains");
				else open("kind", "Kind roles");
				return;
			}
			order.push(rolesRowKey(row, index));
			// Heads count roles and chains, not their fallback entries or the "new" rows.
			if (head && (row.kind === "role" || row.kind === "chainKey")) head.count++;
		});
		return order;
	}

	/** The selected Roles-view row's preview: its model's facts and its fallback chain. */
	#rolePreview(row: RolesRow | undefined): readonly NativeChild[] {
		const memo = this.#pickerRolePreview;
		const revision = this.#settings.revision;
		if (
			memo !== undefined &&
			memo.row === row &&
			memo.roles === this.#roles &&
			memo.rows === this.#rolesRows &&
			memo.revision === revision
		) {
			return memo.children;
		}
		const children: NativeChild[] = [];
		const chainList = (key: string): NativeChild | undefined => {
			const chain = this.#fallbackChains()[key] ?? [];
			if (chain.length === 0) return undefined;
			return node("section", { head: "Fallback chain" }, [
				md(chain.map((selector, index) => `${index + 1}. \`${selector}\``).join("\n")),
			]);
		};
		const modelItem = (model: Model): ModelBrowserItem => ({
			provider: model.provider,
			id: model.id,
			model,
			selector: `${model.provider}/${model.id}`,
		});
		switch (row?.kind) {
			case "role": {
				const info = this.#settings.getRoleInfo(row.role);
				const assignment = this.#roles[row.role];
				if (assignment) {
					children.push(...this.#browser.modelPreview(modelItem(assignment.model), "full", this.#currentSelector));
					children.push(
						node("kv", {
							items: [
								{ k: [span("Role", "muted")], v: info.name },
								{
									k: [span("Thinking", "muted")],
									v: getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label,
								},
								{ k: [span("Source", "muted")], v: assignment.autoSelected ? "auto-selected" : "configured" },
							],
						}),
					);
				} else {
					children.push(
						text(info.name, { role: "omp.picker.title" }),
						text([span("Not assigned; no available model fits this role.", "muted")], { wrap: "word" }),
					);
				}
				const chain = chainList(row.role);
				if (chain) children.push(chain);
				break;
			}
			case "fallback": {
				const resolved = this.#resolveFallbackEntry(row.role, row.chainIndex);
				if (resolved) children.push(...this.#browser.modelPreview(resolved.item, "full", this.#currentSelector));
				else children.push(text([span(row.selector, "mono")], { role: "omp.picker.title" }));
				const chain = chainList(row.role);
				if (chain) children.push(chain);
				break;
			}
			case "chainKey": {
				children.push(text([span(row.role, "mono")], { role: "omp.picker.title" }));
				const chain = chainList(row.role);
				if (chain) children.push(chain);
				break;
			}
			case "newRole":
				children.push(
					text("New role", { role: "omp.picker.title" }),
					text([span("Name a custom role, then pick the model it runs on.", "muted")], { wrap: "word" }),
				);
				break;
			case "newFallback":
				children.push(
					text("New fallback chain", { role: "omp.picker.title" }),
					text([span("Pick the model (or provider) a new retry fallback chain protects.", "muted")], {
						wrap: "word",
					}),
				);
				break;
		}
		this.#pickerRolePreview = { row, roles: this.#roles, rows: this.#rolesRows, revision, children };
		return children;
	}

	#lockedMessage(entry: SidebarEntry): string {
		const envVars = entry.providerId ? (providerEntry(entry.providerId)?.envVars ?? []) : [];
		const how =
			envVars.length > 0
				? `Set ${envVars.join(" or ")} in your environment, or add a key in config.`
				: "Add an API key for this provider in config.";
		return `${entry.label} has no credentials configured. ${how}`;
	}

	/** A signed-out provider's preview: how to sign in and what its catalog holds. */
	#lockedPreview(entry: SidebarEntry): readonly NativeChild[] {
		const children: NativeChild[] = [
			text(entry.label, { role: "omp.picker.title" }),
			text([span(this.#lockedMessage(entry), "muted")], { wrap: "word" }),
		];
		const catalogCount = entry.catalogCount ?? 0;
		if (catalogCount > 0 && this.#scopedModels.length === 0) {
			const ids: string[] = [];
			for (const model of this.#registry.getAll("all")) {
				if (model.provider === entry.providerId) ids.push(`- \`${model.id}\``);
			}
			children.push(node("section", { head: `${catalogCount} models in catalog` }, [md(ids.join("\n"))]));
		}
		return children;
	}

	/** Picker pointer events, each on the path of the key it stands for. */
	#handlePickerEvent(event: PickerEvent): void {
		if (event.kind === "action" && event.act === CLOSE_ACTION.id) {
			this.#cancel();
			return;
		}
		// Same gate as the keys: only cancel works while an assignment applies.
		if (this.#assignmentPending) return;
		if (this.#filterEditing) {
			if (
				event.kind === "activate" ||
				(event.kind === "action" && ["searchConfirm", "assign", "roles:pick", "effort:edit"].includes(event.act))
			) {
				this.#handleInput("\r");
			}
			return;
		}
		const entry = this.#activeEntry();
		const rolesView = entry.kind === "roles" && this.#assigning === null;
		if (event.kind !== "action") {
			if (this.#strip) return;
			if (entry.kind === "effort" && this.#assigning === null) {
				const index = Number(event.item.slice("effort:".length));
				if (
					!event.item.startsWith("effort:") ||
					!Number.isInteger(index) ||
					!this.#syncEffortSelection().includes(index)
				)
					return;
				this.#focus = "list";
				this.#effortIndex = index;
				if (event.kind === "activate") this.#handleEffortRulesInput("\r");
				return;
			}
			if (rolesView) {
				const index = this.#rolesRows.findIndex((row, i) => rolesRowKey(row, i) === event.item);
				const row = this.#rolesRows[index];
				if (!row || row.kind === "separator") return;
				this.#focus = "list";
				this.#roleIndex = index;
				if (event.kind === "activate") this.#activateRolesRow(row);
				return;
			}
			if (this.#isBrowserView(entry) && this.#browser.routePickerItem(event.item, event.kind === "activate")) {
				this.#focus = "list";
			}
			return;
		}
		const { act, value } = event;
		if (act.startsWith("roles:")) {
			const action = act.slice("roles:".length) as RolesAction;
			if (!rolesView || this.#strip) return;
			this.#focus = "list";
			this.#runRolesAction(action);
			return;
		}
		switch (act) {
			case "effort:edit":
			case "effort:remove":
				if (entry.kind === "effort" && this.#assigning === null) {
					this.#focus = "list";
					this.#handleEffortRulesInput(act === "effort:edit" ? "\r" : "x");
				}
				return;
			case "scope":
				this.#clickSidebarEntry(this.#entries.find(candidate => candidate.id === value));
				return;
			case "tab":
				if (rolesView) {
					const tab = ROLE_TABS.find(candidate => candidate === value);
					if (!tab) return;
					this.#roleTab = tab;
					this.#roleIndex = 0;
					this.#roleViewport.setTop(0);
					this.#buildRolesRows();
				} else {
					const kind = MODEL_KIND_TABS.find(candidate => candidate === value);
					if (!kind) return;
					this.#modelKindTab = kind;
					this.#applyModelKind();
				}
				return;
			case "strip": {
				const strip = this.#strip;
				const index = Number(value);
				if (!strip || !Number.isInteger(index)) return;
				if (strip.kind === "effortLevels") {
					const level = strip.toggle.options[index];
					if (!level) return;
					strip.index = index;
					strip.toggle.toggle(level);
					this.#configError = undefined;
				} else {
					if (strip.kind === "name" || strip.kind === "pattern" || !strip.chips[index]) return;
					strip.index = index;
					if (strip.kind === "selectorChoice") this.#activateSelectorChoice(strip);
					else this.#activateStripChip();
				}
				return;
			}
			case "stripApply": {
				const strip = this.#strip;
				if (strip?.kind === "pattern") this.#submitSelectorPattern(strip);
				else if (strip?.kind === "effortLevels") this.#confirmEffortLevels(strip);
				else if (strip?.kind === "selectorChoice") this.#activateSelectorChoice(strip);
				else this.#activateStripChip();
				return;
			}
			case "roleName":
				this.#submitRoleName();
				return;
			case "presetName":
				this.#submitPresetName();
				return;
			case "roleDescription":
				this.#submitNameStrip();
				return;
			case "compactionPoint":
				this.#submitNameStrip();
				return;
			case "cancel":
				if (this.#strip) this.#cancel();
				return;
			case "clear":
				if (entry.kind === "roles" && this.#assigning === null) {
					this.#rolesSearch.setValue("");
					this.#buildRolesRows();
					this.#roleViewport.reveal();
				} else if (entry.kind === "effort" && this.#assigning === null) {
					this.#effortSearch.setValue("");
					this.#syncEffortSelection();
					this.#effortViewport.reveal();
				} else {
					this.#browser.setQuery("");
					this.#onQueryChanged("");
				}
				return;
			case "assign": {
				if (this.#strip || !this.#isBrowserView(entry)) return;
				const selected = this.#browser.pickerSelected;
				if (!selected) return;
				this.#focus = "list";
				this.#browser.routePickerItem(selected, true);
				return;
			}
			case "modelFacts":
				this.#editFacts();
				return;
			case "refresh":
				if (entry.kind === "provider" && !entry.locked) {
					this.#scheduleProviderRefresh(entry.providerId ?? "", { force: true });
				}
				return;
			case "login":
				if (entry.kind === "provider" && entry.locked && this.#assigning === null) this.#requestLogin(entry);
				return;
		}
	}

	/** Footer chip labels, built from each chip's action instead of its ANSI rendering. */
	#chipSpans(chip: StripChip): TspSpan[] {
		switch (chip.action) {
			case "assign":
			case "unassign": {
				const color = this.#settings.getRoleInfo(chip.role ?? "").color ?? "muted";
				return chip.action === "unassign"
					? [span(`${theme.status.enabled} ${chip.label}`, color), span(` ${theme.status.success}`, "dim")]
					: [span(chip.label, color)];
			}
			case "scope":
				return [span(chip.label, chip.scope === "global" ? "accent" : "muted")];
			case "thinking": {
				const glyph = chip.thinkingLevel === undefined ? "" : thinkingLevelGlyph(chip.thinkingLevel, theme);
				return glyph ? [span(glyph, "accent"), span(` ${chip.label}`)] : [span(chip.label)];
			}
			default:
				return [span(plainText(chip.styled), "muted")];
		}
	}

	#describeStrip(): NativeNode | undefined {
		const strip = this.#strip;
		if (!strip) return undefined;
		if (strip.kind === "name") {
			if (strip.purpose === "compaction") {
				const notice = compactionNotice(strip, this.#callbacks.previewCompactionPoint);
				return node(
					"row",
					{ gap: "sm", align: "center" },
					[
						text([span(`${strip.model.id} limit:`, "accent")]),
						col([strip.input], { grow: 1 }),
						text([span(notice.text, notice.style)], { wrap: "word" }),
					],
					"compactionPoint",
				);
			}
			if (strip.purpose === "roleBudget") {
				return row([
					text([span(`${strip.role} token budget:`, "accent")]),
					col([strip.input], { grow: 1 }),
					text([span("Positive tokens; empty inherits", "dim")]),
				]);
			}
			if (strip.purpose === "description") {
				return row([text([span(`${strip.role} description:`, "accent")]), col([strip.input], { grow: 1 })]);
			}
			const preset = strip.purpose === "preset";
			return node(
				"row",
				{ gap: "sm", align: "center" },
				[
					text([
						span(
							preset
								? "Preset name:"
								: strip.purpose === "contextRule"
									? `${strip.selector} limit:`
									: "New role name:",
							"accent",
						),
					]),
					col([strip.input], { grow: 1 }),
					text([
						span(
							strip.purpose === "contextRule"
								? "400k base · f400k fixed · 80% · empty resets"
								: "(letters, digits, - and _)",
							"dim",
						),
					]),
				],
				preset ? "presetName" : "roleName",
			);
		}
		if (strip.kind === "pattern") {
			return row([
				text([
					span(
						strip.target === "rule"
							? `Model ${this.#contextRulesView() ? "context" : "effort"} pattern:`
							: strip.target === "role"
								? "Role model pattern:"
								: "Fallback model pattern:",
						"accent",
					),
				]),
				col([strip.input], { grow: 1 }),
			]);
		}
		if (strip.kind === "effortLevels") {
			return node(
				"tabs",
				{
					items: strip.toggle.options.map((level, index) => ({
						id: String(index),
						label: [
							span(
								strip.toggle.selected.has(level) ? "● " : "○ ",
								strip.toggle.selected.has(level) ? "success" : "dim",
							),
							span(level),
						],
					})),
					active: String(strip.index),
					actions: { click: "activate" },
				},
				undefined,
				"strip",
			);
		}
		let prefix: TspSpan[];
		if (strip.kind === "selectorChoice" || strip.kind === "patternEffort") {
			prefix = [span(this.#selectorStripLabel(strip), "accent"), span(" →", "dim")];
		} else if (strip.kind === "role") {
			prefix = [span(strip.item.id, "accent"), span(" →", "dim")];
		} else {
			const info = this.#settings.getRoleInfo(strip.role ?? "");
			prefix = [
				span((info.tag ?? strip.role ?? "").toLowerCase(), info.color ?? "muted"),
				span(` · ${strip.item.id} →`, "dim"),
			];
		}
		return node(
			"row",
			{ gap: "sm", align: "center" },
			[
				text(prefix),
				node(
					"tabs",
					{
						items: strip.chips.map((chip, index) => ({ id: String(index), label: this.#chipSpans(chip) })),
						active: String(strip.index),
						actions: { click: "activate" },
					},
					undefined,
					"strip",
				),
			],
			"chips",
		);
	}

	#footerHints(): NativeHint[] {
		return [{ keys: [], label: plainText(this.#footerHint()) }];
	}
}
