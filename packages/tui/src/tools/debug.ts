import { getLocale, type Locale, t } from "@oh-my-pi/pi-utils/i18n";
import type { Component } from "../tui";
import { Text } from "../components/text";
import type { Theme } from "../theme/theme";
import { renderStatusLine } from "../render/status-line";
import { framedToolCard } from "../render/tool-card";
import {
	formatExpandHint,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	TRUNCATE_LENGTHS,
	truncateToWidth,
	clipCollapsed,
} from "../render/render-utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { singleLine } from "../utils";
import type { NativeToolView, RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";
import { ansi, kv } from "../native/describe";
import type { NativeChild } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { errorView, noteText, resultText, toolHead } from "./native-view";

/** Display fields captured from a debugger session. */
export interface DebugSessionSnapshot {
	id: string;
	adapter: string;
	status: string;
	cwd: string;
	program?: string;
	stopReason?: string;
	frameName?: string;
	instructionPointerReference?: string;
	source?: { path?: string };
	line?: number;
	column?: number;
	needsConfigurationDone: boolean;
	exitCode?: number;
}

/** Debug execution metadata consumed by the transcript. */
export interface DebugToolDetails {
	action: string;
	success: boolean;
	snapshot?: DebugSessionSnapshot;
}

/** Debug arguments used to describe a pending request. */
export interface DebugRenderArgs {
	action?: string;
	program?: string;
	file?: string;
	line?: number;
	function?: string;
	expression?: string;
	command?: string;
	memory_reference?: string;
	instruction_reference?: string;
	data_id?: string;
	name?: string;
}

/** Formats a debugger stop location as a source path and coordinates. */
export function formatLocation(snapshot: DebugSessionSnapshot | undefined): string | null {
	if (!snapshot?.source?.path || snapshot.line === undefined) {
		return null;
	}
	return `${snapshot.source.path}:${snapshot.line}${snapshot.column !== undefined ? `:${snapshot.column}` : ""}`;
}

/** Formats the debugger session snapshot in its model-facing English form. */
export function formatSessionSnapshot(snapshot: DebugSessionSnapshot): string[] {
	return formatSnapshot(snapshot, "en");
}

function formatSnapshot(snapshot: DebugSessionSnapshot, locale: Locale): string[] {
	const lines = [
		t(locale, "tools.debug.session_line", { value: snapshot.id }),
		t(locale, "tools.debug.adapter_line", { value: snapshot.adapter }),
		t(locale, "tools.debug.status_line", { value: snapshot.status }),
		`CWD: ${snapshot.cwd}`,
	];
	if (snapshot.program) lines.push(t(locale, "tools.debug.program_line", { value: snapshot.program }));
	if (snapshot.stopReason) lines.push(t(locale, "tools.debug.stop_line", { value: snapshot.stopReason }));
	if (snapshot.frameName) lines.push(t(locale, "tools.debug.frame_line", { value: snapshot.frameName }));
	if (snapshot.instructionPointerReference) {
		lines.push(t(locale, "tools.debug.pointer_line", { value: snapshot.instructionPointerReference }));
	}
	const location = formatLocation(snapshot);
	if (location) lines.push(t(locale, "tools.debug.location_line", { location }));
	if (snapshot.needsConfigurationDone) {
		lines.push(t(locale, "tools.debug.pending_line"));
	}
	if (snapshot.exitCode !== undefined) lines.push(t(locale, "tools.debug.exit_line", { value: snapshot.exitCode }));
	return lines;
}

/**
 * Model-authored arg text is untrusted: strip ANSI escapes and control
 * characters, then hand the value to the shared single-line projection
 * (`singleLine`: tab expansion + line-break collapse) before it lands in a
 * card row or native head (same treatment as every sibling renderer, e.g.
 * `replaceTabs` in bash.ts).
 */
function sanitizeDebugArg(value: string): string {
	return singleLine(sanitizeText(value));
}

/** Highest-precedence identifying arg for a debug call head; mirrors the summary field order. */
function debugCallTarget(args: DebugRenderArgs): string | undefined {
	return (
		args.program ||
		(args.file && args.line !== undefined ? `${args.file}:${args.line}` : undefined) ||
		args.function ||
		args.expression ||
		args.command ||
		args.memory_reference ||
		args.instruction_reference ||
		args.data_id ||
		args.name ||
		undefined
	);
}

function summarizeDebugCall(args: DebugRenderArgs): string {
	const action = args.action ? sanitizeDebugArg(args.action.replaceAll("_", " ")) : "request";
	const target = debugCallTarget(args);
	return target ? `${action} ${truncateToWidth(sanitizeDebugArg(target), TRUNCATE_LENGTHS.TITLE)}` : action;
}

/** Untruncated `[action, target]` for native heads; mirrors {@link summarizeDebugCall}'s field precedence. */
function debugCallParts(args: DebugRenderArgs | undefined, fallbackAction: string): [string, string | undefined] {
	const action = sanitizeDebugArg((args?.action ?? fallbackAction).replaceAll("_", " "));
	if (!args) return [action, undefined];
	const target = debugCallTarget(args);
	return [action, target === undefined ? undefined : sanitizeDebugArg(target)];
}

function describeDebugResult(
	result: ToolRenderResult<DebugToolDetails>,
	args: DebugRenderArgs | undefined,
): NativeToolView {
	const [action, target] = debugCallParts(args, result.details?.action ?? "debug");
	const output = resultText(result);
	if (result.isError) return errorView("Debug", output || t("tools.debug.failed"), action, target);
	const snapshot = result.details?.snapshot;
	const body: NativeChild[] = [];
	let sessionRows = 0;
	if (snapshot) {
		const location = formatLocation(snapshot);
		const rows: [string, string | undefined][] = [
			[t("tools.debug.session"), snapshot.id],
			[t("tools.debug.adapter"), snapshot.adapter],
			[t("tools.common.status"), snapshot.status],
			["CWD", snapshot.cwd],
			[t("tools.debug.program"), snapshot.program],
			[t("tools.debug.stop_reason"), snapshot.stopReason],
			[t("tools.debug.frame"), snapshot.frameName],
			[t("tools.debug.instruction_pointer"), snapshot.instructionPointerReference],
			[t("tools.debug.location"), location ?? undefined],
			[t("tools.debug.configuration"), snapshot.needsConfigurationDone ? t("tools.debug.pending") : undefined],
			[t("tools.debug.exit_code"), snapshot.exitCode !== undefined ? String(snapshot.exitCode) : undefined],
		];
		const grid = kv(rows);
		if (grid) {
			body.push(grid);
			sessionRows = rows.filter(([, value]) => value).length;
		}
	}
	body.push(output ? ansi(output) : noteText(t("tools.common.no_output_plain")));
	return {
		head: toolHead("Debug", action, target),
		body,
		preview: { lines: sessionRows + PREVIEW_LIMITS.COLLAPSED_LINES },
	};
}

const debugResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** Renders debugger calls and captured execution snapshots. */
export const debugToolRenderer = {
	animatedPartialResult: true,
	renderCall(args: DebugRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		const text = renderStatusLine({ icon: "pending", title: "Debug", description: summarizeDebugCall(args) }, theme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: DebugToolDetails; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: DebugRenderArgs,
	): Component {
		return framedToolCard(theme, () => {
			const action = sanitizeDebugArg((args?.action ?? result.details?.action ?? "debug").replaceAll("_", " "));
			const success = !options.isPartial && !result.isError;
			const statusIcon = success
				? theme.styledSymbol("tool.debug", "accent")
				: formatStatusIcon(options.isPartial ? "running" : "error", theme, options.spinnerFrame);
			const header = `${statusIcon} Debug ${action}`;
			const summaryLines = result.details?.snapshot
				? formatSnapshot(result.details.snapshot, getLocale()).map(line => replaceTabs(line))
				: [];
			const text = result.content.find(block => block.type === "text")?.text ?? t("tools.common.no_output_plain");
			const rawLines = replaceTabs(text).split("\n");
			const previewLimit = options.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
			const displayedLines = rawLines
				.slice(0, previewLimit)
				.map(line => clipCollapsed(line, TRUNCATE_LENGTHS.LINE, options.expanded));
			const remaining = rawLines.length - displayedLines.length;
			if (remaining > 0) {
				displayedLines.push(
					theme.fg(
						"muted",
						t("tools.debug.more_lines", { remaining, hint: formatExpandHint(theme, options.expanded, true) }),
					),
				);
			}
			return {
				header,
				phase: options.isPartial ? "partial" : result.isError ? "error" : "success",
				sections: [
					...(summaryLines.length > 0
						? [{ label: theme.fg("toolTitle", t("tools.debug.session")), content: summaryLines }]
						: []),
					{ label: theme.fg("toolTitle", t("tools.common.output")), content: displayedLines },
				],
				applyBg: false,
			};
		});
	},
	describeCall(args: DebugRenderArgs): NativeToolView {
		const [action, target] = debugCallParts(args, "request");
		return { head: toolHead("Debug", action, target) };
	},
	describeResult(
		result: ToolRenderResult<DebugToolDetails>,
		_options: RenderResultOptions,
		args?: DebugRenderArgs,
	): NativeToolView | undefined {
		return debugResultMemo.get(result, [getLocale()], () => describeDebugResult(result, args));
	},
	mergeCallAndResult: true,
	inline: true,
} satisfies ToolRenderer<DebugRenderArgs, DebugToolDetails>;
