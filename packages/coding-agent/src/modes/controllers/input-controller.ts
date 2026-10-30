import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	type AutocompleteProvider,
	BRACKETED_PASTE_END,
	BRACKETED_PASTE_START,
	type Component,
	Editor,
	emergencyTerminalRestore,
	isKeyRelease,
	isKeyRepeat,
	type KeyId,
	matchesKey,
	parseKey,
	parseSgrMouse,
	type PasteOptions,
	type SlashCommand,
} from "@oh-my-pi/pi-tui";
import { getAgentDir, isEnoent, logger, postmortem, sanitizeText } from "@oh-my-pi/pi-utils";
import { formatDoubleTap } from "@oh-my-pi/pi-tui/app-keybindings";
import { appKey, editorKey } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { currentDeferredDraft, runWithoutDetachedDraft } from "@oh-my-pi/pi-tui/draft-scope";
import type { ChainConfig } from "@oh-my-pi/pi-tui/overlays/chain-types";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme";
import { discoverChains } from "../../chains/config";
import { EscapeGesture } from "../../chains/escape-gesture";
import { ChainControl, enabledChainSteps, runChain } from "../../chains/runner";
import { formatModelRoleAlias, roleCandidatePool } from "../../config/model-roles";
import { resolveModelRoleValue } from "../../config/model-resolver";
import { isSettingsInitialized, settings } from "../../config/settings";
import { InternalUrlRouter, resolveLocalRoot } from "../../internal-urls";
import { isReservedKey } from "@oh-my-pi/pi-tui/app-keybindings";
import { ApprovalDialogComponent } from "@oh-my-pi/pi-tui/overlays/approval-dialog";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { extractImagePathFromText } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { HistorySearchComponent } from "@oh-my-pi/pi-tui/overlays/history-search";
import { HookEditorComponent } from "@oh-my-pi/pi-tui/overlays/hook-editor";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TreeSelectorComponent } from "@oh-my-pi/pi-tui/overlays/tree-selector";
import {
	chipLabel,
	compactImageMarkers,
	formatVisionMarker,
	shiftImageMarkers,
} from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { expandEmoticons } from "@oh-my-pi/pi-tui/prompt/emoji-autocomplete";
import { setCachedImageDimensions } from "@oh-my-pi/pi-tui/prompt/image-references";
import { createPromptActionAutocompleteProvider } from "@oh-my-pi/pi-tui/prompt/prompt-action-autocomplete";
import { createModelMentionSource } from "@oh-my-pi/pi-tui/prompt/model-mention-autocomplete";
import { createModelBrowserSource } from "../model-browser-source";
import { parseQueueShorthand, splitQueuedMessages } from "@oh-my-pi/pi-tui/prompt/queue-input";
import { invokeSkillCommandFromText, isKnownSkillCommand } from "../../modes/skill-command";
import { parseFileSlashInvocation, renderFileSlashCommand } from "../../extensibility/slash-commands";
import type { InteractiveModeContext, SubmittedUserInput } from "../../modes/types";
import { isDeferredSubmissionActive, waitForDeferredInput } from "../../neopi/defer";
import type { LiveSubmitRoute } from "./live-command-controller";
import { openLocalFileInEditor } from "../local-file-editor";
import { AgentRegistry } from "../../registry/agent-registry";
import { cycleSubagentThinkingLevel, runSubagentFastCommand } from "../../registry/subagent-controls";
import type { RestoredQueuedMessage } from "../../session/agent-session-types";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { PINNED_HUD_TOGGLE_ID } from "../../task/output-manager";
import { pickRecentFocusableAgentId } from "./session-focus-controller";
import type { SidePanelView } from "./side-panel-controller";
import { executeBuiltinSlashCommand, lookupBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import { restoreDetachedDraft } from "../../slash-commands/helpers/draft";
import { parseSlashCommand, parseSubcommand } from "../../slash-commands/helpers/parse";
import { isTinyLocalModelKey } from "../../tiny/models";
import { tinyTitleClient } from "../../tiny/title-client";
import { resolveReadPath } from "../../tools/path-utils";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { vocalizer } from "../../tts/vocalizer";
import {
	copyToClipboard,
	isClipboardTerminalLocal,
	readImageFromClipboard,
	readMacFileUrlsFromClipboard,
	readTextFromClipboard,
} from "../../utils/clipboard";
import { commandUsage, hintUsage } from "../../utils/usage-counter";
import { EnhancedPasteController } from "../../utils/enhanced-paste";
import {
	extractExternalEditorMessage,
	formatExternalEditorDraft,
	withExternalEditor,
	openInEditor,
} from "../../utils/external-editor";
import { resendProgramStatus } from "../../utils/run-status";
import { loadImageInput } from "../../utils/image-loading";
import { materializeImageChipLinks } from "../utils/ui-helpers";
import { ensureSupportedImageInput, ImageInputTooLargeError } from "@oh-my-pi/pi-tui/chat/image-loading";
import { type ImageAttachmentSource, tagImageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { blobExtensionForImageMimeType } from "@oh-my-pi/pi-tui/prompt/image-format";
import { VideoError, buildVideoContactSheetPng, probeVideo } from "../../utils/video";
import { isVideoPath } from "@oh-my-pi/pi-tui/prompt/video";
import { resizeImage } from "../../utils/image-resize";
import { findUnknownSlashCommand } from "../utils/unknown-slash-command";
import { isReplBypass } from "../../neopi/repl";
import { parseReplEvalInput } from "./repl-input";

import { cfgCycleOrder } from "../../config/model-settings";
import {
	cfgBareExitOnEmptySession,
	cfgBareSlashCommands,
	cfgDisplayHideToolActivity,
	cfgDoubleEscapeAction,
	cfgEmojiAutocomplete,
	cfgImagesAutoResize,
	cfgPasteLargeMenuThreshold,
	cfgTuiMouse,
} from "../settings";
import { cfgHideThinkingBlock } from "../../session/settings";
import { cfgChainingActive, cfgChainingAuto } from "../../chains/settings";

/** Bare words that quit (as `/<word>`) when typed alone into a session with no messages. */
const BARE_EXIT_WORDS: Record<string, true> = { exit: true, quit: true, q: true };

const REMOTE_CLIPBOARD_STATUS =
	"Clipboard here belongs to the SSH host — use your terminal's paste shortcut to paste from your machine";

/**
 * Slash commands that may carry secrets in their arguments should never be
 * persisted to history.
 *
 * - /login accepts three callback forms (redirect URL, query string, raw auth
 *   code) — all can contain OAuth code=/state= params.
 * - /join <link> carries a 32-byte room key and optional write token.
 * - /mcp add --token <token> carries a bearer token.
 *
 * The command name is extracted the same way as parseSlashCommand() — splitting
 * on the earliest whitespace or colon — so /login:?code=... is correctly matched.
 */
export function shouldSkipHistory(slashText: string): boolean {
	if (!slashText.startsWith("/")) return false;
	const body = slashText.slice(1);
	// Match parseSlashCommand: split on earliest whitespace or colon.
	const firstWs = body.search(/\s/);
	const firstColon = body.indexOf(":");
	const sep = firstWs === -1 ? firstColon : firstColon === -1 ? firstWs : Math.min(firstWs, firstColon);
	const name = sep === -1 ? body : body.slice(0, sep);
	const hasArgs = sep !== -1;
	// /login <anything> — parseCallbackInput() accepts redirect URLs, query
	// strings (?code=...), and raw auth codes, all of which carry secrets.
	if (name === "login" && hasArgs) return true;
	// /join <link> — the link carries the 32-byte room key and write token.
	if (name === "join" && hasArgs) return true;
	if (name === "mcp") {
		const args = body.slice(sep + 1).trim();
		return args.startsWith("add") && /--token\s/.test(args);
	}
	return false;
}

interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

/** Minimal contract for any component that can receive a paste payload directly. */
interface PasteTarget {
	pasteText(text: string): void;
	/** Reserve delivery before an async clipboard read; undefined releases it without text. */
	beginPaste?(): (text: string | undefined) => boolean;
	/** The prompt accepts pasted images (the ask dialog's answer and note editors). */
	acceptsImages?: boolean;
	/** Attach an image; returns the marker to deliver as pasted text. */
	attachImage?(image: ImageContent, dims?: { width: number; height: number }): string | undefined;
}

/** Where a pasted image lands: the main editor's attachments, or a prompt that opted into images. */
interface ImagePasteSink {
	attach(image: ImageContent, unsupportedMessage: string, sourcePath?: string): Promise<boolean>;
	pasteText(text: string): void;
	/** Main editor only; without it a video path lands as text. */
	attachVideo?(path: string): Promise<void>;
}

/** One paste into an image-accepting prompt; `finish` delivers what it collected, in order. */
interface PromptImagePaste {
	sink: ImagePasteSink;
	finish(): void;
}

function hasPasteText(value: unknown): value is PasteTarget {
	return typeof value === "object" && value !== null && typeof (value as PasteTarget).pasteText === "function";
}

/**
 * Slash commands that also run from a focused subagent view, keyed by canonical name to
 * a check on their arguments: viewer-scoped reads and effort controls for the
 * focused agent. Every other command (and mutating forms such
 * as `/usage reset`, which spends a saved rate-limit reset, or `/jobs kill`, which cancels
 * a running job) still needs the main session.
 */
const FOCUSED_VIEW_COMMANDS: Record<string, (args: string) => boolean> = {
	btw: () => true,
	effort: () => true,
	export: () => true,
	jobs: args => {
		const { verb, rest } = parseSubcommand(args);
		return !verb || (verb === "full" && !rest);
	},
	usage: args => {
		const { verb, rest } = parseSubcommand(args);
		return !verb || (verb === "show" && !rest);
	},
};
const FOCUSED_VIEW_COMMAND_LIST = ["/fast", ...Object.keys(FOCUSED_VIEW_COMMANDS).map(name => `/${name}`)].join(", ");

/** Commands whose handler owns the submitted draft, images included: Enter takes it out of the editor first. */
const DETACHED_DRAFT_COMMANDS = new Set([
	"plan",
	"vibe",
	"goal",
	"guided-goal",
	"tan",
	"btw",
	"omfg",
	"handoff",
	"cleanse",
]);

/** Wrap pasted text in `<attachment>` tags so the model treats it as one quoted block. */
function wrapPasteInAttachmentBlock(content: string): string {
	return `<attachment>\n${content}\n</attachment>`;
}

/** Run a teardown abort that must never throw (Esc / Ctrl+C path). A thrown
 *  error is logged at debug instead of silently swallowed, so a failing abort
 *  stays diagnosable without disturbing teardown ordering. */
function safeAbort(label: string, fn: () => void): void {
	try {
		fn();
	} catch (err) {
		logger.debug(`Failed to abort ${label}`, { error: err instanceof Error ? err.message : String(err) });
	}
}

// Double-tap ← on an empty editor opens the Agent Hub (and, in a focused
// subagent view, ←← returns to the main session). The second tap must land
// inside this window. The lower bound rejects terminal-synthesized arrow-key
// bursts: "click to move cursor" / pointer features in iTerm2, WezTerm, kitty,
// and tmux emit several arrow keys in a single stdin read (sub-millisecond
// apart) on a stray click, which used to pop the hub with no key ever pressed.
// Three or more rapid taps are likewise treated as a burst, not a gesture. A
// deliberate human double-tap is always tens of milliseconds apart.
/** Status when a submit holds because a voice handoff of the same speech just landed. */
const LIVE_HANDOFF_HOLD_STATUS = "A voice handoff just reached the main agent; review the draft before sending";
const LEFT_DOUBLE_TAP_MIN_GAP_MS = 40;
const LEFT_DOUBLE_TAP_MAX_GAP_MS = 500;
/** How long `app.sidebar.toggle` waits for the view key before the chord lapses. */
const SIDEBAR_CHORD_TIMEOUT_MS = 2000;
/** View keys after the chord prefix; the alt form works while the modifier is still held. */
const SIDEBAR_CHORD_KEYS: readonly (readonly [SidePanelView, readonly KeyId[]])[] = [
	["todo", ["t", "alt+t"]],
	["agents", ["a", "alt+a"]],
	["irc", ["i", "alt+i"]],
];

/** Chain step outputs longer than this show as a collapsed paste chip while the lock holds them. */
const CHAIN_DISPLAY_COLLAPSE_CHARS = 8_000;
/** Picker entry that sends the prompt unchanged. */
const SEND_WITHOUT_CHAIN = "Send without a chain";

export class InputController {
	constructor(
		private ctx: InteractiveModeContext,
		/** Injectable clipboard reads so tests can drive paste flows without a real clipboard. */
		private clipboard: {
			readImage: typeof readImageFromClipboard;
			readText: typeof readTextFromClipboard;
			readMacFileUrls?: typeof readMacFileUrlsFromClipboard;
			/** False when the readable clipboard is not the terminal's (SSH); omitted means local. */
			isTerminalLocal?: typeof isClipboardTerminalLocal;
		} = {
			readImage: readImageFromClipboard,
			readText: readTextFromClipboard,
			readMacFileUrls: readMacFileUrlsFromClipboard,
			isTerminalLocal: isClipboardTerminalLocal,
		},
	) {}

	/** Set by the chain keybinding: the next submit runs through the active chain. */
	#chainNextSubmit = false;
	/** Set by `app.repl.execute` so the next submit runs in the REPL kernel. */
	#replNextSubmit = false;

	/** Resolve the title role at use time so project/session reloads cannot leave a stale model. */
	#resolveTitleLocalModelKey(): string | undefined {
		const model = resolveModelRoleValue(
			formatModelRoleAlias("title"),
			roleCandidatePool("title", this.ctx.settings, this.ctx.session.modelRegistry),
			{ settings: this.ctx.settings },
		).model;
		return model?.api === "local-inference" && isTinyLocalModelKey(model.id) ? model.id : undefined;
	}

	/** Prewarm only the local worker selected by the current title role. */
	prewarmTinyTitleModel(): void {
		const modelKey = this.#resolveTitleLocalModelKey();
		if (modelKey) tinyTitleClient.prewarm(modelKey);
	}

	#enhancedPaste?: EnhancedPasteController;
	#draftText: string | undefined;
	// Fork: chain previews own the composer until their caller finishes restoration.
	#chainOwnsComposer = false;
	#chainSpeechDraft: Editor | undefined;
	#chainSpeechSubmit = false;

	insertComposerSpeech(text: string): void {
		if (!this.#chainOwnsComposer) {
			this.ctx.editor.insertText(text);
			return;
		}
		this.#chainSpeechDraft ??= new Editor(getEditorTheme());
		this.#chainSpeechDraft.insertText(text);
	}

	submitComposerSpeech(): void {
		if (this.#chainOwnsComposer) this.#chainSpeechSubmit = true;
		else this.ctx.editor.submit();
	}

	#releaseChainComposer(): void {
		this.#chainOwnsComposer = false;
		const draft = this.#chainSpeechDraft;
		const submit = this.#chainSpeechSubmit;
		this.#chainSpeechDraft = undefined;
		this.#chainSpeechSubmit = false;
		if (!draft) return;
		// On abort/error, retain the restored chain draft separately for Up recall.
		this.ctx.editor.clearDraftForRecall();
		this.ctx.editor.setDraft(draft.getText());
		this.ctx.ui.requestRender();
		// Let the original submission enter dispatch before the next one can submit.
		if (submit) queueMicrotask(() => this.ctx.editor.submit());
	}

	/** Retain a rejected prompt for recall without replacing speech already on the next draft. */
	#restoreRejectedPrompt(text: string, images?: ImageContent[], links?: (string | undefined)[]): void {
		const editor = this.ctx.editor;
		const newerText = editor.getExpandedText();
		const newerImages = [...editor.pendingImages];
		const newerLinks = [...editor.pendingImageLinks];
		const hasNewerDraft = newerText.length > 0 || newerImages.length > 0;
		editor.setDraft(text, images);
		editor.pendingImageLinks = links ? [...links] : (images ?? []).map(() => undefined);
		editor.imageLinks = editor.pendingImageLinks;
		if (!hasNewerDraft) return;
		editor.clearDraftForRecall();
		editor.setDraft(newerText, newerImages);
		editor.pendingImageLinks = newerLinks;
		editor.imageLinks = newerLinks;
	}
	/** Unknown `/command` text already warned about; submitting it again sends it as a prompt. */
	#unknownSlashWarned: string | undefined;
	#focusedLeftTapListenerInstalled = false;
	#focusedPasteListenerInstalled = false;
	#btwBranchListenerInstalled = false;
	#btwCopyListenerInstalled = false;
	#globalEditorActionsListenerInstalled = false;
	#expandToolsListenerInstalled = false;
	#menuHistoryListenerInstalled = false;
	#inlineMouseListenerInstalled = false;
	#linkHintListenerInstalled = false;

	/** Click-candidate id the hover band currently tracks; repaint only on change. */
	#lastHoverClickId: string | undefined;

	/** Expiry timer of a pending `app.sidebar.toggle` chord prefix; undefined when none is pending. */
	#sidebarChordTimer: NodeJS.Timeout | undefined;

	/** Return the last full editor snapshot delivered by its change contract. */
	getDraftText(): string {
		return this.#draftText ?? this.ctx.editor.getText();
	}

	// Tap counter for the double-← gesture; reset whenever a quiet gap
	// (>= LEFT_DOUBLE_TAP_MAX_GAP_MS) starts a fresh sequence. See
	// #detectLeftDoubleTap.
	#leftTapCount = 0;
	// Sequential index for `local://paste-N.md` references created by the large-paste
	// flow. Seeded from 0 and bumped past existing paste files.
	#pasteCounter = 0;
	// Visible-chip signature from the last editor change; a difference escapes the
	// scoped-input render fast path so the attachment chips band repaints.
	#lastChipsSignature = "";
	// Bare command word held for a confirming second Enter (`input.bareSlashCommands`
	// outside an empty session), bound to the session it was armed in. Any other
	// submission disarms it; a session switch invalidates it, so a word armed in
	// one session can never run on a single Enter in another.
	#armedBareCommand: { text: string; sessionId: string } | undefined;
	/** Main-editor destination: images become pending attachments. */
	readonly #editorImageSink: ImagePasteSink = {
		attach: (image, unsupportedMessage, sourcePath) =>
			this.#normalizeAndInsertPastedImage(image, unsupportedMessage, sourcePath),
		pasteText: text => {
			this.ctx.editor.pasteText(text);
			this.ctx.ui.requestRender();
		},
		attachVideo: path => this.#insertPendingVideoPreview(path),
	};

	#abortStreamingTurn(): void {
		void this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
	}

	setupKeyHandlers(): void {
		this.#draftText ??= this.ctx.editor.getText();
		this.ctx.editor.setActionKeys("app.interrupt", this.ctx.keybindings.getKeys("app.interrupt"));
		if (!this.#linkHintListenerInstalled) {
			this.#linkHintListenerInstalled = true;
			// Reserved speech input (including repeats/releases) outranks even link hints and modals.
			// A hint tag still reaches no other listener or the editor.
			this.ctx.ui.addInputListener(data => {
				if (this.ctx.editor.handleSpeechShortcut?.(data)) return { consume: true };
				return this.#handleLinkHintInput(data);
			});
		}
		if (!this.#focusedLeftTapListenerInstalled) {
			this.#focusedLeftTapListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				if (!this.ctx.focusedAgentId) return undefined;
				if (!matchesKey(data, "left")) return undefined;
				if (this.ctx.editor.getText().trim()) return undefined;
				this.#handleFocusedLeftTap();
				return { consume: true };
			});
		}
		if (!this.#btwBranchListenerInstalled) {
			this.#btwBranchListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				if (!matchesKey(data, "b")) return undefined;
				if (!this.ctx.handlesBtwBranchKey()) return undefined;
				if (this.ctx.ui.getFocused() !== this.ctx.editor) return undefined;
				if (this.ctx.editor.getText().trim()) return undefined;
				void this.ctx.handleBtwBranchKey();
				return { consume: true };
			});
		}
		if (!this.#btwCopyListenerInstalled) {
			this.#btwCopyListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				if (this.ctx.ui.getFocused() !== this.ctx.editor) return undefined;
				if (this.ctx.editor.getText().trim()) return undefined;
				if (matchesKey(data, "f") && this.ctx.canFollowUpBtw()) {
					this.ctx.handleBtwFollowUpKey();
					return { consume: true };
				}
				if (!matchesKey(data, "c") || !this.ctx.canCopyBtw()) return undefined;
				void this.ctx.handleBtwCopyKey();
				return { consume: true };
			});
		}
		if (!this.#focusedPasteListenerInstalled) {
			this.#focusedPasteListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				const focused = this.ctx.ui.getFocused();
				if (!focused || focused === this.ctx.editor || !hasPasteText(focused)) return undefined;
				if (!this.ctx.keybindings.matches(data, "app.clipboard.pasteImage")) return undefined;
				void this.handleImagePaste();
				return { consume: true };
			});
		}
		if (!this.#globalEditorActionsListenerInstalled) {
			this.#globalEditorActionsListenerInstalled = true;
			// These actions target the main transcript/editor rather than the
			// focused prompt. Keep focused components' own bindings authoritative.
			this.ctx.ui.addInputListener(data => {
				const chordView = this.#takeSidebarChord(data);
				if (chordView === "cancel") return { consume: true };
				if (chordView !== undefined) {
					this.ctx.sidePanel.showView(chordView);
					return { consume: true };
				}
				if (this.ctx.keybindings.matches(data, "app.sidebar.toggle")) {
					// The inline tree selector binds Alt+T to its no-tools filter; its
					// own binding stays authoritative, as for Alt+L above.
					if (this.ctx.ui.getFocused() instanceof TreeSelectorComponent) return undefined;
					// The prefix also works while the fullscreen form is the active
					// overlay; under any other overlay, including a dialog stacked above
					// the form, the focused component keeps the key.
					if (this.ctx.ui.hasOverlay() && !this.ctx.sidePanel.fullscreenActive) return undefined;
					this.#startSidebarChord();
					return { consume: true };
				}
				if (
					this.ctx.keybindings.matches(data, "app.sidebar.scrollUp") ||
					this.ctx.keybindings.matches(data, "app.sidebar.scrollDown")
				) {
					if (this.ctx.ui.hasOverlay() || !this.ctx.sidePanel.docked) return undefined;
					this.ctx.sidePanel.scrollBy(this.ctx.keybindings.matches(data, "app.sidebar.scrollUp") ? -3 : 3);
					return { consume: true };
				}
				if (this.ctx.keybindings.matches(data, "app.thinking.toggle")) {
					if (this.ctx.ui.hasOverlay()) return undefined;
					this.ctx.toggleThinkingBlockVisibility();
					return { consume: true };
				}
				if (this.ctx.keybindings.matches(data, "app.history.search")) {
					if (this.ctx.ui.hasOverlay() || this.ctx.ui.getFocused() instanceof HistorySearchComponent) {
						return undefined;
					}
					this.ctx.showHistorySearch();
					return { consume: true };
				}
				if (this.ctx.keybindings.matches(data, "app.editor.external")) {
					if (this.ctx.ui.hasOverlay()) return undefined;
					const focused = this.ctx.ui.getFocused();
					if (
						focused instanceof HookEditorComponent ||
						focused === this.ctx.hookSelector ||
						focused === this.ctx.hookInput
					) {
						return undefined;
					}
					void this.openExternalEditor();
					return { consume: true };
				}
				if (this.ctx.keybindings.matches(data, "app.local.open")) {
					if (this.ctx.ui.hasOverlay()) return undefined;
					const focused = this.ctx.ui.getFocused();
					if (
						focused instanceof HookEditorComponent ||
						focused === this.ctx.hookSelector ||
						focused === this.ctx.hookInput
					) {
						return undefined;
					}
					void this.openLocalFilePicker();
					return { consume: true };
				}
				if (this.ctx.keybindings.matches(data, "app.tools.toggleVisibility")) {
					if (this.ctx.ui.hasOverlay()) return undefined;
					this.toggleToolActivityVisibility();
					return { consume: true };
				}
				if (this.ctx.keybindings.matches(data, "app.display.reset")) {
					if (this.ctx.ui.hasOverlay()) return undefined;
					// The tree selector rebinds Alt+L for its `labeled-only` filter
					// and mounts inline (no overlay), so its own binding stays
					// authoritative here — same defer as the tools toggle above.
					if (this.ctx.ui.getFocused() instanceof TreeSelectorComponent && matchesKey(data, "alt+l"))
						return undefined;
					this.ctx.resetDisplayAfterAppearanceRefresh();
					return { consume: true };
				}
				return undefined;
			});
		}
		if (!this.#expandToolsListenerInstalled) {
			this.#expandToolsListenerInstalled = true;
			// `app.tools.expand` (Alt+E by default) toggles the transcript's tool-output
			// preview. It must fire regardless of focus so a truncated edit stays
			// expandable while an approval prompt / select dialog holds keyboard
			// focus (#7837). Defers while a fullscreen or anchored overlay owns
			// its own transcript/tool expansion.
			this.ctx.ui.addInputListener(data => {
				if (!this.ctx.keybindings.matches(data, "app.tools.expand")) return undefined;
				if (this.ctx.ui.hasOverlay()) return undefined;
				const focused = this.ctx.ui.getFocused();
				// A truncated ask question lives in the editor slot, not chat
				// transcript, so expand it in-place instead of (or before)
				// toggling tool-output previews.
				if (focused instanceof AskDialogComponent && focused.toggleQuestionExpansion()) {
					return { consume: true };
				}
				// Likewise an approval prompt that summarized its call's details.
				if (focused instanceof ApprovalDialogComponent && focused.toggleDetails()) {
					return { consume: true };
				}
				this.toggleToolOutputExpansion();
				return { consume: true };
			});
		}
		if (!this.#menuHistoryListenerInstalled) {
			this.#menuHistoryListenerInstalled = true;
			// Ctrl-O / Ctrl-I (Alt-O where the terminal sends Tab for Ctrl-I) walk
			// the menu history from any surface, menus and conversation alike, so
			// they run before the focused component. The keys are consumed even at
			// either end of the timeline: they never fall through to a component.
			this.ctx.ui.addInputListener(data => {
				const direction = this.ctx.keybindings.matches(data, "app.navigation.back")
					? -1
					: this.ctx.keybindings.matches(data, "app.navigation.forward")
						? 1
						: 0;
				if (direction === 0) return undefined;
				this.ctx.navigateMenuHistory(direction);
				return { consume: true };
			});
		}
		if (!this.#inlineMouseListenerInstalled) {
			this.#inlineMouseListenerInstalled = true;
			// Inline click-to-focus (`tui.mouse`): SGR reports only arrive while
			// the setting has tracking enabled, so this stays inert otherwise.
			// Defers to fullscreen overlays, which own mouse handling on the
			// alternate screen.
			this.ctx.ui.addInputListener(data => this.#handleInlineMouse(data));
		}
		this.ctx.editor.onEscape = () => {
			// `/mcp test` advertises Esc until each owner's post-settlement grace expires.
			// Cancel every overlapping test before any main-turn or side-channel action.
			if (this.ctx.mcpTestEscapeHandlers.size > 0) {
				// One Esc cancels every advertised /mcp test and consumes the ownership;
				// the next Esc must reach the actions below instead of being swallowed
				// by a stale registration or grace timer.
				const handlers = [...this.ctx.mcpTestEscapeHandlers];
				this.ctx.mcpTestEscapeHandlers.clear();
				for (const handler of handlers) handler();
				return;
			}

			// Side-channel panels own Esc for cancellation or closing before
			// loop mode, maintenance, or the underlying main turn.
			// Active context maintenance owns Esc: auto/manual compaction,
			// handoff generation, and auto-retry backoff all advertise
			// "(esc to cancel)". Dispatch on live session state instead of
			// swapping onEscape handlers — interleaved start/end events used
			// to clobber the single saved-handler slot (auto-compaction start
			// → /compact → auto end → manual finally), leaving Esc wired to a
			// stale no-op closure until restart.
			//
			// While a subagent is focused, Esc honors the advertised view action
			// ("Esc returns to main") instead of cancelling maintenance —
			// accidentally killing a focused subagent's compaction on the way out
			// was #2819. The auto-maintenance loaders relabel their hint to match
			// (see EventController). Main-session maintenance still owns Esc and
			// stays cancellable from the main view (focused submit gates /compact
			// and handoff, so manual maintenance is main-only anyway).
			if (this.ctx.hasActiveBtw() && this.ctx.handleBtwEscape()) {
				return;
			}
			if (this.ctx.hasActiveOmfg() && this.ctx.handleOmfgEscape()) {
				return;
			}
			if (this.ctx.hasActiveCleanse() && this.ctx.handleCleanseEscape()) {
				return;
			}
			if (this.ctx.dismissCommandReport()) {
				return;
			}

			if (!this.ctx.focusedAgentId) {
				const viewSession = this.ctx.viewSession;
				let aborted = false;
				if (viewSession.isCompacting) {
					safeAbort("compaction", () => viewSession.abortCompaction());
					aborted = true;
				}
				if (viewSession.isGeneratingHandoff) {
					safeAbort("handoff", () => viewSession.abortHandoff());
					aborted = true;
				}
				if (viewSession.isRetrying) {
					safeAbort("retry", () => viewSession.abortRetry());
					aborted = true;
				}
				if (aborted) return;
			}

			if (vocalizer.isSpeaking()) {
				// Playback from the completed response can overlap the next agent
				// turn. Silence it before interrupting any ongoing main-turn work.
				vocalizer.clear();
				this.ctx.lastEscapeTime = 0;
				return;
			}

			if (this.ctx.loopModeEnabled) {
				// Esc suspends the loop even mid-iteration: abort the live turn,
				// then drop the captured prompt so the 800ms auto-resubmit never
				// fires. Loop stays enabled (paused) — the next manual prompt
				// resumes with a new body.
				if (this.ctx.session.isStreaming) {
					this.#abortStreamingTurn();
				}
				this.ctx.pauseLoop();
				this.ctx.cancelPendingSubmission();
				return;
			}
			if (this.ctx.focusedAgentId) {
				// Esc never interrupts the focused agent's turn: clear typed text,
				// else return the view to the main session. Interrupt via empty
				// steer-flush submit if needed.
				if (this.ctx.editor.getText().trim()) {
					this.ctx.editor.setText("");
					this.ctx.ui.requestRender();
				} else {
					void this.ctx.unfocusSession();
				}
				return; // double-escape backtrack (/tree, /branch) stays main-only
			}
			if (this.ctx.collabGuest) {
				// Guest Esc: ask the host to interrupt its agent; the local replica
				// session is never streaming, so the native abort path below would
				// no-op.
				if (this.ctx.collabGuest.state?.isStreaming || this.ctx.loadingAnimation) {
					this.ctx.collabGuest.sendAbort();
				}
				return;
			}
			if (this.ctx.loadingAnimation && this.ctx.cancelPendingSubmission()) {
				return;
			}
			// The turn is over and only background jobs can resume it; its row
			// stays mounted, so this is checked before the loader's abort.
			const awaitingAsyncWork = this.ctx.eventController.isAwaitingAsyncWork();
			if (this.ctx.loadingAnimation && !awaitingAsyncWork) {
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.ctx.session.isBashRunning) {
				this.ctx.session.abortBash();
			} else if (this.ctx.isBashMode) {
				this.ctx.editor.setText("");
				this.ctx.isBashMode = false;
				this.ctx.updateEditorBorderColor();
			} else if (this.ctx.session.isEvalRunning) {
				this.ctx.session.abortEval();
			} else if (this.ctx.isPythonMode) {
				this.ctx.editor.setText("");
				this.ctx.isPythonMode = false;
				this.ctx.updateEditorBorderColor();
			} else if (awaitingAsyncWork) {
				// End the wait. The jobs keep running; their results land in context
				// for the next prompt instead of starting a turn.
				void this.ctx.eventController.stopAwaitingAsyncWork();
			} else if (this.ctx.session.isStreaming) {
				this.#abortStreamingTurn();
			} else if (this.ctx.editor.getText().trim()) {
				// Esc must not destroy an in-progress draft.
				this.ctx.lastEscapeTime = 0;
			} else {
				// Double-interrupt with an empty editor runs the configured action:
				// the transcript rewind selector (default) or the session tree.
				const doubleEscapeAction = cfgDoubleEscapeAction.get(settings);
				if (doubleEscapeAction !== "none") {
					const now = Date.now();
					if (now - this.ctx.lastEscapeTime < 500) {
						if (doubleEscapeAction === "tree") {
							this.ctx.showTreeSelector();
						} else {
							this.ctx.showUserMessageSelector();
						}
						// Forced viewport repaint only: `resetDisplay()` replays the whole
						// committed transcript (and clears native scrollback on direct
						// terminals), which blocks on PTY backpressure for tens of seconds
						// on long sessions — the selector opens invisibly and double-Esc
						// reads as dead. O(viewport) is enough to settle the editor-slot swap.
						this.ctx.ui.requestRender(true);
						this.ctx.lastEscapeTime = 0;
					} else {
						this.ctx.lastEscapeTime = now;
					}
				}
			}
		};

		this.ctx.editor.setActionKeys("app.clear", this.ctx.keybindings.getKeys("app.clear"));
		this.ctx.editor.onClear = () => this.handleCtrlC();
		this.ctx.editor.setActionKeys("app.exit", this.ctx.keybindings.getKeys("app.exit"));
		this.ctx.editor.setActionKeys("app.display.reset", this.ctx.keybindings.getKeys("app.display.reset"));
		this.ctx.editor.onDisplayReset = () => {
			// Explicit user gesture (display reset, Alt+L by default): re-query the
			// terminal background once so a mid-session light/dark switch is picked
			// up even on terminals without an end-to-end Mode 2031 notification
			// path (#5352). The appearance callback re-evaluates the auto theme; the
			// repaint below then renders the resolved palette. Bounded to one OSC 11
			// probe per gesture — no timers, no periodic polling.
			this.ctx.resetDisplayAfterAppearanceRefresh();
		};
		this.ctx.editor.onExit = () => this.handleCtrlD();
		this.ctx.editor.setActionKeys("app.suspend", this.ctx.keybindings.getKeys("app.suspend"));
		this.ctx.editor.onSuspend = () => this.handleCtrlZ();
		this.ctx.editor.setActionKeys("app.thinking.cycle", this.ctx.keybindings.getKeys("app.thinking.cycle"));
		this.ctx.editor.onCycleThinkingLevel = () => {
			hintUsage.record("effort");
			this.cycleThinkingLevel();
		};
		this.ctx.editor.setActionKeys("app.model.cycleForward", this.ctx.keybindings.getKeys("app.model.cycleForward"));
		this.ctx.editor.onCycleModelForward = () => this.cycleRoleModel("forward");
		this.ctx.editor.setActionKeys("app.model.cycleBackward", this.ctx.keybindings.getKeys("app.model.cycleBackward"));
		this.ctx.editor.onCycleModelBackward = () => this.cycleRoleModel("backward");
		this.ctx.editor.setActionKeys(
			"app.model.selectTemporary",
			this.ctx.keybindings.getKeys("app.model.selectTemporary"),
		);
		this.ctx.editor.onSelectModelTemporary = () => this.ctx.showModelSelector({ temporaryOnly: true });

		// Global debug handler on TUI (works regardless of focus)
		this.ctx.ui.onDebug = () => this.ctx.showDebugSelector();
		this.ctx.editor.setActionKeys("app.model.select", this.ctx.keybindings.getKeys("app.model.select"));
		this.ctx.editor.onSelectModel = () => this.ctx.showModelSelector();
		this.ctx.editor.setActionKeys(
			"app.clipboard.pasteImage",
			this.ctx.keybindings.getKeys("app.clipboard.pasteImage"),
		);
		this.ctx.editor.onPasteImage = () => this.handleImagePaste();
		this.ctx.editor.onPasteImagePath = path => this.handleImagePathPaste(path);
		this.ctx.editor.setActionKeys(
			"app.clipboard.pasteTextRaw",
			this.ctx.keybindings.getKeys("app.clipboard.pasteTextRaw"),
		);
		this.ctx.editor.onPasteTextRaw = () => void this.handleClipboardTextRawPaste();
		this.ctx.editor.onLargePaste = (text, lineCount, options) => this.handleLargePaste(text, lineCount, options);
		this.ctx.editor.setActionKeys(
			"app.clipboard.copyPrompt",
			this.ctx.keybindings.getKeys("app.clipboard.copyPrompt"),
		);
		this.ctx.editor.onCopyPrompt = () => this.handleCopyPrompt();
		this.ctx.editor.setActionKeys("app.message.dequeue", this.ctx.keybindings.getKeys("app.message.dequeue"));
		this.ctx.editor.onDequeue = () => this.handleDequeue();
		this.ctx.editor.setActionKeys("app.retry", this.ctx.keybindings.getKeys("app.retry"));
		this.ctx.editor.onRetry = () => void this.handleRetry();
		this.ctx.editor.clearCustomKeyHandlers();
		// Wire up extension shortcuts
		this.registerExtensionShortcuts();
		const planModeKeys = this.ctx.keybindings.getKeys("app.plan.toggle");
		for (const key of planModeKeys) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.handlePlanModeCommand());
		}

		for (const key of this.ctx.keybindings.getKeys("app.session.new")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.handleNewCommand());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.tree")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showTreeSelector());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.fork")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showUserMessageSelector());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.resume")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showSessionSelector());
		}
		// REPL execute shares the follow-up chords by default: each key runs the
		// buffer in REPL mode and sends a follow-up otherwise.
		const followUpKeys = new Set(this.ctx.keybindings.getKeys("app.message.followUp"));
		const replExecuteKeys = new Set(this.ctx.keybindings.getKeys("app.repl.execute"));
		for (const key of new Set([...followUpKeys, ...replExecuteKeys])) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				if (replExecuteKeys.has(key) && this.ctx.replMode.active) this.#submitToRepl();
				else if (followUpKeys.has(key)) void this.handleFollowUp();
			});
		}
		for (const key of this.ctx.keybindings.getKeys("app.repl.toggle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.setReplTarget(this.ctx.replMode.toggle()));
		}
		for (const key of this.ctx.keybindings.getKeys("app.message.chain")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.#submitThroughChain());
		}
		// =====================================================================
		// NEVER ALTER. CTRL+SPACE IS A RESERVED ACCESSIBILITY KEYBINDING.
		// It MUST always route to the fork's xAI batch speech-to-text path below.
		// NEVER favour upstream (can1357/oh-my-pi) STT/dictation here, under any
		// circumstances, during any sync. This code is immutable: touch it only to
		// fix a bug that makes it stop working, and only to the extent necessary.
		// Owner: PsychedelicShayna. Rationale: docs/agents/upstream-sync.md (fork
		// features exist for specific reasons; this one is an accessibility path).
		// =====================================================================
		for (const key of this.ctx.keybindings.getKeys("app.stt.toggle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.handleSTTToggle());
		}
		for (const key of this.ctx.keybindings.getKeys("app.dictation.toggle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.handleDictationToggle());
		}
		for (const key of this.ctx.keybindings.getKeys("app.live.toggle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.handleLiveCommand());
		}
		for (const key of this.ctx.keybindings.getKeys("app.live.mute")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.handleLiveMute());
		}
		for (const key of this.ctx.keybindings.getKeys("app.live.destination.cycle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.handleLiveDestinationCycle());
		}
		// Hold the space bar to push-to-talk: the editor recognizes the auto-repeat burst, tracks
		// the spam back out, and starts STT on hold start / stops it on release.
		this.ctx.editor.spaceHold.handler = this.ctx.dictationSpaceHold(this.ctx.editor);
		for (const key of this.ctx.keybindings.getKeys("app.clipboard.copyLine")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.handleCopyCurrentLine());
		}
		const hubKeys = new Set([
			...this.ctx.keybindings.getKeys("app.agents.hub"),
			...this.ctx.keybindings.getKeys("app.session.observe"),
		]);
		for (const key of hubKeys) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showAgentHub());
		}
		for (const key of this.ctx.keybindings.getKeys("app.irc.viewer")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showIrcViewer());
		}

		// Double-tap left arrow on an empty editor: opens the agent hub from the
		// main session, or returns the focused subagent view to the main session.
		// Focused ←← intentionally matches Esc. From the main session the gesture
		// stays inert when there are no subagents (requireContent); the explicit
		// hub key still opens the empty roster. `armCloseTap` hands this gesture's
		// tap state to the hub so the same ←← that opened it also arms its close —
		// otherwise the hub's fresh detector demands a second ←← (issue #4780).
		this.ctx.editor.onLeftAtStart = () => {
			if (this.ctx.focusedAgentId) {
				this.#handleFocusedLeftTap();
				return;
			}
			if (this.#detectLeftDoubleTap()) {
				hintUsage.record("agents");
				this.ctx.showAgentHub({ requireContent: true, armCloseTap: true });
			}
		};
		// The native composer's viewing header: an ancestor crumb, or back to main.
		this.ctx.editor.onFocusAgent = id => this.#focusResolvedAgent(id);

		this.#setupEnhancedPaste();

		this.ctx.editor.onChange = (text: string) => {
			const wasComposing = (this.#draftText ?? "").trim() !== "";
			this.#draftText = text;
			this.ctx.noteLiveComposerActivity();
			// Typing signals an imminent turn; refresh the API connection now so
			// the handshake overlaps composition instead of delaying the send.
			if (text) this.ctx.session.prewarmModelConnection();
			if (wasComposing !== (text.trim() !== "")) this.ctx.syncIdleMaintenanceView();
			const wasBashMode = this.ctx.isBashMode;
			const wasPythonMode = this.ctx.isPythonMode;
			const trimmed = text.trimStart();
			this.ctx.isBashMode = trimmed.startsWith("!");
			this.ctx.isPythonMode =
				parseReplEvalInput(trimmed, this.ctx.session.extensionRunner?.getEvalBackendAliases()) !== undefined;
			if (wasBashMode !== this.ctx.isBashMode || wasPythonMode !== this.ctx.isPythonMode) {
				this.ctx.updateEditorBorderColor();
			}
			// Editor input repaints through the scoped fast path (only the editor
			// component). The attachment chips band lives outside the editor, so a
			// visibility change — a chip pasted in or its token deleted — must escape
			// the fast path with a full render or the band goes stale.
			const chipsSignature = this.ctx.editor
				.composerChips()
				.map(chip => `${chip.kind}${chip.n}`)
				.join(",");
			if (chipsSignature !== this.#lastChipsSignature) {
				this.#lastChipsSignature = chipsSignature;
				this.ctx.ui.requestRender();
			}
		};
	}

	/**
	 * Run one `app.*` keybinding by id, through the same handlers the keyboard
	 * uses (#171). Returns false when the id is unknown or not applicable.
	 */
	runAppAction(id: string): boolean {
		const editor = this.ctx.editor;
		switch (id) {
			case "app.interrupt":
				editor.onEscape?.();
				return true;
			case "app.clear":
				// Control actions clear the composer without entering the human
				// Ctrl-C double-press/hard-abort shutdown state.
				this.ctx.discardLiveSpeech();
				this.ctx.clearEditor();
				return true;
			case "app.exit":
				this.handleCtrlD();
				return true;
			case "app.suspend":
				return false;
			case "app.display.reset":
				editor.onDisplayReset?.();
				return true;
			case "app.thinking.cycle":
				this.ctx.cycleThinkingLevel();
				return true;
			case "app.thinking.toggle":
				this.ctx.toggleThinkingBlockVisibility();
				return true;
			case "app.model.cycleForward":
				void this.ctx.cycleRoleModel("forward");
				return true;
			case "app.model.cycleBackward":
				void this.ctx.cycleRoleModel("backward");
				return true;
			case "app.model.select":
				void this.ctx.showModelSelector();
				return true;
			case "app.model.selectTemporary":
				void this.ctx.showModelSelector({ temporaryOnly: true });
				return true;
			case "app.tools.expand":
				this.ctx.toggleToolOutputExpansion();
				return true;
			case "app.tools.toggleVisibility":
				this.toggleToolActivityVisibility();
				return true;
			case "app.message.followUp":
				void this.handleFollowUp();
				return true;
			case "app.message.chain":
				editor.onSubmit?.(editor.getText());
				return true;
			case "app.message.dequeue":
				this.handleDequeue();
				return true;
			case "app.retry":
				void this.handleRetry();
				return true;
			case "app.clipboard.pasteImage":
				void this.handleImagePaste();
				return true;
			case "app.clipboard.pasteTextRaw":
				void this.handleClipboardTextRawPaste();
				return true;
			case "app.clipboard.copyPrompt":
				this.handleCopyPrompt();
				return true;
			case "app.clipboard.copyLine":
				this.handleCopyCurrentLine();
				return true;
			case "app.plan.toggle":
				void this.ctx.handlePlanModeCommand("");
				return true;
			case "app.session.new":
				void this.ctx.handleClearCommand();
				return true;
			case "app.session.tree":
				void this.ctx.showTreeSelector();
				return true;
			case "app.session.fork":
				void this.ctx.showUserMessageSelector();
				return true;
			case "app.session.resume":
				void this.ctx.showSessionSelector();
				return true;
			case "app.agents.hub":
			case "app.session.observe":
				void this.ctx.showAgentHub();
				return true;
			case "app.irc.viewer":
				this.ctx.showIrcViewer();
				return true;
			case "app.history.search":
				void this.ctx.showHistorySearch();
				return true;
			// =====================================================================
			// NEVER ALTER. CTRL+SPACE IS A RESERVED ACCESSIBILITY KEYBINDING.
			// It MUST always route to the fork's xAI batch speech-to-text path below.
			// NEVER favour upstream (can1357/oh-my-pi) STT/dictation here, under any
			// circumstances, during any sync. This code is immutable: touch it only to
			// fix a bug that makes it stop working, and only to the extent necessary.
			// Owner: PsychedelicShayna. Rationale: docs/agents/upstream-sync.md (fork
			// features exist for specific reasons; this one is an accessibility path).
			// =====================================================================
			case "app.stt.toggle":
				// IMMUTABLE: see Ctrl+Space notice above
				void this.ctx.handleSTTToggle();
				return true;
			case "app.dictation.toggle":
				void this.ctx.handleDictationToggle();
				return true;
			case "app.live.toggle":
				void this.ctx.handleLiveCommand();
				return true;
			case "app.live.mute":
				void this.ctx.handleLiveMute();
				return true;
			case "app.live.destination.cycle":
				void this.ctx.handleLiveDestinationCycle();
				return true;
			case "app.sidebar.toggle":
				this.ctx.sidePanel.toggle();
				return true;
			case "app.sidebar.scrollUp":
				this.ctx.sidePanel.scrollBy(-3);
				return true;
			case "app.sidebar.scrollDown":
				this.ctx.sidePanel.scrollBy(3);
				return true;
			default:
				return false;
		}
	}

	/** Arm the side-panel chord: the next key picks a view, until it expires. */
	#startSidebarChord(): void {
		clearTimeout(this.#sidebarChordTimer);
		this.#sidebarChordTimer = setTimeout(() => {
			this.#sidebarChordTimer = undefined;
		}, SIDEBAR_CHORD_TIMEOUT_MS);
		this.#sidebarChordTimer.unref?.();
		const prefix = appKey(this.ctx.keybindings, "app.sidebar.toggle");
		this.ctx.showStatus(`Side panel (${prefix}): t todo · a agents · i IRC · esc cancel`);
	}

	/**
	 * Resolve the key after an armed chord prefix: the view it picks, `"cancel"`
	 * for Escape (consumed), or undefined when no chord is pending or the key is
	 * not a view key. Any other key ends the chord and keeps its usual meaning.
	 * Mouse reports and key releases pass through without ending it.
	 */
	#takeSidebarChord(data: string): SidePanelView | "cancel" | undefined {
		if (this.#sidebarChordTimer === undefined) return undefined;
		if (data.startsWith("\x1b[<") || isKeyRelease(data)) return undefined;
		clearTimeout(this.#sidebarChordTimer);
		this.#sidebarChordTimer = undefined;
		// An overlay that opened meanwhile owns its keys, except the fullscreen panel.
		if (this.ctx.ui.hasOverlay() && !this.ctx.sidePanel.fullscreenActive) return undefined;
		if (matchesKey(data, "escape")) return "cancel";
		for (const [view, keys] of SIDEBAR_CHORD_KEYS) {
			if (keys.some(key => matchesKey(data, key))) return view;
		}
		return undefined;
	}

	#handleFocusedLeftTap(): void {
		if (this.#detectLeftDoubleTap()) {
			void this.ctx.unfocusSession();
		}
	}

	/**
	 * Inline click-to-focus (`tui.mouse`): left-clicks on live subagent cards
	 * and HUD rows focus that agent in one action, and pointer motion lights up
	 * the hover band on the target under the cursor. Every SGR report is consumed
	 * while inline tracking owns the terminal so button/wheel bytes never reach
	 * the editor as typed input; clicks on chrome simply swallow.
	 */
	#handleInlineMouse(data: string): { consume?: boolean; data?: string } | undefined {
		if (!data.startsWith("\x1b[<")) return undefined;
		if (!cfgTuiMouse.get(this.ctx.settings)) return undefined;
		if (this.ctx.ui.hasOverlay()) return undefined;
		const event = parseSgrMouse(data);
		if (!event) return undefined;
		if (this.ctx.sidePanel.routeInlineMouse(event)) {
			// Outside the chat column: the panel dropped the band; forget the target
			// so moving back onto the same card paints it again.
			this.#lastHoverClickId = undefined;
			return { consume: true };
		}
		if (event.motion) this.#updateHoverHighlight(event.row);
		else if (event.leftClick && !this.#activateClickedLink(event.row, event.col)) this.#focusClickedAgent(event.row);
		return { consume: true };
	}

	/**
	 * Keyboard link picking. `app.links.hint` enters link-hint mode, which then owns the keyboard
	 * while the editor has focus: a lowercase letter narrows the tags, and any other key cancels and
	 * is swallowed so a stray Esc or Enter does nothing else. Ctrl+C and a paste cancel and still do
	 * what they always do. Key releases and repeats (the hint key's own) are ignored; mouse reports
	 * pass through untouched. Keys the TUI routes before input listeners (a space held for
	 * push-to-talk) never reach this.
	 */
	#handleLinkHintInput(data: string): { consume?: boolean } | undefined {
		// Overlays and editor-area dialogs (ask, selectors, hook input) own the keyboard.
		const editorFocused = () => !this.ctx.ui.hasOverlay() && this.ctx.ui.getFocused() === this.ctx.editor;
		if (!this.ctx.linkHintsActive) {
			if (!this.ctx.keybindings.matches(data, "app.links.hint") || !editorFocused()) return undefined;
			return this.ctx.startLinkHints() ? { consume: true } : undefined;
		}
		if (!editorFocused()) {
			this.ctx.cancelLinkHints();
			return undefined;
		}
		if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
		if (data.startsWith("\x1b[<")) return undefined;
		if (matchesKey(data, "ctrl+c") || data.startsWith("\x1b[200~")) {
			this.ctx.cancelLinkHints();
			return undefined;
		}
		const key = parseKey(data);
		if (key !== undefined && /^[a-z]$/.test(key)) this.ctx.typeLinkHint(key);
		else this.ctx.cancelLinkHints();
		return { consume: true };
	}

	/**
	 * Track the hovered click target, repainting only when it changes. The band
	 * is id-anchored in the composer, so it follows an agent whose rows shift
	 * while streaming; pointing at chrome clears it.
	 */
	#updateHoverHighlight(screenRow: number): void {
		const hovered = this.#viewportCandidates(screenRow)[0];
		if (hovered === this.#lastHoverClickId) return;
		this.#lastHoverClickId = hovered;
		this.ctx.setClickHoverId(hovered);
		this.ctx.ui.requestRender();
	}

	// Candidates under a screen row, or none when the published viewport is
	// empty (resize transactions) or the row falls outside it: routing stale
	// spans would highlight or focus an unrelated agent from old rows.
	#viewportCandidates(screenRow: number): string[] {
		const line = this.#viewportLine(screenRow);
		return line === undefined ? [] : this.ctx.resolveViewportClickCandidates(line);
	}

	/** Mutable-viewport line under a screen row, or `undefined` outside the published viewport. */
	#viewportLine(screenRow: number): number | undefined {
		const viewport = this.ctx.ui.getMutableViewport();
		const local = screenRow - viewport.top;
		if (viewport.length === 0 || local < 0 || local >= viewport.length) return undefined;
		return local;
	}

	// A click on an extension-owned link goes to that extension instead of focusing an agent.
	#activateClickedLink(screenRow: number, col: number): boolean {
		const line = this.#viewportLine(screenRow);
		return line !== undefined && this.ctx.activateViewportLink(line, col);
	}

	/**
	 * Forget the last hovered target without repainting. Disabling mouse
	 * capture clears the composer's band, but with reporting off no motion
	 * event will ever refresh this cache — so a re-enable plus motion over
	 * the same card would look unchanged and skip restoring the band.
	 */
	clearHoverHighlight(): void {
		this.#lastHoverClickId = undefined;
	}

	#focusClickedAgent(screenRow: number): void {
		const candidates = this.#viewportCandidates(screenRow);
		if (candidates.length === 0) return;
		const refs = AgentRegistry.global().list();
		const scoped = refs.filter(ref => candidates.includes(ref.id));
		// A live agent wins over the expander sentinel: task names are
		// user-controlled, so an agent id can equal the toggle id. The toggle
		// row itself names no agent and still toggles.
		if (candidates.includes(PINNED_HUD_TOGGLE_ID) && scoped.length === 0) {
			this.ctx.togglePinnedHudExpanded();
			return;
		}
		// No global fallback: when every candidate is gone (aborted, released),
		// focusing an unrelated recent agent would open something other than
		// what the click displayed.
		const nextId = pickRecentFocusableAgentId(scoped, this.ctx.focusedAgentId);
		if (nextId === undefined) {
			this.ctx.showStatus("That subagent is gone — open the hub for live agents");
			return;
		}
		this.#focusResolvedAgent(nextId);
	}

	/** Focus a resolved agent id, ignoring already-viewing and surfacing errors as status. */
	#focusResolvedAgent(nextId: string): void {
		if (nextId === this.ctx.focusedAgentId) {
			// Reaffirming the current view is still the user's latest click: a
			// parked agent reviving from an older click must not land over it.
			this.ctx.invalidatePendingFocus();
			return;
		}
		void this.ctx.focusAgentSession(nextId).catch((error: unknown) => {
			this.ctx.showStatus(error instanceof Error ? error.message : String(error));
		});
	}

	/**
	 * Detect a deliberate double-← gesture, rejecting terminal-synthesized arrow
	 * bursts. Returns true only on the *second* tap of a fresh sequence when it
	 * lands a human-plausible interval after the first
	 * (`[LEFT_DOUBLE_TAP_MIN_GAP_MS, LEFT_DOUBLE_TAP_MAX_GAP_MS)`). Taps closer
	 * than the lower bound, or any third-and-later tap before a quiet gap, are a
	 * burst and never fire — so a stray click that makes the terminal emit a run
	 * of ← keys can no longer pop the Agent Hub.
	 */
	#detectLeftDoubleTap(): boolean {
		const now = Date.now();
		const sinceLast = now - this.ctx.lastLeftTapTime;
		this.ctx.lastLeftTapTime = now;
		if (sinceLast >= LEFT_DOUBLE_TAP_MAX_GAP_MS) {
			// Quiet gap: this tap starts a fresh sequence.
			this.#leftTapCount = 1;
			return false;
		}
		this.#leftTapCount += 1;
		if (this.#leftTapCount === 2 && sinceLast >= LEFT_DOUBLE_TAP_MIN_GAP_MS) {
			// Exactly two taps, the second a human-plausible interval after the first.
			this.#leftTapCount = 0;
			this.ctx.lastLeftTapTime = 0;
			return true;
		}
		return false;
	}

	#setupEnhancedPaste(): void {
		if (this.#enhancedPaste) return;

		this.#enhancedPaste = new EnhancedPasteController({
			write: data => this.ctx.ui.terminal.write(data),
			pasteText: text => {
				// Route enhanced-paste text to the currently focused component: through
				// its `pasteText` hook (modal Input prompts: OAuth API-key entry,
				// Perplexity OTP, GitHub Enterprise URL, manual redirect URL), else as
				// the bracketed paste a terminal without enhanced paste sends it
				// (dialogs that keep their field inside: the agents hub's New agent,
				// the /annotate note). Falling back to the main editor would bury the
				// text in the detached editor while the dialog has focus (#2127). The
				// main editor takes it as a bracketed paste too, so a pasted or dropped
				// image path attaches (#3506) instead of landing as text.
				const focused = this.ctx.ui.getFocused();
				if ((!focused || focused === this.ctx.editor) && this.ctx.editor.chainLocked) {
					this.ctx.showStatus("The composer is locked while a chain runs");
					return;
				}
				if (focused && focused !== this.ctx.editor && hasPasteText(focused)) focused.pasteText(text);
				else if (focused && focused !== this.ctx.editor && focused.handleInput)
					focused.handleInput(`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`);
				else this.ctx.editor.handleInput(`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`);
				this.ctx.ui.requestRender();
			},
			pasteImage: async image => {
				if (this.ctx.editor.chainLocked && this.ctx.ui.getFocused() === this.ctx.editor) {
					this.ctx.showStatus("The composer is locked while a chain runs");
					return;
				}
				await this.#pasteImageIntoFocus(sink =>
					sink.attach(image, `Unsupported pasted image format: ${image.mimeType}`),
				);
			},
			showStatus: message => this.ctx.showStatus(message),
		});
		this.ctx.ui.addInputListener(data => (this.#enhancedPaste?.handleInput(data) ? { consume: true } : undefined));
		this.ctx.ui.addStartListener(() => this.#enhancedPaste?.enable());
	}

	/** Enforce the deleted-chip contract at submit time: images whose inline token was removed
	 *  from the draft are dropped, and surviving markers are renumbered to the dense 1..K the
	 *  positional `[Image #N] ↔ images[N-1]` mapping requires. Returns the rewritten text. */
	#compactDraftImages(text: string): string {
		const editor = this.ctx.editor;
		const compacted = compactImageMarkers(text, editor.pendingImages.length);
		if (!compacted) return text;
		editor.pendingImages = compacted.keep.map(i => editor.pendingImages[i]);
		editor.pendingImageLinks = compacted.keep.map(i => editor.pendingImageLinks[i]);
		editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		return compacted.text.trim();
	}

	#dropSubmittedPending(images: ImageContent[] | undefined): void {
		if (!images?.length) return;
		const editor = this.ctx.editor;
		// Drop the snapshot only while it is still the live prefix: attachments
		// added while the handler was pending stay in place, renumbered from #1.
		if (!images.every((image, index) => editor.pendingImages[index] === image)) return;
		const newerDraft = editor.getExpandedText();
		editor.pendingImages.splice(0, images.length);
		editor.pendingImageLinks.splice(0, images.length);
		editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		const renumbered = shiftImageMarkers(newerDraft, -images.length);
		if (renumbered !== newerDraft) editor.setCollapsedText(renumbered);
	}

	async #runInputHandlers(
		text: string,
		images?: ImageContent[],
		imageLinks?: (string | undefined)[],
	): Promise<{ text: string; images?: ImageContent[]; imageLinks?: (string | undefined)[] } | undefined> {
		const result = await this.ctx.session.extensionRunner?.emitInput(text, images, "interactive");
		if (!isDeferredSubmissionActive()) return undefined;
		if (result?.handled) return undefined;
		if (result?.text !== undefined) text = result.text.trim();
		if (result?.images !== undefined) {
			images = result.images;
			imageLinks = await materializeImageChipLinks(images, this.ctx.sessionManager);
		}
		if (!text && !images?.length) return undefined;
		return { text, images, imageLinks };
	}

	setupEditorSubmitHandler(): void {
		this.ctx.editor.onSubmit = async (text: string) => {
			const deferred = currentDeferredDraft() !== undefined;
			if (!isDeferredSubmissionActive()) return;
			// A timer owns no real Enter gesture or live-call speech admission.
			const forceChain = !deferred && this.#chainNextSubmit;
			const toRepl = !deferred && this.#replNextSubmit;
			if (!deferred) {
				this.#chainNextSubmit = false;
				this.#replNextSubmit = false;
			}
			if (toRepl && this.ctx.replMode.active && !isReplBypass(text) && text.trim()) {
				await this.#runReplCell(text);
				return;
			}
			const submittedText = text;
			// Text entered after the submitted draft belongs to the next submission.
			const draftText = this.ctx.editor.getText();
			const armed = deferred ? undefined : this.#armedBareCommand;
			if (!deferred) this.#armedBareCommand = undefined;
			const armedBareCommand =
				armed && armed.sessionId === this.ctx.sessionManager.getSessionId() ? armed.text : undefined;
			// Notices and deferred input stay literal until their own submission is interpreted.
			const commandName = parseSlashCommand(text.trimStart())?.name;
			const literalInput = commandName === "notice" || commandName === "defer";
			text = literalInput ? text.trimStart() : this.#compactDraftImages(text.trim());
			const hasPendingImages = this.ctx.editor.pendingImages.length > 0;
			if (!literalInput && (!isSettingsInitialized() || cfgEmojiAutocomplete.get(settings)) && text) {
				text = expandEmoticons(text);
			}
			const warnedSlashText = deferred ? undefined : this.#unknownSlashWarned;
			if (!deferred) this.#unknownSlashWarned = undefined;

			// Focused chat stays with its agent unless main owns an approval draft.
			if (!deferred && this.ctx.focusedAgentId && !this.ctx.approvalOwnsComposer) {
				if (this.ctx.liveCallActive && !this.ctx.discardLiveSpeech()) {
					this.#holdForLiveHandoff(text);
					return;
				}
				await this.#submitToFocusedSession(text, "steer");
				return;
			}

			// Empty submit while streaming with queued (or live-steered) messages:
			// abort the active turn and let the post-unwind drain deliver the
			// agent-core queue.
			if (!text && !hasPendingImages && this.ctx.session.isStreaming) {
				if (this.ctx.session.hasInterruptibleInput) {
					const aborting = this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
					await aborting;
					this.ctx.updatePendingMessagesDisplay();
					this.ctx.ui.requestRender();
				}
				return;
			}

			if (!text && !hasPendingImages) return;

			// Continue shortcuts: "." or "c" resume the agent without a visible user
			// message (see AgentSession.resume). During a /guided-goal interview "c" is
			// a plausible answer (e.g. option C), so it is sent as a normal reply there.
			if (text === "." || (text === "c" && !this.ctx.isGuidedGoalInterviewActive())) {
				if (this.ctx.onInputCallback) {
					this.ctx.editor.clearDraft();
					this.ctx.onInputCallback({ text, cancelled: false, started: true, resume: true });
				}
				return;
			}

			// Live call: Enter is the operator's own handoff and may address the voice agent
			// instead of, or alongside, the main agent. Harness commands (`/`, `!`, `$`) stay
			// with the harness, but still consume the speech dictated into them; image drafts
			// always reach the main agent.
			let liveRoute: LiveSubmitRoute = "primary";
			if (!deferred && this.ctx.liveCallActive) {
				// `$` is a harness command only when it parses as REPL input; `$HOME` stays prose.
				const harnessCommand =
					/^[/!]/.test(text) ||
					parseReplEvalInput(text, this.ctx.session.extensionRunner?.getEvalBackendAliases()) !== undefined;
				if (harnessCommand) {
					if (!this.ctx.discardLiveSpeech()) liveRoute = "held";
				} else {
					liveRoute = this.ctx.routeLiveSubmit(text, { hasImages: hasPendingImages });
				}
			}
			if (liveRoute === "held") {
				this.#holdForLiveHandoff(text);
				return;
			}
			if (liveRoute === "voice") {
				this.ctx.editor.addToHistory(text);
				this.ctx.editor.clearDraft();
				return;
			}

			const runner = this.ctx.session.extensionRunner;
			let inputImages = this.ctx.editor.pendingImages.length > 0 ? [...this.ctx.editor.pendingImages] : undefined;
			let inputImageLinks =
				this.ctx.editor.pendingImageLinks.length > 0 ? [...this.ctx.editor.pendingImageLinks] : undefined;
			let hasInputImages = (inputImages?.length ?? 0) > 0;
			const submittedImages = inputImages;

			// A startup-deferred extension's input hook must see the first submission.
			if (this.ctx.session.hasPendingDeferredExtensions) await this.ctx.session.loadDeferredExtensions();
			if (!literalInput && runner?.hasHandlers("input")) {
				const input = await this.#runInputHandlers(text, inputImages, inputImageLinks);
				if (!isDeferredSubmissionActive()) return;
				if (!input) {
					// The handler consumed the submission. The editor text was reset
					// before this callback ran, so anything in it now is a newer draft;
					// only the submitted attachments are dropped, and only while they
					// are still the live prefix.
					this.#dropSubmittedPending(inputImages);
					return;
				}
				({ text, images: inputImages, imageLinks: inputImageLinks } = input);
				hasInputImages = (inputImages?.length ?? 0) > 0;
			}
			const submittedMode = parseSlashCommand(text)?.name;
			const draftDetached = submittedMode !== undefined && DETACHED_DRAFT_COMMANDS.has(submittedMode);
			if (draftDetached) this.#dropSubmittedPending(submittedImages);

			if (!text && !hasInputImages) return;
			// Input hooks have settled what the main agent receives; share that, not the raw draft.

			const queueBody = parseQueueShorthand(text);
			if (queueBody !== undefined) {
				const accepted = await this.#queueForYield(queueBody, {
					historyText: !deferred && this.ctx.liveCallActive ? undefined : text,
					images: inputImages,
					imageLinks: inputImageLinks,
				});
				if (accepted.length > 0 && !deferred && this.ctx.liveCallActive) {
					const delivered = accepted.join("\n\n");
					this.ctx.editor.addToHistory(delivered);
					this.ctx.shareLiveSubmit(delivered);
				}
				return;
			}

			const bareSlashCommand = this.#resolveBareSlashCommand(text, submittedText, hasInputImages, armedBareCommand);
			if (bareSlashCommand?.confirm) {
				this.#armedBareCommand = { text, sessionId: this.ctx.sessionManager.getSessionId() };
				this.ctx.editor.setText(text);
				this.ctx.showStatus(
					`Press Enter again to run ${bareSlashCommand.command}; add a leading space to send "${text}" as a message`,
				);
				if (forceChain) this.#chainNextSubmit = true;
				return;
			}
			if (bareSlashCommand) text = bareSlashCommand.command;

			// Check the submitted top-level command before a built-in can rewrite its prompt.
			// Confirmation is valid for only the next submission, even when it returns early.
			const unknownSlash =
				text !== warnedSlashText &&
				!this.ctx.collabGuest &&
				text.startsWith("/") &&
				!this.ctx.isKnownSlashCommand(text) &&
				!isKnownSkillCommand(this.ctx, text)
					? findUnknownSlashCommand(text, this.ctx.slashCommandNames)
					: undefined;
			if (unknownSlash) {
				this.#unknownSlashWarned = text;
				const hint = unknownSlash.suggestion ? ` Did you mean /${unknownSlash.suggestion}?` : "";
				if (this.ctx.editor.getText()) {
					// An input hook may have awaited while the operator started a new draft.
					this.ctx.editor.addToHistory(text);
					this.ctx.showWarning(
						`Unknown command /${unknownSlash.name}.${hint} New draft kept; previous command saved to history (Up) for confirmation.`,
					);
				} else {
					this.ctx.showWarning(
						`Unknown command /${unknownSlash.name}.${hint} Press Enter again to send it as a message.`,
					);
					if (!this.ctx.editor.restoreSubmittedDraft()) this.ctx.editor.setCollapsedText(text);
				}
				if (forceChain) this.#chainNextSubmit = true;
				return;
			}
			// Handle built-in slash commands
			if (text) {
				this.#recordSlashCommandUsage(text);
				const input =
					(inputImages?.length ?? 0) > 0 || (inputImageLinks?.length ?? 0) > 0
						? { images: inputImages, imageLinks: inputImageLinks }
						: undefined;
				let slashResult: string | boolean;
				try {
					slashResult = await executeBuiltinSlashCommand(text, { ctx: this.ctx, input, draftDetached });
				} catch (error) {
					if (!isDeferredSubmissionActive()) return;
					// Detached mode commands (plan/vibe/goal/guided-goal) rethrow so
					// this caller — the one that took the draft's images out of the
					// editor before dispatch — restores the submission and reports
					// the error, mirroring `handleFollowUp`'s Ctrl+Enter path.
					if (!draftDetached) throw error;
					restoreDetachedDraft(this.ctx.editor, text, inputImages, inputImageLinks);
					this.ctx.showError(error instanceof Error ? error.message : String(error));
					return;
				}
				if (!isDeferredSubmissionActive()) return;
				if (slashResult === true) {
					if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
					return;
				}
				if (typeof slashResult === "string") {
					// Command handled but returned remaining text to use as prompt.
					// Record the original slash command text so Up Arrow recalls
					// "/loop 10 fix bug" rather than just "fix bug".
					if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
					text = slashResult;
				}
			}

			// Collab guest: prompts execute on the host; local slash/skill/bash/
			// python execution is host-only (builtins are gated inside
			// executeBuiltinSlashCommand, which already consumed allowed ones).
			if (this.ctx.collabGuest) {
				if (text.startsWith("/")) {
					this.ctx.showStatus(`${text.split(/\s+/, 1)[0]} is host-only during a collab session`);
					this.ctx.editor.setText(deferred ? text : "");
					return;
				}
				if (
					text.startsWith("!") ||
					parseReplEvalInput(text, this.ctx.session.extensionRunner?.getEvalBackendAliases())
				) {
					this.ctx.showStatus("Local execution is host-only during a collab session");
					this.ctx.editor.setText(deferred ? text : "");
					return;
				}
				if (this.ctx.collabGuest.readOnly) {
					// Keep the typed text: the prompt was not consumed.
					this.ctx.showStatus("This collab link is read-only — prompting is disabled");
					if (deferred) this.ctx.editor.setText(text);
					return;
				}
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.editor.clearDraft(text);
				// No local render: the prompt comes back from the host as a
				// collab-prompt event/entry and renders with the author badge.
				this.ctx.collabGuest.sendPrompt(text, images);
				return;
			}

			// `side: true` file commands answer as a /btw side question: off the
			// transcript and runnable mid-turn, so they never steer the running work.
			// The side question carries text only, so the submitted attachments drop.
			if (
				await this.#runSideFileCommand(text, {
					detach: () => this.#detachSideSubmission(draftText, submittedImages),
					restore: () => this.#restoreResetSubmission(submittedText),
				})
			) {
				return;
			}

			// Handle skill commands (/skill:name [args]). Enter ⇒ steer (matches the
			// free-text Enter semantics below); Ctrl+Enter routes through `handleFollowUp`.
			// During compaction, queue immediately so bash/python/loop-mode branches do
			// not consume the skill before the compaction-resume path re-parses it.
			if (text && isKnownSkillCommand(this.ctx, text)) {
				// Capture here too: this branch's own early returns below would
				// otherwise skip the non-skill capture further down.
				if (this.ctx.loopModeEnabled) {
					this.ctx.setLoopPrompt(text);
				}
				if (this.ctx.session.isCompacting) {
					const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
					this.ctx.queueCompactionMessage(text, "steer", images);
					return;
				}
				const handled = await this.#invokeSkillCommand(text, "steer", inputImages, inputImageLinks);
				if (!isDeferredSubmissionActive()) return;
				if (handled) {
					// The dispatch above ran the turn inline without resolving the input
					// callback, so nothing re-enters `getUserInput` to arm the next
					// iteration. Arm it here, now that the turn has settled.
					if (this.ctx.loopModeEnabled) {
						this.ctx.armLoopAutoSubmit();
					}
					return;
				}
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.ctx.session.isBashRunning) {
						this.ctx.showWarning(
							`A bash command is already running. Press ${appKey(this.ctx.keybindings, "app.interrupt")} to cancel it first.`,
						);
						this.ctx.editor.setText(text);
						return;
					}
					this.ctx.editor.addToHistory(text);
					await this.ctx.handleBashCommand(command, isExcluded);
					this.ctx.isBashMode = false;
					this.ctx.updateEditorBorderColor();
					return;
				}
			}

			// Handle generic user eval commands for built-ins and registered aliases.
			const evalCommand = parseReplEvalInput(text, runner?.getEvalBackendAliases());
			if (evalCommand) {
				if (this.ctx.session.isEvalLanguageRunning(evalCommand.language)) {
					this.ctx.showWarning(
						`The ${evalCommand.language} kernel is busy. Press ${appKey(this.ctx.keybindings, "app.interrupt")} to cancel it first.`,
					);
					this.ctx.editor.setText(text);
					return;
				}
				this.ctx.editor.addToHistory(text);
				this.ctx.editor.clearDraft();
				await this.ctx.handleEvalCommand(
					evalCommand.language,
					evalCommand.code,
					evalCommand.excludeFromContext,
					evalCommand.reset,
					evalCommand.alias,
				);
				this.ctx.isPythonMode = false;
				this.ctx.updateEditorBorderColor();
				return;
			}

			// Queue input during compaction
			if (this.ctx.session.isCompacting) {
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.queueCompactionMessage(text, "steer", images);
				// An inline `/loop` body queued here arms the loop only when it is
				// an actual model prompt. Skill/bash/python bodies never reach this
				// branch, but an extension-command body would otherwise be retained
				// as loopPrompt while the drain executes it locally — and idle
				// submissions never arm commands.
				if (submittedMode === "loop" && !this.#isLocalExtensionCommand(text)) this.ctx.setLoopPrompt(text);
				return;
			}

			// Extension commands are local actions. Execute them before the normal
			// submission path creates an optimistic user message; otherwise a
			// consumed command remains rendered like a prompt sent to the model.
			if (this.#isLocalExtensionCommand(text)) {
				this.ctx.editor.clearDraft(text);
				try {
					await this.ctx.session.prompt(text, { images: inputImages });
				} catch (error) {
					// Restore the snapshot only when nothing newer was attached
					// while the command ran; otherwise the newer draft wins.
					if (inputImages && inputImages.length > 0 && this.ctx.editor.pendingImages.length === 0) {
						this.ctx.editor.pendingImages = [...inputImages];
						this.ctx.editor.pendingImageLinks = inputImageLinks
							? [...inputImageLinks]
							: inputImages.map(() => undefined);
						this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
					}
					this.ctx.editor.setCollapsedText(text);
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				}
				return;
			}

			// Post-processing chain: only plain prompts reach here. The typed text
			// stays in history so Up recalls what was written, not the rewrite.
			const typedText = text;
			if (forceChain || (isSettingsInitialized() && cfgChainingAuto.get(settings))) {
				this.#chainOwnsComposer = true;
				try {
					const outcome = await this.#applyPostProcessingChain(text);
					if (!isDeferredSubmissionActive()) return;
					if (!outcome.send) {
						if (inputImages && inputImages.length > 0) {
							this.ctx.editor.pendingImages = [...inputImages];
							this.ctx.editor.pendingImageLinks = inputImageLinks
								? [...inputImageLinks]
								: inputImages.map(() => undefined);
							this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
						}
						if (outcome.text === typedText && this.ctx.editor.restoreSubmittedDraft()) {
							// An untouched draft comes back as displayed, large pastes still collapsed.
						} else {
							// A later step failed: Up still recalls what was typed, and a large rewrite
							// shows collapsed.
							this.ctx.editor.addToHistory(typedText);
							if (outcome.text.length > CHAIN_DISPLAY_COLLAPSE_CHARS) {
								this.ctx.editor.setText("");
								this.ctx.editor.insertPaste(outcome.text);
							} else {
								this.ctx.editor.setCollapsedText(outcome.text);
							}
						}
						return;
					}
					text = outcome.text;
				} finally {
					this.ctx.editor.clearSubmittedDraft();
					runWithoutDetachedDraft(() => this.#releaseChainComposer());
				}
			}
			// The submitted-draft snapshot served the live hold and the chain; it holds paste
			// payloads, so release it once the prompt is on its way.
			this.ctx.editor.clearSubmittedDraft();
			// Only the prompt about to reach the main agent, after hooks and the chain.
			if (!deferred && this.ctx.liveCallActive) this.ctx.shareLiveSubmit(text);

			// If streaming, use prompt() with steer behavior
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.ctx.session.isStreaming) {
				this.ctx.editor.addToHistory(!deferred && this.ctx.liveCallActive ? text : typedText);
				// Enter already cleared the editor synchronously. Clearing after an
				// awaited input hook would erase new text or an unbracketed paste tail.
				this.ctx.editor.imageLinks = undefined;
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.editor.pendingImages = [];
				this.ctx.editor.pendingImageLinks = [];
				// Record the signature so the queued message's eventual delivery
				// (a user-role `message_start` event) leaves any draft the user has
				// typed since queuing intact. Same protection as #783, applied to
				// the streaming/queue path.
				try {
					const forwarded = await this.ctx.withLocalSubmission(
						text,
						() => this.ctx.session.prompt(text, { streamingBehavior: "steer", images }),
						{ imageCount: images?.length ?? 0 },
					);
					// An inline `/loop` body arms the loop only after dispatch
					// confirms it was forwarded: arming before the await would
					// retain a body whose dispatch rejects, resubmitting a failed
					// prompt after every yield. A rejection leaves prior loop
					// state untouched, so the previous body (if any) survives.
					if (submittedMode === "loop" && forwarded) this.ctx.setLoopPrompt(text);
				} catch (error) {
					this.#restoreRejectedPrompt(text, images, inputImageLinks);
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				}
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
				return;
			}
			// Normal message submission
			// While loop mode is on, an idle user-typed prompt becomes the new loop
			// prompt that auto-resubmits after each yield. This arms synchronously,
			// before any await: arming after a turn-length dispatch would race the
			// reschedule timer and strand the waiter. Non-forward outcomes (local
			// consume, rejection) park the loop at their own dispatch sites, so a
			// failed body degrades to idle instead of looping errors.
			if (this.ctx.loopModeEnabled) {
				this.ctx.setLoopPrompt(text);
			}
			// First, move any pending bash components to chat
			this.ctx.flushPendingBashComponents();

			if (this.ctx.onInputCallback) {
				// Include any pending images from clipboard paste
				this.ctx.editor.imageLinks = undefined;
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.editor.pendingImages = [];
				this.ctx.editor.pendingImageLinks = [];

				// Render user message immediately, then let session events catch up.
				// Tag the submission as "steer": this is a normal Enter the controller
				// believed was idle, but a background turn can start in the gap before
				// `submitInteractiveInput` dispatches it. Steering matches the
				// streaming-branch Enter (above) and keeps the message from throwing
				// AgentBusyError on that race.
				const submission = this.ctx.startPendingSubmission(
					{
						text,
						images,
						imageLinks: inputImageLinks,
						streamingBehavior: "steer",
					},
					{ clearEditor: false },
				);
				const consumed = waitForDeferredInput(submission);
				this.ctx.onInputCallback(submission);
				await consumed;
			} else {
				// No input waiter: the main loop is between turns (post-turn
				// epilogue, retry backoff, or a scheduled continue) with the agent
				// momentarily idle. The editor already cleared itself on Enter, so
				// falling through here would silently swallow the message. Submit a
				// real prompt directly; if a background turn starts in the gap,
				// `streamingBehavior: "steer"` preserves the typed-message queueing
				// semantics instead of throwing AgentBusyError.
				this.ctx.editor.imageLinks = undefined;
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.editor.pendingImages = [];
				this.ctx.editor.pendingImageLinks = [];
				try {
					const forwarded = await this.ctx.withLocalSubmission(
						text,
						() => this.ctx.session.prompt(text, { streamingBehavior: "steer", images }),
						{
							imageCount: images?.length ?? 0,
						},
					);
					// The idle block above already armed this body synchronously.
					// A locally-consumed dispatch starts no turn: park the armed
					// loop instead of resubmitting a local action on next idle.
					if (!forwarded && this.ctx.loopPrompt === text) this.ctx.pauseLoop();
				} catch (error) {
					this.#restoreRejectedPrompt(text, images, inputImageLinks);
					this.ctx.showError(error instanceof Error ? error.message : String(error));
					// Dispatch rejected after the body was armed: park it so the
					// failed prompt is not resubmitted on next idle.
					if (this.ctx.loopPrompt === text) this.ctx.pauseLoop();
				}
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
			this.ctx.editor.addToHistory(!deferred && this.ctx.liveCallActive ? text : typedText);
		};
	}

	/** A voice handoff of the draft's speech landed as the operator submitted: put the draft back
	 *  (submit already emptied the composer) for review instead of sending it twice. */
	#holdForLiveHandoff(text: string): void {
		// The draft as displayed, spoken spans included, so the landing handoff can still remove
		// its speech from it.
		if (!this.ctx.editor.restoreSubmittedDraft()) this.ctx.editor.setCollapsedText(text);
		this.ctx.showStatus(LIVE_HANDOFF_HOLD_STATUS);
	}

	/** Chain keybinding: submit the composer through the active chain once. */
	/**
	 * Run one REPL cell in the selected kernel. The code keeps its indentation;
	 * local execution stays host-only in collab and consumes dictated speech.
	 */
	async #runReplCell(code: string): Promise<void> {
		const target = this.ctx.replMode.target;
		if (target === "agent") return;
		const restore = () => this.ctx.editor.setText(code);
		if (this.ctx.collabGuest) {
			this.ctx.showStatus("Local execution is host-only during a collab session");
			restore();
			return;
		}
		if (this.ctx.liveCallActive && !this.ctx.discardLiveSpeech()) {
			this.#holdForLiveHandoff(code);
			return;
		}
		if (target === "bash") {
			if (this.ctx.session.isBashRunning) {
				this.ctx.showWarning("A bash command is already running. Press Esc to cancel it first.");
				restore();
				return;
			}
			this.ctx.editor.addToHistory(code);
			this.ctx.editor.clearDraft();
			await this.ctx.handleBashCommand(code);
			return;
		}
		if (this.ctx.session.isEvalLanguageRunning(target)) {
			this.ctx.showWarning(`The ${target} kernel is busy. Press Esc to cancel it first.`);
			restore();
			return;
		}
		this.ctx.editor.addToHistory(code);
		this.ctx.editor.clearDraft();
		await this.ctx.handleEvalCommand(target, code, false, this.ctx.replMode.takeReset(target), target);
	}

	#submitToRepl(): void {
		if (!this.ctx.editor.getText().trim()) return;
		this.#replNextSubmit = true;
		this.ctx.editor.submit();
	}

	#submitThroughChain(): void {
		if (!this.ctx.editor.getText().trim()) return;
		this.#chainNextSubmit = true;
		this.ctx.editor.submit();
	}

	/**
	 * Rewrite `text` with the active chain, asking which chain to use when none
	 * is active (the pick becomes active). `send: false` puts `text` back in the
	 * composer instead of sending: no chain, a cancelled pick, an abort (the typed
	 * draft), or a failed step (the last completed output).
	 *
	 * While the chain runs the composer is locked and shimmering; Esc Esc skips the
	 * step in flight, Esc Esc Esc or the clear key aborts.
	 */
	async #applyPostProcessingChain(text: string): Promise<{ text: string; send: boolean }> {
		const control = new ChainControl();
		const gesture = new EscapeGesture();
		let lastOutput = text;
		let chainName = "";
		let currentStep = "";
		// Lock before resolving the chain: submit already emptied the buffer, and anything typed
		// while CHAINS.yml loads or the picker is open would be overwritten. Text typed while
		// input hooks ran is kept in local history rather than lost. The draft goes back as
		// displayed so the lock has something to shimmer.
		if (this.ctx.editor.getText().trim()) {
			this.ctx.editor.rememberDraft();
			this.ctx.showStatus("Text typed during submit saved to history (Up)");
		}
		if (!this.ctx.editor.restoreSubmittedDraft()) this.ctx.editor.setCollapsedText(text);
		this.ctx.editor.setChainLock({
			onEscape: () => {
				const action = gesture.press();
				if (action === "skip") {
					control.skipStep();
					if (currentStep) this.ctx.showStatus(`Chain ${chainName}: skipping "${currentStep}"…`);
				} else if (action === "abort") {
					control.abort();
				}
			},
			// Never handleCtrlC: its double-press exit must not race a running step.
			onClear: () => control.abort(),
		});
		this.ctx.ui.requestRender();
		let resolved: ChainConfig | typeof SEND_WITHOUT_CHAIN | undefined;
		try {
			resolved = await this.#resolveActiveChain();
		} catch (error) {
			this.ctx.editor.setChainLock(undefined);
			throw error;
		}
		if (resolved === SEND_WITHOUT_CHAIN || !resolved || control.signal.aborted) {
			this.ctx.editor.setChainLock(undefined);
			const send = resolved === SEND_WITHOUT_CHAIN && !control.signal.aborted;
			// Sending: the composer held the draft only for the lock, restored pastes included.
			if (send) {
				this.ctx.editor.clearPasteState();
				this.ctx.editor.setText("");
			}
			return { text, send };
		}
		const chain = resolved;
		chainName = chain.name;
		currentStep = enabledChainSteps(chain)[0]?.name ?? "";
		this.ctx.ui.requestRender();
		try {
			const result = await runChain(chain, text, {
				settings: this.ctx.settings,
				modelRegistry: this.ctx.session.modelRegistry,
				sessionManager: this.ctx.sessionManager,
				onEffortNotice: (message: string) => this.ctx.session.emitNotice("warning", message, "effort-policy"),
				tools: this.ctx.session.agent.state.tools,
				messages: this.ctx.session.agent.state.messages,
				obfuscator: this.ctx.session.obfuscator,
				cwd: this.ctx.sessionManager.getCwd(),
				control,
				onStep: (step, index, total) => {
					currentStep = step.name;
					this.ctx.showStatus(
						`Chain ${chain.name} · step ${index + 1}/${total} "${step.name}" · preprocessing… (Esc Esc skip · Esc Esc Esc abort · Ctrl+C abort)`,
					);
				},
				onStepDone: (_step, _index, output) => {
					lastOutput = output;
					// A large rewrite shows collapsed: the lock re-renders the composer every frame.
					// Drop the previous preview's paste payload; the submitted-draft snapshot stays.
					this.ctx.editor.clearPasteState();
					this.ctx.editor.setText("");
					if (output.length > CHAIN_DISPLAY_COLLAPSE_CHARS) this.ctx.editor.insertPaste(output);
					else this.ctx.editor.setText(output);
					this.ctx.ui.requestRender();
				},
				onStepSkipped: step => this.ctx.showStatus(`Chain ${chain.name}: skipped "${step.name}"`),
			});
			this.ctx.showStatus("");
			// Sending: the composer showed the rewrite only while the lock held it.
			this.ctx.editor.setText("");
			return { text: result, send: true };
		} catch (error) {
			if (control.signal.aborted) {
				this.ctx.showStatus("Chain aborted; draft restored");
				return { text, send: false };
			}
			this.ctx.showStatus("");
			// Not showError: it clears the loading state of a primary turn that may be streaming.
			this.ctx.showWarning(
				`Chain ${chain.name} failed at step "${currentStep}"; composer holds the last completed output: ${error instanceof Error ? error.message : String(error)}`,
			);
			return { text: lastOutput, send: false };
		} finally {
			// Preview pastes belong to the lock; the caller restores or replaces the draft next.
			this.ctx.editor.clearPasteState();
			this.ctx.editor.setChainLock(undefined);
		}
	}

	async #resolveActiveChain(): Promise<ChainConfig | typeof SEND_WITHOUT_CHAIN | undefined> {
		const { chains, warnings } = await discoverChains(this.ctx.sessionManager.getCwd(), getAgentDir());
		if (warnings.length > 0) this.ctx.showWarning(`CHAINS.yml: ${warnings.join("; ")}`);
		if (chains.length === 0) {
			this.ctx.showWarning("No post-processing chains defined. Create one with /chain configure.");
			return undefined;
		}
		const activeName = cfgChainingActive.get(settings);
		const active = chains.find(chain => chain.name === activeName);
		if (active) return active;
		const choice = await this.ctx.showHookSelector("Post-processing chain", [
			...chains.map(chain => chain.name),
			SEND_WITHOUT_CHAIN,
		]);
		if (choice === undefined) return undefined;
		if (choice === SEND_WITHOUT_CHAIN) return SEND_WITHOUT_CHAIN;
		const picked = chains.find(chain => chain.name === choice);
		if (picked) cfgChainingActive.set(settings, picked.name);
		return picked;
	}

	/**
	 * Map a bare command word (no leading `/`) to its slash form, or return
	 * `undefined` to leave the submission as a prompt. The whole submitted input
	 * must be the word — no surrounding whitespace, arguments, attachments, or
	 * extension rewrite — so ordinary prose never changes meaning.
	 *
	 * An "empty session" has no messages and nothing in flight: a first prompt
	 * still pending, in preflight, or streaming has not reached `messages` yet.
	 *
	 * - `input.bareExitOnEmptySession` (default on): `exit`/`quit`/`q` in any
	 *   case run immediately in an empty session. Nobody opens a fresh session
	 *   to send that word to the model.
	 * - `input.bareSlashCommands` (opt-in): any known command name or alias
	 *   (exact spelling first, then case-folded), in any session state. Once a
	 *   conversation exists the word may be a genuine reply, so the first Enter
	 *   returns `confirm` and only a repeat of the same word (`armed`) runs it.
	 *
	 * Collab-guest gating applies unchanged in the slash dispatch that follows.
	 */
	#resolveBareSlashCommand(
		text: string,
		submittedText: string,
		hasImages: boolean,
		armed: string | undefined,
	): { command: string; confirm: boolean } | undefined {
		if (text !== submittedText || hasImages || !text || text.startsWith("/") || /\s/.test(text)) return undefined;
		const emptySession =
			!this.ctx.session.isStreaming &&
			this.ctx.locallySubmittedUserSignatures.size === 0 &&
			this.ctx.session.messages.length === 0;
		const folded = text.toLowerCase();
		if (
			emptySession &&
			Object.hasOwn(BARE_EXIT_WORDS, folded) &&
			(!isSettingsInitialized() || cfgBareExitOnEmptySession.get(settings))
		) {
			return { command: `/${folded}`, confirm: false };
		}
		if (!isSettingsInitialized() || !cfgBareSlashCommands.get(settings)) return undefined;
		for (const token of folded === text ? [text] : [text, folded]) {
			if (lookupBuiltinSlashCommand(token) || this.#isKnownNonBuiltinSlashCommandToken(token)) {
				return { command: `/${token}`, confirm: !emptySession && armed !== text };
			}
		}
		return undefined;
	}

	/** Whether `token` names a skill, file, extension, custom, or prompt-template command. */
	#isKnownNonBuiltinSlashCommandToken(token: string): boolean {
		const session = this.ctx.session;
		return (
			this.ctx.skillCommands.has(token) ||
			this.ctx.fileSlashCommands.has(token) ||
			session.extensionRunner?.getCommand(token) !== undefined ||
			session.customCommands.some(loaded => loaded.command.name === token) ||
			session.promptTemplates.some(template => template.name === token)
		);
	}

	/**
	 * Answer `text` as a /btw side question when it invokes a `side: true` file command.
	 * Extension, custom and skill commands keep precedence over a file command of the same name.
	 * `draft.detach` releases the submission's remaining editor state before the side question
	 * runs; `draft.restore` hands the submission back when its template fails to render.
	 */
	async #runSideFileCommand(text: string, draft: { detach?: () => void; restore: () => void }): Promise<boolean> {
		const invocation = parseFileSlashInvocation(text);
		if (!invocation || !this.ctx.fileSlashCommands.has(invocation.name)) return false;
		const session = this.ctx.session;
		if (session.extensionRunner?.getCommand(invocation.name) !== undefined) return false;
		if (session.customCommands.some(loaded => loaded.command.name === invocation.name)) return false;
		if (isKnownSkillCommand(this.ctx, text)) return false;
		const command = session.slashCommands.find(cmd => cmd.name === invocation.name);
		if (!command?.side) return false;
		let question: string;
		try {
			question = renderFileSlashCommand(command, invocation.args);
		} catch (error) {
			draft.restore();
			this.ctx.showError(error instanceof Error ? error.message : String(error));
			return true;
		}
		this.ctx.editor.addToHistory(text);
		draft.detach?.();
		const args = invocation.args.trim();
		await this.ctx.handleBtwCommand(question, undefined, args ? `/${command.name} ${args}` : `/${command.name}`);
		return true;
	}

	/** Put back a submission the editor reset on Enter, unless a newer draft took its place. */
	#restoreResetSubmission(submittedText: string): void {
		if (!this.ctx.editor.getText()) this.ctx.editor.setText(submittedText);
	}

	/**
	 * Detach a side command's submission without erasing input that arrived while it
	 * awaited dispatch: the whole draft clears only while the editor still holds
	 * `draftText`; otherwise only the submitted attachments drop, and only while they
	 * are still the live prefix.
	 */
	#detachSideSubmission(draftText: string, images: ImageContent[] | undefined): void {
		if (this.ctx.editor.getText() === draftText) this.ctx.editor.clearDraft();
		else this.#dropSubmittedPending(images);
	}

	/** Whether `text` dispatches to a builtin, matching executeBuiltinSlashCommand(). */
	#matchesBuiltinSlashCommand(text: string): boolean {
		const parsed = parseSlashCommand(text);
		if (!parsed) return false;
		const builtin = lookupBuiltinSlashCommand(parsed.name);
		return builtin !== undefined && (builtin.allowArgs === true || !parsed.args);
	}

	/** Whether `text` invokes a registered extension command, which runs locally instead of prompting the model. */
	#isLocalExtensionCommand(text: string): boolean {
		const extensionCommandSpace = text.indexOf(" ");
		return (
			text.startsWith("/") &&
			this.ctx.session.extensionRunner?.getCommand(
				extensionCommandSpace === -1 ? text.slice(1) : text.slice(1, extensionCommandSpace),
			) !== undefined
		);
	}

	/** Submit chat, viewer commands, or session-only /fast to the focused subagent. */
	async #submitToFocusedSession(text: string, streamingBehavior: "steer" | "followUp"): Promise<void> {
		const target = this.ctx.viewSession;
		const draftText = this.ctx.editor.getText();
		const images = this.ctx.editor.pendingImages.length > 0 ? [...this.ctx.editor.pendingImages] : undefined;
		const imageLinks =
			images && this.ctx.editor.pendingImageLinks.length > 0 ? [...this.ctx.editor.pendingImageLinks] : undefined;
		if (!text && !images) {
			if (target.isStreaming && target.hasInterruptibleInput) {
				const aborting = target.abort({ reason: USER_INTERRUPT_LABEL });
				await aborting;
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
			return;
		}
		if (text?.startsWith("/")) {
			const parsed = parseSlashCommand(text);
			if (parsed?.name === "fast") {
				try {
					const message = runSubagentFastCommand(target, parsed.args);
					this.#recordSlashCommandUsage(text);
					if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
					this.ctx.editor.clearDraft(text);
					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorBorderColor();
					this.ctx.showStatus(message);
					this.ctx.ui.requestRender();
				} catch (error) {
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				}
				return;
			}
			const name = parsed && lookupBuiltinSlashCommand(parsed.name)?.name;
			if (parsed && name && FOCUSED_VIEW_COMMANDS[name]?.(parsed.args)) {
				// Viewer-scoped commands: /btw asks about the focused transcript, /export
				// writes it (with its own subagents), /jobs lists the focused agent's jobs
				// without a way to cancel them, /usage reports account-wide limits, and
				// /effort changes the focused agent's thinking. Model controls stay main-session-only.
				this.#recordSlashCommandUsage(text);
				const input = images ? { images, imageLinks } : undefined;
				if ((await executeBuiltinSlashCommand(text, { ctx: this.ctx, input })) === true) {
					if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
					return;
				}
			}
		}
		// Builtins keep precedence over side file commands.
		if (
			text &&
			!this.#matchesBuiltinSlashCommand(text) &&
			(await this.#runSideFileCommand(text, {
				detach: () => this.#detachSideSubmission(draftText, images),
				restore: () => this.#restoreResetSubmission(text),
			}))
		) {
			return;
		}
		if (
			text &&
			(text.startsWith("/") ||
				text.startsWith("!") ||
				parseReplEvalInput(text, this.ctx.session.extensionRunner?.getEvalBackendAliases()))
		) {
			this.ctx.showStatus(
				`Only ${FOCUSED_VIEW_COMMAND_LIST} run here; other commands run in the main session — press ${formatDoubleTap("left")} to return first`,
			);
			return; // editor text not cleared: Editor does not auto-clear on submit
		}
		const isContinueShortcut = streamingBehavior === "steer" && !images && (text === "." || text === "c");
		this.ctx.editor.clearDraft(text);
		try {
			// Continue shortcuts do not request queueing: keep rejecting them while
			// busy instead of scheduling another continuation behind the active turn.
			if (isContinueShortcut) {
				await target.resume();
			} else {
				await this.ctx.withLocalSubmission(text, () => target.prompt(text, { streamingBehavior, images }), {
					imageCount: images?.length ?? 0,
				});
			}
		} catch (error) {
			// Hand the message back, mirroring the main submit error path: restore
			// pasted images so the user can retry an image-only or text+image draft.
			if (images && images.length > 0) {
				this.ctx.editor.pendingImages = [...images];
				this.ctx.editor.pendingImageLinks = imageLinks ? [...imageLinks] : images.map(() => undefined);
				this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
			}
			this.ctx.editor.setCollapsedText(text);
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
		this.ctx.updatePendingMessagesDisplay();
		this.ctx.ui.requestRender();
	}

	handleCtrlC(): void {
		// Sync-flush the session JSONL so in-flight writes survive a hard exit.
		// The TUI consumes Ctrl+C as a key event in raw mode, so postmortem's
		// process-level SIGINT handler never fires. shutdown() awaits its own
		// async flush — this sync pass is a superset that also covers the
		// first-press case and the hard-abort path below.
		try {
			this.ctx.sessionManager.flushSync();
		} catch (err) {
			logger.warn("session-manager sync flush on Ctrl+C failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// Hard-abort: a Ctrl+C arriving while shutdown() is already running
		// means the user has waited long enough for whatever teardown step is
		// stuck (typically an extension's session_shutdown handler hanging on
		// IPC). The 2s session_shutdown cap (see runner.ts) already bounds the
		// common case; this is the defense-in-depth ladder for everything
		// else. See issue #2600.
		if (this.ctx.isShuttingDown) {
			// Route through postmortem: this hard-abort can fire while an
			// extension-load guard window is open, where raw process.exit is a
			// throwing ExtensionExitError stub (#11789). exitProcess skips the
			// postmortem cleanups, so hand the terminal back first: shutdown() has
			// not reached ui.stop() yet, and a kitty keyboard frame left pushed
			// makes the parent shell receive Ctrl+C as `CSI 99;5u` (prints `9;5u`).
			emergencyTerminalRestore();
			postmortem.exitProcess(130); // 128 + SIGINT
		}

		// A graceful close already failed at the memoized dispose stage (#12238),
		// so re-running it can only re-fail. The user was told one more Ctrl+C
		// exits; honour that with a single press — skip the double-tap gate below
		// and let shutdown() take its force-quit escape hatch.
		if (this.ctx.teardownFailed) {
			void this.ctx.shutdown();
			return;
		}

		const now = Date.now();
		if (now - this.ctx.lastSigintTime < 500) {
			void this.ctx.shutdown();
		} else {
			this.ctx.discardLiveSpeech();
			this.ctx.clearEditor();
			this.ctx.lastSigintTime = now;
		}
	}

	handleCtrlD(): void {
		// Editor text (if any) is snapshotted at the start of shutdown() and
		// persisted as a draft for the next resume. Empty text is also fine —
		// shutdown clears any stale sidecar in that case.
		void this.ctx.shutdown();
	}

	handleCtrlZ(): void {
		// Job-control suspend is POSIX-only: on Windows `process.kill(_, "SIGSTOP")`
		// throws `TypeError: Unknown signal: SIGSTOP` and takes the whole agent down
		// via an uncaught exception (issue #2036, originally for SIGTSTP — same
		// shape for SIGSTOP). No-op on platforms that cannot suspend.
		if (process.platform === "win32") {
			this.ctx.showStatus(
				`Suspend (${appKey(this.ctx.keybindings, "app.suspend")}) is not supported on this platform`,
			);
			return;
		}

		// TUI teardown pauses stdin, which leaves Bun with no referenced handles
		// while the editor waits on an unresolved Promise. Keep the event loop
		// alive across SIGSTOP so it can deliver SIGCONT; without this handle Bun
		// exits successfully immediately after `fg` instead of restarting the TUI
		// (issue #8585).
		const suspendKeepalive = setInterval(() => {}, 2 ** 30);

		// Capture the listener so we can detach it if the signal never fires;
		// otherwise a failed suspend would leave a stale SIGCONT handler that
		// fires on the next unrelated continue and tries to re-`start()` an
		// already-running TUI.
		const onResume = (): void => {
			clearInterval(suspendKeepalive);
			this.ctx.ui.start();
			this.ctx.ui.requestRender(true);
			resendProgramStatus();
		};
		process.once("SIGCONT", onResume);

		// Stop the TUI (restore terminal to normal mode) before sending the
		// signal so the parent shell sees a sane terminal state.
		this.ctx.ui.stop();

		try {
			// SIGSTOP — not SIGTSTP — to the foreground process group (pid=0).
			//
			// SIGTSTP: brush-core (the embedded shell behind every bash tool call)
			// installs a tokio SIGTSTP listener on `Process::wait` to detect when
			// its children have been stopped (`crates/vendor/brush-core/src/sys/
			// unix/signal.rs::tstp_signal_listener` → `tokio::signal::unix::
			// signal(SIGTSTP)`). Per tokio's documented contract, the first call
			// for a given SignalKind permanently replaces the kernel-default
			// handler for the lifetime of the process. So once the user has
			// issued even one bash command — e.g. `/usr/bin/true` — SIGTSTP no
			// longer stops NeoPi: tokio swallows it and the TUI ends up torn down
			// while the process keeps running with no live terminal (issue
			// [#3461]). SIGSTOP cannot be caught, blocked, or ignored, so the
			// kernel stops the process regardless of installed handlers.
			//
			// pid=0 (foreground process group, not just our PID): NeoPi is not
			// always the shell's direct child. Package-manager launchers (`npx`,
			// `pnpm exec`, `bunx`, …) wait on the real CLI from a parent shim
			// that shares NeoPi's process group, and an `npi … | tee log` style
			// pipeline puts a sibling foreground job member in the same group
			// too. The shell sees the job as stopped only when its direct
			// child / pipeline leader is stopped, so suspending only our PID
			// leaves wrappers and pipeline peers running and the terminal
			// hung — exactly the failure shape we're fixing. Stopping the whole
			// group keeps the shell's job-control view consistent. Long-lived
			// children that must survive the suspend (Linux/other POSIX MCP stdio
			// servers via the platform-specific `detached: true` spawn in
			// `mcp/transports/stdio.ts`, every brush external command via brush's
			// per-child `setsid` in `crates/vendor/brush-core/src/commands.rs`) are
			// their own sessions, so pgid=0 does not reach them.
			process.kill(0, "SIGSTOP");
		} catch (err) {
			clearInterval(suspendKeepalive);
			// The runtime refused the signal (e.g. seccomp filter blocks SIGSTOP
			// delivery to the process group). Tear the resume hook down and
			// bring the TUI back so the user is not stranded on a frozen prompt.
			process.removeListener("SIGCONT", onResume);
			this.ctx.ui.start();
			this.ctx.ui.requestRender(true);
			const reason = err instanceof Error ? err.message : String(err);
			this.ctx.showError(`Failed to suspend: ${reason}`);
		}
	}

	handleDequeue(): void {
		const popped = this.#popLastQueuedMessage();
		if (!popped) {
			this.ctx.showStatus("No queued messages to restore");
			return;
		}
		// Drop only the popped message's local-submission signature; the messages
		// left in the queue keep theirs so their delivery echo is still recognized
		// as local and does not blank the editor the dequeue just restored to.
		this.ctx.locallySubmittedUserSignatures.delete(`${popped.text}\u0000${popped.images?.length ?? 0}`);
		this.#restoreEntriesToEditor([popped]);
		this.ctx.showStatus("Restored last queued message to editor");
	}

	/**
	 * Pop the last restorable message from the viewed session's agent queues.
	 * Only the main session owns the separate compaction queue; focused views
	 * must not restore its messages into a subagent's composer.
	 */
	#popLastQueuedMessage(): RestoredQueuedMessage | undefined {
		const fromQueue = this.ctx.viewSession.popLastQueuedMessage();
		if (fromQueue) return fromQueue;
		if (this.ctx.focusedAgentId) return undefined;
		const compaction = this.ctx.compactionQueuedMessages;
		if (compaction.length === 0) return undefined;
		const last = compaction[compaction.length - 1];
		this.ctx.compactionQueuedMessages = compaction.slice(0, -1);
		return { text: last.text, images: last.images };
	}

	/**
	 * Dispatch a `/skill:<name> [args]` invocation through `promptCustomMessage`
	 * using the supplied `streamingBehavior`. Returns false when the text is not
	 * a registered skill command and leaves the editor state untouched. Registered
	 * skills consume the full composer draft (text plus pending images) before
	 * dispatch; if dispatch rejects, the draft is restored so the user can retry.
	 */
	async #invokeSkillCommand(
		text: string,
		streamingBehavior: "steer" | "followUp",
		images?: ImageContent[],
		imageLinks?: (string | undefined)[],
		preserveDraft = false,
	): Promise<boolean> {
		if (!isKnownSkillCommand(this.ctx, text)) return false;
		const draftImages = images && images.length > 0 ? [...images] : undefined;
		const draftImageLinks = draftImages && imageLinks && imageLinks.length > 0 ? [...imageLinks] : undefined;
		const restoreDraft = () => {
			if (preserveDraft) {
				restoreDetachedDraft(this.ctx.editor, text, draftImages, draftImageLinks);
			} else {
				this.ctx.editor.setText(text);
				if (draftImages && draftImages.length > 0) {
					this.ctx.editor.pendingImages = [...draftImages];
					this.ctx.editor.pendingImageLinks = draftImageLinks
						? [...draftImageLinks]
						: draftImages.map(() => undefined);
					this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
				}
				// Images first: collapsing reads `pendingImages.length` to decide which markers become chips.
				this.ctx.editor.setCollapsedText(text);
			}
		};

		if (preserveDraft) this.ctx.editor.addToHistory(text);
		else this.ctx.editor.clearDraft(text);
		try {
			const dispatched = await invokeSkillCommandFromText(this.ctx, text, streamingBehavior, {
				images: draftImages,
				imageLinks: draftImageLinks,
				optimistic: true,
				propagateErrors: true,
			});
			if (!dispatched) restoreDraft();
			return dispatched;
		} catch (error) {
			restoreDraft();
			this.ctx.showError(error instanceof Error ? error.message : String(error));
			return true;
		} finally {
			if (this.ctx.session.isStreaming) {
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
		}
	}

	async handleRetry(): Promise<void> {
		if (this.ctx.collabGuest) {
			this.ctx.showStatus("/retry is host-only during a collab session");
			return;
		}
		const didRetry = await this.ctx.viewSession.retry();
		if (didRetry) {
			this.ctx.editor.clearDraft();
		} else {
			this.ctx.showStatus("Nothing to retry");
		}
	}

	/**
	 * Queue `/queue` input behind an active turn, or start it immediately when idle.
	 * `detached` is a submission whose draft already left the editor: its
	 * attachments are queued and its text is restored if queueing fails. Without
	 * it, the live editor draft is the submission.
	 */
	async handleQueueCommand(
		text: string,
		detached?: Pick<SubmittedUserInput, "text" | "images" | "imageLinks">,
	): Promise<void> {
		const source = detached ?? {
			images: this.ctx.editor.pendingImages,
			imageLinks: this.ctx.editor.pendingImageLinks,
		};
		const images = source.images?.length ? [...source.images] : undefined;
		const imageLinks = images && source.imageLinks?.length ? [...source.imageLinks] : undefined;
		await this.#queueForYield(text, { images, imageLinks, detachedText: detached?.text });
	}

	async #queueForYield(
		text: string,
		options: {
			historyText?: string;
			images?: ImageContent[];
			imageLinks?: (string | undefined)[];
			/** The submitted draft already left the editor; anything there now is newer. Restored on failure. */
			detachedText?: string;
		},
	): Promise<readonly string[]> {
		// Queue shorthand reaches this helper before the normal guest input gate.
		// Like /queue, it must not submit to the guest's local session.
		if (this.ctx.collabGuest) {
			this.ctx.showStatus("/queue is host-only during a collab session");
			this.ctx.editor.setText(options.detachedText ?? options.historyText ?? text);
			return [];
		}

		const splitMessages = splitQueuedMessages(text);
		if (splitMessages.length === 0 && !options.images?.length) {
			if (options.detachedText === undefined) this.ctx.editor.clearDraft();
			this.ctx.showWarning("Usage: /queue <message> (or start a prompt with -> / =>)");
			return [];
		}

		const messages = splitMessages.length > 0 ? splitMessages : [""];
		const originalDraft = this.ctx.editor.getText();
		const images = options.images?.length ? [...options.images] : undefined;
		const imageLinks = options.imageLinks
			? [...options.imageLinks]
			: images
				? images.map(() => undefined)
				: undefined;
		if (options.detachedText === undefined) this.ctx.editor.clearDraft(options.historyText);

		if (this.ctx.session.isCompacting) {
			for (let index = 0; index < messages.length; index++) {
				this.ctx.compactionQueuedMessages.push({
					text: messages[index] ?? "",
					mode: "followUp",
					images: index === 0 ? images : undefined,
				});
			}
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.showStatus(
				messages.length === 1
					? "Queued message for after compaction"
					: `Queued ${messages.length} messages for after compaction`,
			);
			this.ctx.ui.requestRender();
			return messages;
		}

		const startImmediately = !this.ctx.session.isStreaming && this.ctx.session.queuedMessageCount === 0;
		let queuedCount = 0;
		try {
			if (startImmediately && this.ctx.onInputCallback) {
				const first = messages[0] ?? "";
				const submission = this.ctx.startPendingSubmission({
					text: first,
					images,
					imageLinks,
					streamingBehavior: "followUp",
				});
				this.ctx.onInputCallback(submission);
				queuedCount = 1;
			}
			while (queuedCount < messages.length) {
				const message = messages[queuedCount] ?? "";
				const queuedImages = queuedCount === 0 ? images : undefined;
				await this.ctx.withLocalSubmission(
					message,
					async () => {
						if (startImmediately && queuedCount === 0) {
							await this.ctx.session.prompt(message, {
								images: queuedImages,
								streamingBehavior: "followUp",
							});
						} else {
							await this.ctx.session.followUp(message, queuedImages);
						}
					},
					{ imageCount: queuedImages?.length ?? 0 },
				);
				queuedCount++;
			}
		} catch (error) {
			if (queuedCount === 0) {
				if (options.detachedText !== undefined) {
					restoreDetachedDraft(this.ctx.editor, options.detachedText, images, imageLinks);
				} else {
					this.ctx.editor.setText(originalDraft);
					if (images) {
						this.ctx.editor.pendingImages = images;
						this.ctx.editor.pendingImageLinks = imageLinks ?? images.map(() => undefined);
						this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
					}
				}
			} else {
				const remaining = messages.slice(queuedCount);
				const restored =
					remaining.length === 1
						? `=> ${remaining[0]}`
						: `=>\n${remaining
								.map((message, index) => `${index + 1}. ${message.replaceAll("\n", "\n   ")}`)
								.join("\n")}`;
				if (options.detachedText !== undefined) restoreDetachedDraft(this.ctx.editor, restored);
				else this.ctx.editor.setText(restored);
			}
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}

		this.ctx.updatePendingMessagesDisplay();
		if (queuedCount === messages.length) {
			this.ctx.showStatus(
				startImmediately
					? queuedCount === 1
						? "Sent queued message"
						: `Sent first message; queued ${queuedCount - 1} for later yields`
					: queuedCount === 1
						? "Queued message for when the agent yields"
						: `Queued ${queuedCount} messages for when the agent yields`,
			);
		}
		this.ctx.ui.requestRender();
		return messages.slice(0, queuedCount);
	}

	/** Send editor text as a follow-up message (queued behind current stream). */
	async handleFollowUp(): Promise<void> {
		const draft = this.ctx.editor.getExpandedText();
		if (parseSlashCommand(draft.trimStart())?.name === "notice") {
			// A notice is an operator command, independent of the prose follow-up chord.
			await this.ctx.editor.onSubmit?.(draft);
			return;
		}
		let text = this.#compactDraftImages(draft.trim());
		let images = this.ctx.editor.pendingImages.length > 0 ? [...this.ctx.editor.pendingImages] : undefined;
		let imageLinks =
			images && this.ctx.editor.pendingImageLinks.length > 0 ? [...this.ctx.editor.pendingImageLinks] : undefined;
		if (!text && !images) return;
		// Sending the composer is the operator's handoff on this path too. The draft is still in
		// the composer here, so holding only needs the status.
		if (this.ctx.liveCallActive && !this.ctx.discardLiveSpeech()) {
			this.ctx.showStatus(LIVE_HANDOFF_HOLD_STATUS);
			return;
		}

		// Focused subagent session: follow-ups go to it; non-chat input is gated.
		if (this.ctx.focusedAgentId && !this.ctx.approvalOwnsComposer) {
			await this.#submitToFocusedSession(text, "followUp");
			return;
		}

		// Detach before the first await: another Ctrl+Enter cannot submit the
		// same draft, and later typing belongs to the next submission.
		this.ctx.editor.clearDraft();

		if (this.ctx.session.hasPendingDeferredExtensions) await this.ctx.session.loadDeferredExtensions();
		if (this.ctx.session.extensionRunner?.hasHandlers("input")) {
			try {
				const input = await this.#runInputHandlers(text, images, imageLinks);
				if (!input) return;
				({ text, images, imageLinks } = input);
			} catch (error) {
				restoreDetachedDraft(this.ctx.editor, text, images, imageLinks);
				this.ctx.showError(error instanceof Error ? error.message : String(error));
				return;
			}
		}

		// Ctrl+Enter detached the draft before the first await, so a side command
		// has no editor state left to release; a render failure hands it back.
		const restoreSideDraft = { restore: () => restoreDetachedDraft(this.ctx.editor, text, images, imageLinks) };

		// Compaction first: while compacting, free text gets queued via
		// `queueCompactionMessage`, and `/skill:*` rides the same queue so a
		// skill typed during compaction is not lost or short-circuited through
		// `promptCustomMessage`. The compaction-resume path re-parses the
		// queued text into a user-attributed skill invocation before delivery.
		// Side commands answer now instead: the queue would deliver them as a
		// main-turn prompt. Builtins keep precedence, as in the dispatch below.
		if (this.ctx.session.isCompacting) {
			if (
				text &&
				!this.#matchesBuiltinSlashCommand(text) &&
				(await this.#runSideFileCommand(text, restoreSideDraft))
			) {
				return;
			}
			this.ctx.queueCompactionMessage(text, "followUp", images, { preserveDraft: true });
			return;
		}

		if (text) {
			try {
				const input =
					(images?.length ?? 0) > 0 || (imageLinks?.length ?? 0) > 0 ? { images, imageLinks } : undefined;
				const slashResult = await executeBuiltinSlashCommand(text, { ctx: this.ctx, input, draftDetached: true });
				if (slashResult === true) {
					if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
					return;
				}
				if (typeof slashResult === "string") {
					// Command handled but returned remaining text to use as prompt.
					// Record the original slash command text so Up Arrow recalls it.
					if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
					text = slashResult;
				}
			} catch (error) {
				restoreDetachedDraft(this.ctx.editor, text, images, imageLinks);
				this.ctx.showError(error instanceof Error ? error.message : String(error));
				return;
			}
		}

		if (text && (await this.#runSideFileCommand(text, restoreSideDraft))) return;

		// Skill commands invoke through the custom-message path regardless of
		// which keybinding submitted them. Enter routes them as `steer`;
		// Ctrl+Enter (this handler) routes them as `followUp`.
		if (text && (await this.#invokeSkillCommand(text, "followUp", images, imageLinks, true))) {
			return;
		}

		// Hand the message back on dispatch failure (model/API-key validation,
		// queue rejection): restore both text AND pending images so an image-only
		// or text+image draft can be retried, mirroring the main submit error path.
		const restoreOnError = (error: unknown) => {
			restoreDetachedDraft(this.ctx.editor, text, images, imageLinks);
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		};

		if (this.ctx.session.isStreaming) {
			this.ctx.editor.addToHistory(text);
			try {
				await this.ctx.withLocalSubmission(
					text,
					() => this.ctx.session.prompt(text, { streamingBehavior: "followUp", images }),
					{ imageCount: images?.length ?? 0 },
				);
			} catch (error) {
				restoreOnError(error);
			}
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.ui.requestRender();
			return;
		}

		// Not streaming — just submit normally
		this.ctx.editor.addToHistory(text);
		try {
			await this.ctx.withLocalSubmission(text, () => this.ctx.session.prompt(text, { images }), {
				imageCount: images?.length ?? 0,
			});
		} catch (error) {
			restoreOnError(error);
		}
	}

	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		this.ctx.locallySubmittedUserSignatures.clear();
		// On Esc (abort) the abort below records queued extension/agent messages in the
		// transcript without a turn, so the post-abort drain can't auto-resume on them;
		// plain Alt+Up dequeue leaves them queued for the continuing stream.
		const { steering, followUp } = this.ctx.session.clearQueue({ forInterrupt: options?.abort });
		// Messages typed while compacting live in `compactionQueuedMessages`, not the
		// agent queue `clearQueue()` drains — but the pending bar shows the same
		// "Alt+Up to edit" hint for them (ui-helpers `updatePendingMessagesDisplay`).
		// Drain them here too so the restore recovers every message the hint
		// advertises; otherwise a skill/text queued during compaction is stranded.
		const compactionQueued = this.ctx.compactionQueuedMessages;
		this.ctx.compactionQueuedMessages = [];
		const allQueued = [
			...steering,
			...compactionQueued.filter(e => e.mode === "steer").map(e => ({ text: e.text, images: e.images })),
			...followUp,
			...compactionQueued.filter(e => e.mode === "followUp").map(e => ({ text: e.text, images: e.images })),
		];
		const restored = this.#restoreEntriesToEditor(allQueued, options?.currentText);
		if (options?.abort) {
			void this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
		}
		return restored;
	}

	/**
	 * Merge queued entries (oldest→newest) ahead of the current draft, folding
	 * their images back into the pending-image buffer and refreshing the pending
	 * bar. Shared by the Alt+Up dequeue (one entry) and the Esc restore-all path.
	 * Returns the number of entries restored.
	 */
	#restoreEntriesToEditor(entries: RestoredQueuedMessage[], currentText?: string): number {
		if (entries.length === 0) {
			this.ctx.updatePendingMessagesDisplay();
			return 0;
		}
		// Image markers are positional: `[Image #N]` ↔ `pendingImages[N-1]`
		// (legacy drafts may still carry a trailing `attachment://N`). Each queued
		// message numbered its references against its own local image list
		// (1..K). Because we prepend the queued text but append the queued images
		// to `pendingImages`, any existing draft images (M of them) — plus images
		// already pulled in by earlier queued messages — shift the slot index that
		// every reference must point to. Bumping each message's marker and URI
		// indices by the running offset keeps the merged text aligned with the merged
		// `pendingImages` order; draft markers stay valid because draft images
		// keep their original positions.
		const queuedImages = entries.flatMap(e => e.images ?? []);
		let queuedText: string;
		if (queuedImages.length > 0) {
			const parts: string[] = [];
			let imageOffset = this.ctx.editor.pendingImages.length;
			for (const entry of entries) {
				parts.push(shiftImageMarkers(entry.text, imageOffset));
				if (entry.images && entry.images.length > 0) imageOffset += entry.images.length;
			}
			queuedText = parts.join("\n\n");
		} else {
			queuedText = entries.map(e => e.text).join("\n\n");
		}
		const current = currentText ?? this.ctx.editor.getText();
		const combinedText = [queuedText, current].filter(t => t.trim()).join("\n\n");
		// Hand queued images back to the pending-image buffer first (links are
		// re-materialized lazily), then set the text: setCollapsedText folds the
		// renumbered `[Image #N, WxH]` references back into chip tokens, and the
		// collapse only recognizes indices within the merged pendingImages range.
		if (queuedImages.length > 0) {
			this.ctx.editor.pendingImages.push(...queuedImages);
			this.ctx.editor.pendingImageLinks.push(...queuedImages.map(() => undefined));
			this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
		}
		this.ctx.editor.setCollapsedText(combinedText);
		this.ctx.updatePendingMessagesDisplay();
		return entries.length;
	}

	async #insertPendingImage(imageData: ImageContent, source?: ImageAttachmentSource): Promise<void> {
		// A paste still normalizing when a chain took the composer would attach an image the
		// chain's submission never sends and its dispatch then clears.
		if (this.ctx.editor.chainLocked) {
			this.ctx.showStatus("The composer is locked while a chain runs");
			return;
		}
		const image: ImageContent = source
			? tagImageAttachmentSource(imageData, source.path, source.kind)
			: { type: "image", data: imageData.data, mimeType: imageData.mimeType };
		// The source URL stays on the image for the model; the chip opens the file itself,
		// or a stable blob copy of the original bytes behind an internal URL (else the payload).
		const [imageLink] = await materializeImageChipLinks([image], this.ctx.sessionManager);
		this.ctx.editor.pendingImages.push(image);
		this.ctx.editor.pendingImageLinks.push(imageLink);
		this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
		const imageNum = this.ctx.editor.pendingImages.length;
		const dims = await this.#imageDimensions(imageData);
		setCachedImageDimensions(image, dims ?? null);
		const kind = source?.kind ?? "image";
		// The buffer holds the compact chip token; the atom table expands it to the bracketed
		// marker (the wire/transcript format) on submit.
		this.ctx.editor.insertAtom(chipLabel(kind, imageNum), formatVisionMarker(kind, imageNum, dims));
		this.ctx.ui.requestRender();
	}

	/** Probe pixel dimensions for the marker label (`[Image #N, WxH]`). Returns undefined when the
	 *  header can't be decoded, so the caller falls back to a bare `[Image #N]`. */
	async #imageDimensions(image: ImageContent): Promise<{ width: number; height: number } | undefined> {
		try {
			const { width, height } = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
			if (width && height) return { width, height };
		} catch {
			// Unknown/corrupt header — fall back to a bare label.
		}
		return undefined;
	}

	/**
	 * Attach a pasted image to an image-accepting prompt, prepared like a main-editor attachment.
	 * Returns the marker, or undefined when the image is unsupported or focus moved meanwhile.
	 */
	async #attachPromptImage(
		target: Component & PasteTarget,
		image: ImageContent,
		unsupportedMessage: string,
		sourcePath?: string,
	): Promise<string | undefined> {
		if (!target.attachImage) return undefined;
		const prepared = await this.#preparePastedImage(image, unsupportedMessage, sourcePath);
		if (!prepared) return undefined;
		const dims = await this.#imageDimensions(prepared.image);
		if (this.ctx.ui.getFocused() !== target) return undefined;
		const attachment = prepared.source
			? tagImageAttachmentSource(prepared.image, prepared.source.path, prepared.source.kind)
			: prepared.image;
		return target.attachImage(attachment, dims);
	}

	async #normalizePastedImage(image: ImageContent, unsupportedMessage: string): Promise<ImageContent | null> {
		let imageData = await ensureSupportedImageInput(image);
		if (!imageData) {
			this.ctx.showStatus(unsupportedMessage);
			return null;
		}
		if (cfgImagesAutoResize.get(settings)) {
			try {
				const resized = await resizeImage({
					type: "image",
					data: imageData.data,
					mimeType: imageData.mimeType,
				});
				imageData = { type: "image", data: resized.data, mimeType: resized.mimeType };
			} catch {
				// Keep the normalized image when resize fails.
			}
		}
		return imageData;
	}

	/**
	 * Normalize a pasted image. Every attachment gets a file so tools can read, copy, or upload it:
	 * file-pasted images keep their original path; clipboard bitmaps are committed to the session
	 * and referenced by a relocation-safe `local://` URL. The reference reaches the model via the
	 * attachment source notice (see `renderAttachmentSourceNotice`).
	 */
	async #preparePastedImage(
		image: ImageContent,
		unsupportedMessage: string,
		sourcePath?: string,
	): Promise<{ image: ImageContent; source: ImageAttachmentSource | undefined } | null> {
		const normalized = await this.#normalizePastedImage(image, unsupportedMessage);
		if (!normalized) return null;
		const path = sourcePath ?? (await this.#persistPastedImage(image));
		return { image: normalized, source: path ? { path, kind: "image" } : undefined };
	}

	async #normalizeAndInsertPastedImage(
		image: ImageContent,
		unsupportedMessage: string,
		sourcePath?: string,
	): Promise<boolean> {
		const prepared = await this.#preparePastedImage(image, unsupportedMessage, sourcePath);
		if (!prepared) return false;
		await this.#insertPendingImage(prepared.image, prepared.source);
		return true;
	}

	/**
	 * Commit clipboard image bytes to the session's `local://` root (inside the session
	 * artifact directory), as pasted: full resolution, before model auto-resize. Named by
	 * content hash so re-pasting the same screenshot reuses one file. Returns the
	 * `local://` URL rather than an absolute path: `/move` relocates the artifact
	 * directory, and the URL resolves against the session's current root. Returns
	 * undefined when the write fails; the image still attaches, just without a reference.
	 */
	async #persistPastedImage(image: ImageContent): Promise<string | undefined> {
		const bytes = Buffer.from(image.data, "base64");
		const extension = blobExtensionForImageMimeType(image.mimeType) ?? "png";
		const url = `local://pasted-image-${Bun.hash(bytes).toString(16)}.${extension}`;
		try {
			const filePath = InternalUrlRouter.instance().locateSync(url, {
				localProtocolOptions: {
					getArtifactsDir: () => this.ctx.sessionManager.getArtifactsDir(),
					getSessionId: () => this.ctx.sessionManager.getSessionId(),
				},
			});
			if (filePath === undefined) throw new Error(`No local file backs ${url}`);
			await Bun.write(filePath, bytes);
			return url;
		} catch (error) {
			logger.warn("failed to persist pasted image", {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	/**
	 * Win+Shift+S on Windows 11 leaves the screenshot bitmap on the clipboard
	 * while the terminal pastes a transient packaged-app TempState path
	 * (…\MicrosoftWindows.Client.Core_*\TempState\…) that is already gone — or
	 * never materialized — by the time we read it. Whenever a pasted image path
	 * can't be turned into an image locally, those clipboard bytes are the real
	 * payload, so prefer them before degrading to a text paste.
	 *
	 * Skipped over SSH: the clipboard read would hit the remote host, not the
	 * terminal that holds the screenshot. Returns true when the clipboard owned
	 * the outcome (image attached, or an unsupported-format status surfaced), so
	 * the caller stops without emitting its own degraded diagnostic.
	 */
	/**
	 * Attach a pasted video path as a contact-sheet preview grid through the
	 * image pipeline. A missing ffmpeg (or probe failure) degrades to a text
	 * paste with an actionable status; ENOENT propagates to the caller's
	 * clipboard-fallback handling.
	 */
	async #insertPendingVideoPreview(pastedPath: string): Promise<void> {
		try {
			const absolutePath = resolveReadPath(pastedPath, this.ctx.sessionManager.getCwd());
			const meta = await probeVideo(absolutePath);
			const sheet = await buildVideoContactSheetPng(absolutePath, meta);
			const preview = await this.#normalizePastedImage(
				{ type: "image", data: sheet.png.data, mimeType: sheet.png.mimeType },
				"Unsupported pasted video preview format",
			);
			if (preview) await this.#insertPendingImage(preview, { path: absolutePath, kind: "video" });
		} catch (error) {
			if (error instanceof VideoError) {
				this.ctx.editor.pasteText(pastedPath);
				this.ctx.ui.requestRender();
				this.ctx.showStatus(error.message);
				return;
			}
			throw error;
		}
	}

	/**
	 * Route an image paste to the focused destination. A focused prompt that did not opt into
	 * images refuses, so the image never lands in the hidden main editor (#6057).
	 */
	async #pasteImageIntoFocus(paste: (sink: ImagePasteSink) => Promise<unknown>): Promise<void> {
		const focused = this.ctx.ui.getFocused();
		if (!focused || focused === this.ctx.editor || !hasPasteText(focused)) {
			await paste(this.#editorImageSink);
			return;
		}
		if (!focused.acceptsImages) {
			this.ctx.showStatus("Image paste is not supported in this prompt");
			return;
		}
		const promptPaste = this.#beginPromptImagePaste(focused);
		try {
			await paste(promptPaste.sink);
		} finally {
			promptPaste.finish();
		}
	}

	/**
	 * Start one paste into an image-accepting prompt. Reserves the prompt's slot before the first
	 * await so a following Enter waits; `finish` delivers the collected text once.
	 */
	#beginPromptImagePaste(target: Component & PasteTarget): PromptImagePaste {
		const finishPaste = target.beginPaste?.();
		const pasted: string[] = [];
		return {
			sink: {
				attach: async (image, unsupportedMessage, sourcePath) => {
					const marker = await this.#attachPromptImage(target, image, unsupportedMessage, sourcePath);
					if (marker === undefined) return false;
					pasted.push(marker);
					return true;
				},
				pasteText: text => {
					pasted.push(text);
				},
			},
			finish: () => {
				const text = pasted.join(" ");
				if (finishPaste) finishPaste(text || undefined);
				else if (text && this.ctx.ui.getFocused() === target) target.pasteText(text);
				this.ctx.ui.requestRender();
			},
		};
	}

	/**
	 * Over SSH the readable clipboard is the remote host's, not the one the user copied into, so a
	 * paste key the terminal forwarded instead of pasting must not read it.
	 */
	#clipboardIsTerminalLocal(): boolean {
		return this.clipboard.isTerminalLocal?.() ?? true;
	}

	async #tryPasteClipboardImage(sink: ImagePasteSink): Promise<boolean> {
		if (!this.#clipboardIsTerminalLocal()) return false;
		try {
			const image = await this.clipboard.readImage();
			if (!image) return false;
			await sink.attach(
				{ type: "image", data: image.data.toBase64(), mimeType: image.mimeType },
				`Unsupported clipboard image format: ${image.mimeType}`,
			);
			return true;
		} catch {
			return false;
		}
	}

	handleImagePathPaste(path: string): Promise<void> {
		return this.#pasteImageIntoFocus(sink => this.#pasteImagePath(path, sink));
	}

	async #pasteImagePath(path: string, sink: ImagePasteSink): Promise<void> {
		try {
			if (isVideoPath(path)) {
				if (sink.attachVideo) {
					await sink.attachVideo(path);
					return;
				}
				// Image-only prompts keep the path as text, like other unattachable pastes.
				sink.pasteText(path);
				this.ctx.showStatus("Video paste is not supported in this prompt");
				return;
			}
			const image = await loadImageInput({
				path,
				cwd: this.ctx.sessionManager.getCwd(),
				autoResize: false,
			});
			if (!image) {
				// Path resolved but is not a readable image (e.g. a zero-byte or
				// locked transient screenshot file). Prefer the clipboard bytes.
				if (await this.#tryPasteClipboardImage(sink)) return;
				sink.pasteText(path);
				this.ctx.showStatus("Pasted path is not a supported image");
				return;
			}
			await sink.attach(
				{ type: "image", data: image.data, mimeType: image.mimeType },
				`Unsupported pasted image format: ${image.mimeType}`,
				image.resolvedPath,
			);
		} catch (error) {
			if (error instanceof ImageInputTooLargeError) {
				sink.pasteText(path);
				this.ctx.showStatus(error.message);
				return;
			}
			if (isEnoent(error)) {
				// #2375: the bracketed paste forwarded by a local terminal carries a
				// path on the *local* filesystem. The bytes may still be on the
				// clipboard (Win+Shift+S), so try those before giving up.
				if (await this.#tryPasteClipboardImage(sink)) return;
				// Over SSH the clipboard lives on the remote host, so the path is
				// genuinely unreachable; pasting it as text would look like the
				// image was attached when nothing was sent. Surface an SSH-aware
				// diagnostic instead. The pasted path is untrusted terminal input —
				// strip control/ANSI/newlines, collapse home to `~`, and bound the
				// displayed length before splicing it into the status string.
				const env = process.env;
				const overSsh = Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
				const displayPath = truncateToWidth(
					shortenPath(
						sanitizeText(path)
							.replace(/[\r\n\t]+/g, " ")
							.trim(),
					),
					TRUNCATE_LENGTHS.CONTENT,
				);
				this.ctx.showStatus(
					overSsh
						? `Image not found at ${displayPath}. Over SSH this path is local to your terminal — paste the image directly (clipboard image-paste shortcut) to send its bytes.`
						: `Image not found at ${displayPath}`,
				);
				return;
			}
			if (await this.#tryPasteClipboardImage(sink)) return;
			sink.pasteText(path);
			this.ctx.showStatus("Failed to read pasted image path");
		}
	}

	async handleImagePaste(): Promise<boolean> {
		if (!this.#clipboardIsTerminalLocal()) {
			this.ctx.showStatus(REMOTE_CLIPBOARD_STATUS);
			return false;
		}
		let finishPaste: ((text: string | undefined) => boolean) | undefined;
		let promptPaste: PromptImagePaste | undefined;
		try {
			// When a modal paste-capable prompt (login/API-key Input) owns focus,
			// only clipboard text may land there. Image payloads must not mutate
			// the hidden main editor — mirror the enhanced-paste `pasteImage`
			// behavior and surface the unsupported-status instead (#6057).
			// A prompt that opted into images gets the main editor's full image flow
			// instead, delivered through one reservation.
			const focusedNow = this.ctx.ui.getFocused();
			const promptTarget =
				focusedNow && focusedNow !== this.ctx.editor && hasPasteText(focusedNow) ? focusedNow : null;
			if (promptTarget?.acceptsImages) promptPaste = this.#beginPromptImagePaste(promptTarget);
			else finishPaste = promptTarget?.beginPaste?.();
			const textOnlyPrompt = promptTarget !== null && promptPaste === undefined;
			const sink = promptPaste?.sink ?? this.#editorImageSink;
			// #8769: On macOS, Finder `Cmd+C` on an image file puts BOTH a
			// `public.file-url` representation and a generated 1024x1024
			// file-icon bitmap on the pasteboard. `arboard::get_image()`
			// succeeds with the icon, so probing the image representation first
			// would attach the generic Finder icon instead of the copied
			// screenshot — a vision model then sees a white `PNG` document
			// icon. Probe the file URLs before the bitmap and let any that
			// resolve to a supported image file win over the icon: the
			// authoritative file bytes are what the user copied.
			//
			// #3506: this branch also recovers file-url-only pasteboards
			// (Finder selections, certain screenshot tools) where
			// `arboard::get_image()` returns `ContentNotAvailable` and
			// `pbpaste` is empty. Every image-shaped path routes through
			// {@link #pasteImagePath}, matching the bracketed-paste
			// handler in `CustomEditor.handleInput`; multi-image Finder
			// selections must not silently drop after the first attach.
			// `readMacFileUrls` returns an empty list off Darwin, so on every
			// other platform this is a no-op and the bitmap read below still
			// runs first.
			const fileUrls = textOnlyPrompt ? [] : ((await this.clipboard.readMacFileUrls?.()) ?? []);
			let attachedFromFileUrls = false;
			for (const url of fileUrls) {
				const candidate = extractImagePathFromText(url);
				if (!candidate) continue;
				await this.#pasteImagePath(candidate, sink);
				attachedFromFileUrls = true;
			}
			if (attachedFromFileUrls) return true;
			// No usable image-file URL (pure bitmap pasteboard: screenshots,
			// browser copies, or a non-image Finder selection). Fall to the
			// image representation. The text bridge starts alongside the image
			// bridge: either can shell out (WSL's powershell.exe, wl-paste, xclip),
			// so serial awaits stall an empty clipboard by their sum before
			// "Clipboard is empty" can surface. Image precedence is preserved —
			// a resolved text payload is discarded unused when an image is present.
			const textPromise = this.clipboard.readText();
			// Settle-mark the shared promise so a later image throw (which skips
			// the text await below) can never surface as an unhandled rejection.
			textPromise.then(
				() => {},
				() => {},
			);
			const image = await this.clipboard.readImage();
			if (image) {
				if (textOnlyPrompt) {
					this.ctx.showStatus("Image paste is not supported in this prompt");
					return false;
				}
				return await sink.attach(
					{
						type: "image",
						data: image.data.toBase64(),
						mimeType: image.mimeType,
					},
					`Unsupported clipboard image format: ${image.mimeType}`,
				);
			}
			// Smart paste (#1628): no image on the clipboard — fall back to
			// pasting its text so the same chord covers both payload kinds.
			// Hosts that pre-empt the terminal's own paste (VS Code's
			// integrated terminal, Win+V clipboard history) deliver only
			// this keypress, so a miss here must not dead-end.
			const text = await textPromise;
			if (!text) {
				this.ctx.showStatus("Clipboard is empty");
				return false;
			}
			// #3506: when the clipboard text is an explicit image file path,
			// route through {@link #pasteImagePath} so the image is
			// loaded and attached instead of pasting the path as literal
			// text. Covers terminals that paste the Finder file path as
			// plain text rather than as a `public.file-url` (most macOS
			// terminals do this for image clipboards).
			const imagePath = textOnlyPrompt ? null : extractImagePathFromText(text);
			if (imagePath) {
				await this.#pasteImagePath(imagePath, sink);
				return true;
			}
			// Keep the initiating prompt as the only possible modal destination.
			if (promptTarget && this.ctx.ui.getFocused() !== promptTarget) return false;
			if (finishPaste) {
				const accepted = finishPaste(text);
				finishPaste = undefined;
				if (!accepted) return false;
			} else if (promptTarget && !promptPaste) {
				promptTarget.pasteText(text);
			} else {
				sink.pasteText(text);
			}
			this.ctx.ui.requestRender();
			return true;
		} catch {
			this.ctx.showStatus("Failed to read clipboard");
			return false;
		} finally {
			promptPaste?.finish();
			finishPaste?.(undefined);
		}
	}

	async handleClipboardTextRawPaste(): Promise<void> {
		if (!this.#clipboardIsTerminalLocal()) {
			this.ctx.showStatus(REMOTE_CLIPBOARD_STATUS);
			return;
		}
		try {
			const text = await this.clipboard.readText();
			if (text) {
				this.ctx.editor.insertText(text);
				this.ctx.ui.requestRender();
			} else {
				this.ctx.showStatus("No text in clipboard to paste raw");
			}
		} catch {
			this.ctx.showStatus("Failed to paste raw text from clipboard");
		}
	}

	/**
	 * Editor `onLargePaste` hook: gate a marker-sized paste behind the large-paste menu. Returns
	 * `true` to intercept (the editor skips its default `[Paste]` marker) once the paste reaches the
	 * configured `paste.largeMenuThreshold` line count; otherwise `false` for default collapse-to-marker
	 * behavior. The async menu is fired and forgotten — the editor only needs the synchronous verdict.
	 * A paste whose input burst already carries the submit key skips the menu: nobody can answer it
	 * before the submit lands, so the paste is staged the way cancelling the menu would.
	 */
	handleLargePaste(text: string, lineCount: number, options: PasteOptions = {}): boolean {
		const threshold = cfgPasteLargeMenuThreshold.get(this.ctx.settings);
		if (!(threshold > 0) || lineCount < threshold || options.submitAfterPaste) {
			// Below the menu threshold: stage the paste as a text-attachment chip
			// (compact token in the buffer, band card above the editor).
			this.ctx.editor.insertTextAttachment(text);
			return true;
		}
		void this.presentLargePasteMenu(text, lineCount);
		return true;
	}

	/**
	 * Present the large-paste menu and apply the chosen action: wrap in `<attachment>` tags (collapsed
	 * to a `[Paste]` marker that expands on submit), save the text to a file and reference its path so
	 * the agent can `read` it on demand, or paste inline. Cancelling (Esc) falls back to the default
	 * inline paste marker, so the pasted content is never lost.
	 */
	async presentLargePasteMenu(text: string, lineCount: number): Promise<void> {
		const WRAPPED_BLOCK = "Attach as a wrapped block";
		const LOCAL_FILE = "Attach as local file";
		const INLINE = "Paste inline";

		let choice: string | undefined;
		try {
			choice = await this.ctx.showHookSelector(
				`Pasted ${lineCount} lines`,
				[
					{ label: WRAPPED_BLOCK, description: "Wrap the text in <attachment> tags, collapsed to a marker" },
					{ label: LOCAL_FILE, description: "Save the text to a local://paste file" },
					{ label: INLINE, description: "Collapse the text to an inline paste marker" },
				],
				{ helpText: `${editorKey("tui.select.cancel")} to paste inline` },
			);
		} catch (error) {
			logger.warn("large-paste menu failed", { error: error instanceof Error ? error.message : String(error) });
			choice = undefined;
		}

		switch (choice) {
			case WRAPPED_BLOCK:
				this.ctx.editor.insertTextAttachment(text, wrapPasteInAttachmentBlock(text));
				break;
			case LOCAL_FILE:
				await this.#attachPasteAsFile(text, lineCount);
				break;
			case INLINE:
				this.ctx.editor.insertTextAttachment(text);
				break;
			default:
				// Esc / cancel: keep the original behavior — stage as a text-attachment chip.
				this.ctx.editor.insertTextAttachment(text);
				break;
		}
		this.ctx.ui.requestRender();
	}

	/**
	 * Save a large paste to the session's `local://` store and insert a clean `local://paste-N.md`
	 * reference into the editor so the agent can `read` it on demand — instead of inlining the text or
	 * leaking a raw temp path. Falls back to an inline paste marker when the write fails, so the
	 * content is never lost.
	 */
	async #attachPasteAsFile(text: string, lineCount: number): Promise<void> {
		try {
			// Mirror the exact mapping the read tool's local:// resolver uses so a later
			// `read local://paste-N.md` lands on the file written here.
			const localRoot = resolveLocalRoot({
				getArtifactsDir: () => this.ctx.sessionManager.getArtifactsDir(),
				getSessionId: () => this.ctx.sessionManager.getSessionId(),
			});
			let name: string;
			let filePath: string;
			do {
				this.#pasteCounter++;
				name = `paste-${this.#pasteCounter}.md`;
				filePath = path.join(localRoot, name);
			} while (await Bun.file(filePath).exists());
			await Bun.write(filePath, text);
			this.ctx.editor.insertText(`local://${name} `);
			this.ctx.showStatus(`Saved ${lineCount} pasted lines to local://${name}`);
		} catch (error) {
			logger.warn("failed to save large paste to file", {
				error: error instanceof Error ? error.message : String(error),
			});
			this.ctx.editor.insertTextAttachment(text);
			this.ctx.showError("Failed to save paste to a file — attached as a text chip instead");
		}
	}

	/**
	 * Record a usage hit for a submitted known slash command so autocomplete
	 * can rank frequent commands first. Builtin aliases canonicalize to the
	 * primary name; skill/custom/file/template commands record their full
	 * first token (which may contain `:`).
	 */
	#recordSlashCommandUsage(text: string): void {
		if (!text.startsWith("/")) return;
		const token = text.slice(1).split(/\s+/, 1)[0] ?? "";
		if (!token) return;
		if (this.#isKnownNonBuiltinSlashCommandToken(token)) {
			commandUsage.record(token);
			return;
		}
		const parsedName = parseSlashCommand(text)?.name;
		const builtin = parsedName ? lookupBuiltinSlashCommand(parsedName) : undefined;
		if (builtin) commandUsage.record(builtin.name);
	}

	createAutocompleteProvider(commands: SlashCommand[], basePath: string): AutocompleteProvider {
		void commandUsage.load();
		return createPromptActionAutocompleteProvider({
			commands,
			basePath,
			commandUsage: name => commandUsage.get(name),
			modelMentions: createModelMentionSource({
				source: createModelBrowserSource(this.ctx.settings, model => this.ctx.session.effectiveServiceTier(model)),
				registry: this.ctx.session.modelRegistry,
				scopedModels: () => this.ctx.session.scopedModels.map(s => s.model),
			}),
			// This TUI host uses the default registry; the receiving session can change with focus.
			internalUrlCaller: () => {
				const manager = this.ctx.viewSession.sessionManager;
				return {
					cwd: manager.getCwd(),
					sessionId: manager.getSessionId(),
					sessionFile: manager.getSessionFile(),
					seanceSourceArtifactsDir: manager.getSeanceSourceArtifactsDir() ?? undefined,
				};
			},
			keybindings: this.ctx.keybindings,
			copyCurrentLine: () => this.handleCopyCurrentLine(),
			copyPrompt: () => this.handleCopyPrompt(),
			undo: prefix => this.ctx.editor.undoPastTransientText(prefix),
			moveCursorToMessageEnd: () => this.ctx.editor.moveToMessageEnd(),
			moveCursorToMessageStart: () => this.ctx.editor.moveToMessageStart(),
			moveCursorToLineStart: () => this.ctx.editor.moveToLineStart(),
			moveCursorToLineEnd: () => this.ctx.editor.moveToLineEnd(),
		});
	}

	/** Copy the current editor line to the system clipboard. */
	handleCopyCurrentLine(): void {
		const { line } = this.ctx.editor.getCursor();
		const text = this.ctx.editor.getLines()[line] || "";
		if (!text) {
			this.ctx.showStatus("Nothing to copy");
			return;
		}
		try {
			copyToClipboard(text);
			const sanitized = sanitizeText(text);
			const preview = sanitized.length > 30 ? `${sanitized.slice(0, 30)}...` : sanitized;
			this.ctx.showStatus(`Copied line: ${preview}`);
		} catch {
			this.ctx.showWarning("Failed to copy to clipboard");
		}
	}

	/** Copy current prompt text to system clipboard. */
	handleCopyPrompt(): void {
		const text = this.ctx.editor.getText();
		if (!text) {
			this.ctx.showStatus("Nothing to copy");
			return;
		}
		try {
			copyToClipboard(text);
			const sanitized = sanitizeText(text);
			const preview = sanitized.length > 30 ? `${sanitized.slice(0, 30)}...` : sanitized;
			this.ctx.showStatus(`Copied: ${preview}`);
		} catch {
			this.ctx.showWarning("Failed to copy to clipboard");
		}
	}

	cycleThinkingLevel(): void {
		const target = this.ctx.focusedAgentId ? this.ctx.viewSession : this.ctx.session;
		const newLevel = this.ctx.focusedAgentId ? cycleSubagentThinkingLevel(target) : target.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.ctx.showStatus("Current model does not support thinking");
		} else {
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
		}
	}

	async cycleRoleModel(direction: "forward" | "backward" = "forward"): Promise<void> {
		try {
			const cycleOrder = cfgCycleOrder.get(settings);
			const result = await this.ctx.viewSession.cycleRoleModels(cycleOrder, direction);
			if (!result) {
				this.ctx.showStatus("Only one role model available");
				return;
			}

			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			// The status line already reports the resolved model + thinking level, so
			// the cycle status is just a status-line-style chip track (active role
			// filled), matching the plan-approval model slider. It renders into its
			// own anchored container above the editor (cleared+rebuilt each cycle),
			// so it updates in place instead of stacking duplicates in the scrollback.
			this.ctx.showModelCycleTrack(
				cycleOrder.map(role => ({ label: role })),
				cycleOrder.indexOf(result.role),
			);
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	toggleToolOutputExpansion(): void {
		if (this.ctx.hideToolActivity) {
			const visibilityKey = appKey(this.ctx.keybindings, "app.tools.toggleVisibility");
			const visibilityHint = visibilityKey ? `${visibilityKey} or /settings` : "/settings";
			this.ctx.showStatus(`Tool activity is hidden — show it with ${visibilityHint} before expanding`);
			return;
		}
		this.setToolsExpanded(!this.ctx.toolOutputExpanded);
		this.ctx.showStatus(`Tool output expansion: ${this.ctx.toolOutputExpanded ? "enabled" : "disabled"}`);
	}

	toggleToolActivityVisibility(): void {
		this.ctx.hideToolActivity = !this.ctx.hideToolActivity;
		cfgDisplayHideToolActivity.set(this.ctx.settings, this.ctx.hideToolActivity);

		if (!this.ctx.hideToolActivity) {
			this.ctx.toolOutputExpanded = false;
		}

		for (const child of this.ctx.chatContainer.children) {
			if (
				!this.ctx.hideToolActivity &&
				(child instanceof ToolExecutionComponent || child instanceof ReadToolGroupComponent)
			) {
				child.setExpanded(false);
			} else if (child instanceof AssistantMessageComponent) {
				child.setToolResultImagesVisible(!this.ctx.hideToolActivity);
			}
		}
		this.ctx.chatContainer.setToolActivityVisible(!this.ctx.hideToolActivity);

		if (this.ctx.hideToolActivity) this.ctx.ui.clearInlineImages();
		// A viewport-only repaint leaves tool rows already retired to terminal history unchanged.
		this.ctx.ui.resetDisplay();
		this.ctx.showStatus(`Tool activity: ${this.ctx.hideToolActivity ? "hidden" : "visible"}`);
	}

	setToolsExpanded(expanded: boolean): void {
		this.ctx.toolOutputExpanded = expanded;
		for (const child of this.ctx.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		// Toggling expansion mutates every live block; blocks already committed to
		// terminal history stay at their committed presentation.
		this.ctx.ui.requestRender(true);
	}

	toggleThinkingBlockVisibility(): void {
		// When thinking is "off" and the session has not produced reasoning
		// content, thinking blocks stay auto-hidden; the toggle would only corrupt
		// the persisted preference. OpenAI-compatible servers can stream reasoning
		// without advertising model support, so observed thinking content unlocks
		// the display toggle.
		const thinkingOff =
			((this.ctx.viewSession ?? this.ctx.session)?.thinkingLevel ?? ThinkingLevel.Off) === ThinkingLevel.Off;
		if (thinkingOff && !this.ctx.hasDisplayableThinkingContent) {
			this.ctx.showStatus("Thinking is off — enable thinking to show blocks");
			return;
		}
		this.ctx.hideThinkingBlock = !this.ctx.hideThinkingBlock;
		cfgHideThinkingBlock.set(this.ctx.settings, this.ctx.hideThinkingBlock);

		for (const child of this.ctx.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHideThinkingBlock(this.ctx.hideThinkingBlock);
			}
		}

		if (this.ctx.streamingComponent && this.ctx.streamingMessage) {
			this.ctx.streamingComponent.setHideThinkingBlock(this.ctx.hideThinkingBlock);
			this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);
		}

		// This is an explicit user display gesture: rebuild native history so the
		// visibility change also applies to rows already retired from the viewport.
		// Append-only thinking heads emitted their stable rows to scrollback while
		// streaming (visible); forget that emission ledger so the paired scrollback
		// clear re-renders them under the new visibility instead of replaying the
		// captured reasoning (#10177).
		this.ctx.chatContainer.resetStableEmission();
		this.ctx.ui.resetDisplay();

		this.ctx.showStatus(`Thinking blocks: ${this.ctx.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	async openExternalEditor(): Promise<void> {
		const env = this.ctx.session.environment.snapshot();
		await withExternalEditor(
			this.ctx,
			async editorCmd => {
				const currentText = this.ctx.editor.getExpandedText?.() ?? this.ctx.editor.getText();
				const draft = formatExternalEditorDraft(this.ctx.ui.getVisibleScreenRows(), currentText);
				const result = await openInEditor(editorCmd, draft, { extension: ".omp.md", env });
				if (result !== null) {
					const message = extractExternalEditorMessage(result);
					if (message === null) this.ctx.showWarning("External editor context marker was removed; draft unchanged.");
					else this.ctx.editor.setText(message);
				}
			},
			env,
		);
	}

	/** Alt+G: the `/local` picker. `openLocalFileInEditor` refuses collab guests itself. */
	openLocalFilePicker(): Promise<void> {
		return openLocalFileInEditor(this.ctx);
	}

	registerExtensionShortcuts(): void {
		const runner = this.ctx.session.extensionRunner;
		if (!runner) return;

		const shortcuts = runner.getShortcuts();
		for (const [keyId, shortcut] of shortcuts) {
			if (isReservedKey(keyId)) {
				runner.emitError({
					extensionPath: shortcut.extensionPath,
					event: "shortcut",
					error: `${keyId} is reserved for xAI speech input and cannot be bound by extensions`,
				});
				continue;
			}
			this.ctx.editor.setCustomKeyHandler(keyId, () => {
				// Bound once at startup; a live `disabledExtensions` edit may have suspended the owner since.
				if (!runner.isExtensionActive(shortcut.extensionPath)) return;
				const ctx = runner.createCommandContext();
				try {
					runner.runScoped(() => shortcut.handler(ctx));
				} catch (err) {
					runner.emitError({
						extensionPath: shortcut.extensionPath,
						event: "shortcut",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			});
		}
	}
}
