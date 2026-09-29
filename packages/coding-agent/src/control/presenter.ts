/**
 * What a TUI process adds on top of the session (#171). Headless roles leave
 * this unset and screen/editor commands answer `no_tui`.
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { DialogSummary, Revisions } from "./types";

export interface ControlPresenter {
	/** Keyboard-contextual submit through the editor's own onSubmit, on a detached draft. */
	submit(text: string, images?: ImageContent[]): Promise<{ delivery: string; agentInvoked?: boolean }>;
	/** Run one app.* or tui.* action by id. `exempt` when the plan excludes it. */
	action(actionId: string): Promise<{ handled: boolean; exempt?: string; text?: string }>;
	/** Inject already-encoded terminal bytes as control input. */
	inject(bytes: string): void;
	esc(): Promise<{ handled: boolean }>;
	screen(mode?: string): unknown;
	dialogs(): DialogSummary[];
	answerDialog(dialogId: string, answer: unknown): Promise<{ settled: boolean; error?: string }>;
	draft(): { text: string; images: ImageContent[] };
	/** Replace the human draft: text and pending images together. */
	setDraft(text: string, images?: ImageContent[]): void;
	/** Insert text at the human editor's cursor. */
	insertDraft(text: string): void;
	/** Rewind the session to an entry through the pane's own rewind flow. */
	rewind(entryId: string, prefillDraft: boolean): Promise<RewindOutcome>;
	notify(text: string): void;
	keybindings?: {
		get(actionId: string): string[];
		all(): Record<string, string[]>;
		set(actionId: string, keys: string[]): boolean;
		reload(): void;
	};
	/** Human-editor revision, bumped on every composer change. */
	draftRevision(): number;
	/** Overlay/focus revision. */
	focusRevision(): number;
	dialogRevision(): number;
	/** Whether control.approvals may settle the open approval, and settle it. */
	settleApproval?(id: string, approved: boolean, reason?: string): boolean;
}

export type RewindOutcome = { status: "rewound" | "unchanged" | "cancelled" | "invalid"; error?: string };

export interface RevisionSource {
	revisions(): Revisions;
	bumpHuman(): void;
	bumpFocus(): void;
	bumpDialogs(): void;
	bumpDraft(): void;
	bumpGeneration(): void;
}
