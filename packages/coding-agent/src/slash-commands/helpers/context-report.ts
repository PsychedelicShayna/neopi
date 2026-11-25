import { t } from "@oh-my-pi/pi-utils/i18n";
import { computeSessionContextBreakdown } from "../../session/context-usage-runtime";
import type { SlashCommandRuntime } from "../types";
import { renderAsciiBar } from "@oh-my-pi/pi-tui/chrome/format";

/**
 * Build the `/context` ACP-mode text. Tries the rich breakdown first
 * (categories + auto-compact buffer + free slack) and falls back to the
 * minimal "window/used" lines when the breakdown helper throws.
 */
export function buildContextReportText(runtime: SlashCommandRuntime): string {
	try {
		const breakdown = computeSessionContextBreakdown(runtime.session, { snapcompactSavings: true });
		if (breakdown.contextWindow <= 0) {
			return t("commands.contextReport.noModel");
		}
		const usedPct = Math.round((breakdown.usedTokens / breakdown.contextWindow) * 100);
		const lines = [t("commands.contextReport.windowUsage", { tokens: breakdown.contextWindow, percent: usedPct })];
		for (const category of breakdown.categories) {
			if (category.tokens === 0) continue;
			const fraction = category.tokens / breakdown.contextWindow;
			lines.push(
				t("commands.contextReport.tokenRow", {
					label: category.label.padEnd(16),
					bar: renderAsciiBar(fraction),
					tokens: category.tokens,
				}),
			);
		}
		if (breakdown.autoCompactBufferTokens > 0) {
			const fraction = breakdown.autoCompactBufferTokens / breakdown.contextWindow;
			lines.push(
				t("commands.contextReport.tokenRow", {
					label: t("commands.contextReport.autoCompactBuffer").padEnd(16),
					bar: renderAsciiBar(fraction),
					tokens: breakdown.autoCompactBufferTokens,
				}),
			);
		}
		if (breakdown.freeTokens > 0) {
			const fraction = breakdown.freeTokens / breakdown.contextWindow;
			lines.push(
				t("commands.contextReport.tokenRow", {
					label: t("commands.contextReport.free").padEnd(16),
					bar: renderAsciiBar(fraction),
					tokens: breakdown.freeTokens,
				}),
			);
		}
		const snap = breakdown.snapcompact;
		if (snap) {
			if (!snap.visionCapable) {
				lines.push(t("commands.contextReport.snapInactive"));
			} else {
				lines.push(t("commands.contextReport.snapSavings"));
				if (snap.systemPrompt) {
					const sp = snap.systemPrompt;
					lines.push(
						sp.applied
							? t("commands.contextReport.snapPrompt", {
									textTokens: sp.textTokens,
									frames: sp.frames,
									plural: sp.frames === 1 ? "" : "s",
									imageTokens: sp.imageTokens,
									savedTokens: sp.savedTokens,
								})
							: t("commands.contextReport.snapPromptNoSavings"),
					);
				}
				if (snap.toolResults) {
					const tr = snap.toolResults;
					lines.push(
						tr.swapped > 0
							? t("commands.contextReport.snapResult", {
									swapped: tr.swapped,
									total: tr.total,
									textTokens: tr.textTokens,
									frames: tr.frames,
									imageTokens: tr.imageTokens,
									savedTokens: tr.savedTokens,
								})
							: t("commands.contextReport.snapNoResult", { total: tr.total }),
					);
				}
				if (snap.savedTokens > 0) {
					lines.push(t("commands.contextReport.nextRequest", { tokens: breakdown.usedTokens - snap.savedTokens }));
				}
			}
		}
		return lines.join("\n");
	} catch {
		const fallback = runtime.session.getContextUsage();
		if (!fallback) return t("commands.contextReport.unavailable");
		return [
			t("commands.contextReport.heading"),
			t("commands.contextReport.window", { tokens: fallback.contextWindow }),
			t("commands.contextReport.used", { tokens: fallback.tokens ?? 0 }),
		].join("\n");
	}
}
