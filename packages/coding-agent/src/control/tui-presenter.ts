/**
 * Binds a control host to the live TUI (#171). Submissions run through the
 * editor's own onSubmit inside a detached draft, so the human's composer is
 * never touched. Actions go through InputController's by-id dispatch.
 */
import { runWithDetachedDraft } from "@oh-my-pi/pi-tui/draft-scope";
import type { Component } from "@oh-my-pi/pi-tui";
import { encodeKeyId } from "./keys";
import { trackMountedDialog } from "./dialogs";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../session/agent-session";
import type { ToolApprovalVerdict } from "../extensibility/extensions/tool-approval-requester";
import { cfgControlApprovals } from "./settings";
import { currentControlActor, runAsControlActor } from "./actor";
import { DialogRegistry, setDialogRegistry } from "./dialogs";
import type { ControlHost } from "./host";
import type { ControlPresenter } from "./presenter";
import type { DialogSummary } from "./types";

export interface TuiControlSurface {
	session: AgentSession;
	editor: {
		getText(): string;
		setText(text: string): void;
		onSubmit?: (text: string) => void | Promise<void>;
		onEscape?: () => void;
		pendingImages: ImageContent[];
		onChange?: (text: string) => void;
	};
	ui: {
		injectInput(data: string, origin?: "keyboard" | "control"): void;
		onHumanInput?: () => void;
		onOverlayShown?: (component: Component, hide: () => void) => (() => void) | void;
		getDebugDocument(): readonly string[];
		overlayStack: readonly unknown[];
		hasOverlay(): boolean;
	};
	runAction(id: string): boolean;
	notify(text: string): void;
}

/** Attach the presenter, the dialog registry, and the approval arbiter. */
export function attachTuiPresenter(host: ControlHost, surface: TuiControlSurface): void {
	const registry = new DialogRegistry();
	setDialogRegistry(registry);
	registry.onChange(() => host.bumpDialogs());
	surface.ui.onHumanInput = () => host.bumpHuman();
	const previousChange = surface.editor.onChange;
	surface.editor.onChange = (text: string) => {
		previousChange?.(text);
		host.bumpDraft();
	};
	surface.ui.onOverlayShown = (component, hide) => {
		const kind = component.constructor?.name || "overlay";
		return trackMountedDialog({
			family: "app",
			kind,
			title: kind,
			answer: value => answerMountedOverlay(surface, value),
			cancel: () => hide(),
		});
	};
	installApprovalArbiter(host, surface.session, registry, surface.notify);
	const presenter: ControlPresenter = {
		async submit(text) {
			const outer = currentControlActor();
			const actor = outer ?? {
				connectionId: "control",
				label: "control",
				humanAtAdmission: host.revisions.human,
				humanNow: () => host.revisions.human,
			};
			return runAsControlActor(actor, async () => {
				await runWithDetachedDraft(async () => {
					surface.editor.setText(text);
					await surface.editor.onSubmit?.(text);
				});
				return { delivery: "started" };
			});
		},
		async action(actionId) {
			if (actionId === "app.suspend") return { handled: false, exempt: "exempt_job_control" };
			if (actionId === "app.editor.external") return { handled: false, exempt: "exempt_external_program" };
			if (surface.runAction(actionId)) return { handled: true };
			const keys = host.presenter?.keybindings?.get(actionId) ?? [];
			if (host.blocksInjectedInput()) return { handled: false };
			for (const key of keys) {
				const bytes = encodeKeyId(String(key));
				if (!bytes) continue;
				surface.ui.injectInput(bytes, "control");
				return { handled: true, text: String(key) };
			}
			return { handled: false };
		},
		inject(bytes) {
			if (host.blocksInjectedInput()) return;
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
			return registry.list();
		},
		async answerDialog(dialogId, answer) {
			return registry.answer(dialogId, answer);
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

/**
 * Every tool approval settles here. The pane dialog is the keyboard route.
 * A control answer is refused unless `control.approvals` is on, and an
 * accepted one is attributed in the pane.
 */
function installApprovalArbiter(
	host: ControlHost,
	session: AgentSession,
	registry: DialogRegistry,
	notify: (text: string) => void,
): void {
	const runner = session.extensionRunner;
	if (!runner) return;
	const ui = runner.getUIContext();
	runner.setToolApprovalRequester(async request => {
		const { promise, resolve } = Promise.withResolvers<ToolApprovalVerdict>();
		let done = false;
		const finish = (verdict: ToolApprovalVerdict): void => {
			if (done) return;
			done = true;
			registry.close(opened.dialogId);
			resolve(verdict);
		};
		const opened = registry.open({
			family: "approval",
			kind: "approval",
			title: `Approve ${request.toolName}?`,
			openedBy: "agent",
			schema: { toolName: request.toolName, details: request.details },
			answer: value => {
				if (cfgControlApprovals.get(session.settings) !== true) {
					const actor = currentControlActor();
					const who = actor ? `${actor.label}#${actor.connectionId}` : "control";
					notify(`⌁ ${who} tried to approve ${request.toolName} — approvals are yours (control.approvals is off)`);
					return false;
				}
				const actor = currentControlActor();
				const record = typeof value === "object" && value !== null ? (value as { approved?: boolean }) : undefined;
				const approved = value === "Approve" || value === true || record?.approved === true;
				if (approved && actor) notify(`⌁ ${actor.label}#${actor.connectionId} approved ${request.toolName}`);
				finish(approved ? { approved: true } : { approved: false, reason: "denied by control" });
				return true;
			},
			cancel: () => finish({ approved: false, reason: "cancelled" }),
		});
		host.setApprovalUiOpen(true);
		let choice: string | undefined;
		try {
			choice = await ui.select(`Approve ${request.toolName}?`, ["Approve", "Deny"]);
		} finally {
			host.setApprovalUiOpen(false);
		}
		finish(choice === "Approve" ? { approved: true } : { approved: false, reason: "denied" });
		return promise;
	});
}

/** Drive a mounted overlay from a dialog answer: an index confirms that row, a string is typed. */
function answerMountedOverlay(surface: TuiControlSurface, value: unknown): boolean {
	if (value === "cancel") {
		surface.ui.injectInput("\x1b", "control");
		return true;
	}
	const index =
		typeof value === "number"
			? value
			: typeof value === "object" && value !== null && "index" in value
				? Number((value as { index: unknown }).index)
				: undefined;
	if (index !== undefined && Number.isFinite(index) && index >= 0) {
		for (let i = 0; i < index; i++) surface.ui.injectInput("\x1b[B", "control");
		surface.ui.injectInput("\r", "control");
		return true;
	}
	if (typeof value === "string") {
		surface.ui.injectInput(value.endsWith("\r") ? value : `${value}\r`, "control");
		return true;
	}
	return false;
}
