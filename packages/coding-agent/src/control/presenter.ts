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
	setDraft(text: string): void;
	/** Human-editor revision, bumped on every composer change. */
	draftRevision(): number;
	/** Overlay/focus revision. */
	focusRevision(): number;
	dialogRevision(): number;
	/** Attribute a line in the pane. */
	notify(text: string): void;
	/** Whether control.approvals may settle the open approval, and settle it. */
	settleApproval?(id: string, approved: boolean, reason?: string): boolean;
}

export interface RevisionSource {
	revisions(): Revisions;
	bumpHuman(): void;
	bumpFocus(): void;
	bumpDialogs(): void;
	bumpDraft(): void;
	bumpGeneration(): void;
}
