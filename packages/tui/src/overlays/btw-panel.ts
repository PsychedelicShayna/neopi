import { t } from "@oh-my-pi/pi-utils/i18n";
import { type Component, Markdown, Text, type TUI } from "../index";
import { replaceTabs } from "../render/render-utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import { sanitizeErrorLine } from "../chrome/error-block";
import { OverlayPanel } from "../chrome/overlay-box";
import { StreamingPanelContent } from "../chrome/streaming-panel";
import { boundKeys, dismissKey, interruptKey } from "../chrome/keybinding-hints";
import { formatKeyHint, type KeyId } from "../app-keybindings";
import type { NativeNode } from "../native/node";
import { col, md, node, span, text } from "../native/describe";
import { hintsRow, type NativeHint, statusHintsRow } from "../native/overlay";
import { appBtwInjectKey } from "../keybinding-matchers";
import { type BtwInjectParts, splitBtwInject } from "./btw-history";
import { BtwInjectAnswer, describeBtwInjectAnswer } from "./btw-inject";

type BtwPanelState = "running" | "complete" | "branching" | "aborted" | "error";

interface BtwPanelComponentOptions {
	question: string;
	/** Heading shown instead of `/btw <question>`, e.g. `/sitrep the migration` for a side command. */
	title?: string;
	tui: TUI;
	canBranch?: () => boolean;
	canFollowUp?: () => boolean;
	/**
	 * Given only while `btw.inject` is on: the answer's `<inject>` block shows apart from its
	 * prose, and the inject key (`app.btw.inject`) is offered while this returns true.
	 */
	canInject?: () => boolean;
}

export class BtwPanelComponent extends OverlayPanel {
	#tui: TUI;
	#canBranch: (() => boolean) | undefined;
	#canFollowUp: (() => boolean) | undefined;
	#canInject: (() => boolean) | undefined;
	#state: BtwPanelState = "running";
	#answer = "";
	#errorMessage: string | undefined;
	#visibleAnswer = "";
	#closed = false;
	#copied = false;
	#injected = false;
	#baseTitle: string;
	readonly #content: StreamingPanelContent;
	#native: { node: NativeNode; canFollowUp: boolean; canBranch: boolean; injectKey: KeyId | undefined } | undefined;

	constructor(options: BtwPanelComponentOptions) {
		const baseTitle = replaceTabs(options.title ?? `/btw ${options.question}`);
		super(baseTitle, "omp.overlay.btw");
		this.#baseTitle = baseTitle;
		this.#tui = options.tui;
		this.#canBranch = options.canBranch;
		this.#canFollowUp = options.canFollowUp;
		this.#canInject = options.canInject;
		this.#content = new StreamingPanelContent(() => ({
			sections: this.#contentSections(),
			footer: () => this.#footerLine(),
		}));
		this.addChild(this.#content);
		this.#rebuild();
	}

	appendText(delta: string): void {
		if (!delta || this.#closed) return;
		this.#answer += delta;
		this.#visibleAnswer = replaceTabs(this.#answer).trim();
		this.#setCopied(false);
		this.#rebuild();
	}

	setAnswer(text: string): void {
		if (this.#closed) return;
		this.#answer = text;
		this.#visibleAnswer = replaceTabs(text).trim();
		this.#setCopied(false);
		this.#rebuild();
	}

	markComplete(): void {
		if (this.#closed) return;
		this.#state = "complete";
		this.#errorMessage = undefined;
		this.#setCopied(false);
		this.#rebuild();
	}

	/** Visual confirmation that `c` copied the answer to the clipboard. */
	markCopied(): void {
		if (this.#closed || !this.isCopyable()) return;
		this.#setCopied(true);
		this.#rebuild();
	}

	/** Shows the answer's steering prompt as sent (send arrows, green), or back to pending when a send failed. */
	setInjected(injected: boolean): void {
		if (this.#closed || this.#injected === injected) return;
		this.#injected = injected;
		this.#rebuild();
	}

	#setCopied(copied: boolean): void {
		this.#copied = copied;
		this.title = copied ? t("overlays.btw_panel.title_copied", { baseTitle: `${this.#baseTitle}` }) : this.#baseTitle;
	}

	/** Shows that the completed answer is being promoted into the chat session. */
	markBranching(): void {
		if (this.#closed) return;
		this.#state = "branching";
		this.#errorMessage = undefined;
		this.#setCopied(false);
		this.#rebuild();
	}

	markAborted(): void {
		if (this.#closed) return;
		this.#state = "aborted";
		this.#errorMessage = undefined;
		this.#setCopied(false);
		this.#rebuild();
	}

	markError(message: string): void {
		if (this.#closed) return;
		this.#state = "error";
		this.#errorMessage = message;
		this.#setCopied(false);
		this.#rebuild();
	}
	isBranchable(): boolean {
		return this.isCopyable();
	}

	isCopyable(): boolean {
		return this.#state === "complete" && this.#visibleAnswer.length > 0;
	}

	getCopyText(): string | undefined {
		if (!this.isCopyable()) return undefined;
		return this.#visibleAnswer;
	}

	/**
	 * The answer around its `<inject>` block, which displays apart from the prose only while
	 * streaming or once the tag closed: an unclosed block in a finished answer stays plain text.
	 */
	#injectParts(): BtwInjectParts | undefined {
		const parts = this.#canInject ? splitBtwInject(this.#visibleAnswer) : undefined;
		return parts && (parts.closed || this.#state === "running") ? parts : undefined;
	}

	/** The bound inject key while it can send the answer's steering prompt. */
	#injectKey(): KeyId | undefined {
		return this.#canInject?.() ? appBtwInjectKey() : undefined;
	}

	close(): void {
		this.#closed = true;
	}

	override invalidate(): void {
		this.#native = undefined;
		super.invalidate();
	}

	override describe(): NativeNode {
		const canFollowUp = this.#canFollowUp?.() ?? false;
		const canBranch = this.#canBranch?.() ?? this.isBranchable();
		const injectKey = this.#injectKey();
		const memo = this.#native;
		if (memo && memo.canFollowUp === canFollowUp && memo.canBranch === canBranch && memo.injectKey === injectKey)
			return memo.node;
		// Inline in the dock, styled as a sheet by role: a borderless column headed by the question.
		// The command word is the accent; the rest of the heading is the question or arguments.
		const space = this.#baseTitle.indexOf(" ");
		const command = space === -1 ? this.#baseTitle : this.#baseTitle.slice(0, space);
		const rest = space === -1 ? "" : this.#baseTitle.slice(space);
		const title = text([span(command, "accent"), ...(rest ? [span(rest)] : [])], { truncate: "end", lines: 1 });
		const live = this.#state === "running" || this.#state === "branching";
		const head = node("row", { role: "omp.sheet.head", gap: "sm", align: "center" }, [
			...(live ? [node("spinner", {})] : []),
			title,
		]);
		const described = col([head, this.#describeBody(), this.#describeFooter(canFollowUp, canBranch, injectKey)], {
			role: this.nativeRole,
			gap: "sm",
			tone: this.#state === "error" ? "error" : this.#state === "aborted" ? "warning" : undefined,
		});
		this.#native = { node: described, canFollowUp, canBranch, injectKey };
		return described;
	}

	#describeBody(): NativeNode {
		if (this.#state === "error") {
			return text([span(sanitizeErrorLine(this.#errorMessage ?? t("tools.common.unknown_error")), "error")], {
				wrap: "word",
			});
		}
		const answer = this.#visibleAnswer;
		const parts = this.#injectParts();
		const stream = this.#state === "running";
		if (parts) return describeBtwInjectAnswer(parts, this.#injected, stream);
		if (answer) return md(answer, { stream });
		const waiting =
			this.#state === "running"
				? t("overlays.btw_panel.waiting_response", { pending: `${theme.status.pending}` })
				: t("overlays.btw_panel.no_text_returned");
		return text([span(waiting, "dim")]);
	}

	#describeFooter(canFollowUp: boolean, canBranch: boolean, injectKey: KeyId | undefined): NativeNode {
		const esc: NativeHint = {
			keys: boundKeys("app.navigation.dismiss", ["escape"]).slice(0, 1),
			label: t("overlays.btw_panel.hint_close"),
		};
		switch (this.#state) {
			case "running":
				return hintsRow([
					{ keys: boundKeys("app.interrupt", ["ctrl+c"]).slice(0, 1), label: t("overlays.btw_panel.hint_cancel") },
					esc,
				]);
			case "complete": {
				const hints: NativeHint[] = [];
				if (injectKey) hints.push({ keys: [injectKey], label: t("overlays.btw_panel.hint_inject") });
				if (this.isCopyable())
					hints.push({
						keys: ["c"],
						label: this.#copied ? t("overlays.btw_panel.hint_copy_again") : t("overlays.btw_panel.hint_copy"),
					});
				if (canFollowUp) hints.push({ keys: ["f"], label: t("overlays.btw_panel.hint_follow_up") });
				if (canBranch) hints.push({ keys: ["b"], label: t("overlays.btw_panel.hint_branch") });
				hints.push(esc);
				if (!this.#copied) return hintsRow(hints);
				return statusHintsRow([span(t("overlays.btw_panel.copied_clipboard"), "success")], hints);
			}
			case "branching":
				return text([span(t("overlays.btw_panel.branching", { pending: `${theme.status.pending}` }), "muted")]);
			case "aborted":
				return statusHintsRow(
					[span(t("overlays.btw_panel.cancelled", { warning: `${theme.status.warning}` }), "warning")],
					[esc],
				);
			case "error":
				return statusHintsRow(
					[span(t("overlays.btw_panel.error", { error: `${theme.status.error}` }), "error")],
					[esc],
				);
		}
	}

	#rebuild(): void {
		this.#native = undefined;
		this.#content.refresh();
		// Component-scoped: a rebuild replaces only this panel's own children
		// (streaming deltas arrive per token, and a full compose would re-walk
		// the whole transcript each time). Before the panel is mounted the TUI
		// cannot resolve it and falls back to a full compose on its own.
		this.#tui.requestComponentRender(this);
	}

	#footerLine(): string {
		const esc = dismissKey();
		switch (this.#state) {
			case "running":
				return theme.fg(
					"muted",
					t("overlays.btw_panel.cancel_close", { interruptKey: `${interruptKey()}`, esc: `${esc}` }),
				);
			case "complete": {
				const actions: string[] = [];
				const copyKey = formatKeyHint("c");
				const injectKey = this.#injectKey();
				if (injectKey)
					actions.push(t("overlays.btw_panel.key_inject", { injectKey: `${formatKeyHint(injectKey)}` }));
				if (this.isCopyable())
					actions.push(
						this.#copied
							? t("overlays.btw_panel.key_copy_again", { copyKey: `${copyKey}` })
							: t("overlays.btw_panel.key_copy", { copyKey: `${copyKey}` }),
					);
				if (this.#canFollowUp?.())
					actions.push(t("overlays.btw_panel.key_follow_up", { value: `${formatKeyHint("f")}` }));
				if (this.#canBranch?.() ?? this.isBranchable())
					actions.push(t("overlays.btw_panel.key_branch", { value: `${formatKeyHint("b")}` }));
				actions.push(t("overlays.btw_panel.key_close", { esc: `${esc}` }));
				if (this.#copied) {
					return `${theme.fg("success", t("overlays.btw_panel.copied_clipboard"))}${theme.fg("muted", actions.length > 0 ? ` · ${actions.join(" · ")}` : "")}`;
				}
				return theme.fg("muted", actions.join(" · "));
			}
			case "branching":
				return theme.fg("muted", t("overlays.btw_panel.branching", { pending: `${theme.status.pending}` }));
			case "aborted":
				return theme.fg(
					"warning",
					t("overlays.btw_panel.cancelled_close", { warning: `${theme.status.warning}`, esc: `${esc}` }),
				);
			case "error":
				return theme.fg(
					"error",
					t("overlays.btw_panel.error_close", { error: `${theme.status.error}`, esc: `${esc}` }),
				);
		}
	}

	#contentSections(): Component[] {
		if (this.#state === "error") {
			return [
				new Text(theme.fg("error", sanitizeErrorLine(this.#errorMessage ?? t("tools.common.unknown_error"))), 0, 0),
			];
		}
		const text = this.#visibleAnswer;
		if (!text) {
			const waiting =
				this.#state === "running"
					? t("overlays.btw_panel.waiting_response", { pending: `${theme.status.pending}` })
					: t("overlays.btw_panel.no_text_returned");
			return [new Text(theme.fg("dim", waiting), 0, 0)];
		}
		const parts = this.#injectParts();
		return [parts ? new BtwInjectAnswer(parts, this.#injected) : new Markdown(text, 0, 0, getMarkdownTheme())];
	}
}
