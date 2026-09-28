/**
 * Binds a control host to the live TUI (#171). Submissions run through the
 * editor's own onSubmit inside a detached draft, so the human's composer is
 * never touched. Actions go through InputController's by-id dispatch.
 */
import { runWithDetachedDraft } from "@oh-my-pi/pi-tui/draft-scope";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { ControlHost } from "./host";
import type { ControlPresenter } from "./presenter";
import type { DialogSummary } from "./types";

export interface TuiControlSurface {
	editor: {
		getText(): string;
		setText(text: string): void;
		onSubmit?: (text: string) => void | Promise<void>;
		onEscape?: () => void;
		pendingImages: ImageContent[];
	};
	ui: {
		injectInput(data: string, origin?: "keyboard" | "control"): void;
		onHumanInput?: () => void;
		getDebugDocument(): readonly string[];
		overlayStack: readonly unknown[];
		hasOverlay(): boolean;
	};
	runAction(id: string): boolean;
	notify(text: string): void;
}

/** Attach the presenter and the human-input revision hook. */
export function attachTuiPresenter(host: ControlHost, surface: TuiControlSurface): void {
	surface.ui.onHumanInput = () => host.bumpHuman();
	const presenter: ControlPresenter = {
		async submit(text) {
			let delivery = "local";
			await runWithDetachedDraft(async () => {
				surface.editor.setText(text);
				await surface.editor.onSubmit?.(text);
				delivery = "started";
			});
			return { delivery };
		},
		async action(actionId) {
			if (actionId === "app.suspend") return { handled: false, exempt: "exempt_job_control" };
			if (actionId === "app.editor.external") return { handled: false, exempt: "exempt_external_program" };
			return { handled: surface.runAction(actionId) };
		},
		inject(bytes) {
			surface.ui.injectInput(bytes, "control");
		},
		async esc() {
			surface.editor.onEscape?.();
			return { handled: true };
		},
		screen() {
			return { lines: surface.ui.getDebugDocument(), overlays: surface.ui.overlayStack.length };
		},
		dialogs(): DialogSummary[] {
			return [];
		},
		async answerDialog() {
			return { settled: false, error: "no answerable dialog" };
		},
		draft() {
			return { text: surface.editor.getText(), images: [...surface.editor.pendingImages] };
		},
		setDraft(text) {
			surface.editor.setText(text);
		},
		draftRevision: () => host.revisions.draft,
		focusRevision: () => host.revisions.focus,
		dialogRevision: () => host.revisions.dialogs,
		notify: text => surface.notify(text),
	};
	host.presenter = presenter;
	host.markReady();
}
