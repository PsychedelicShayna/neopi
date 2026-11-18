/** Status line segment identifiers accepted by custom status-line settings. */
export const STATUS_LINE_SEGMENT_IDS = [
	"pi",
	"status",
	"model",
	"live",
	"mode",
	"path",
	"git",
	"pr",
	"subagents",
	"token_in",
	"token_out",
	"token_total",
	"token_rate",
	"cost",
	"context_pct",
	"context_total",
	"context_bar",
	"time_spent",
	"time",
	"session",
	"hostname",
	"cache_read",
	"cache_write",
	"cache_hit",
	"cache",
	"session_name",
	"usage",
	"collab",
	"stream",
	"vim",
] as const;

/** One identifier from the supported status-line segment catalog. */
export type BuiltinStatusLineSegmentId = (typeof STATUS_LINE_SEGMENT_IDS)[number];
export type UsageBarSegmentId = `usage:${string}`;
export type StatusLineSegmentId = BuiltinStatusLineSegmentId | UsageBarSegmentId;

export interface UsageBarSelector {
	provider: string;
	windowId: string;
	tier?: string;
}

export function parseUsageBarSegmentId(id: string): UsageBarSelector | undefined {
	const parts = id.split(":");
	if (parts[0] !== "usage" || (parts.length !== 3 && parts.length !== 4)) return undefined;
	if (parts.some(part => part.trim().length === 0)) return undefined;
	const provider = parts[1]!;
	const windowId = parts[2]!;
	return parts.length === 4 ? { provider, windowId, tier: parts[3]! } : { provider, windowId };
}

export function isStatusLineSegmentId(value: string): value is StatusLineSegmentId {
	return STATUS_LINE_SEGMENT_IDS.some(id => id === value) || parseUsageBarSegmentId(value) !== undefined;
}

/** Baseline segments used when Custom is selected without segment overrides. */
export const CUSTOM_STATUS_LINE_DEFAULTS: {
	readonly left: BuiltinStatusLineSegmentId[];
	readonly right: BuiltinStatusLineSegmentId[];
} = {
	left: ["vim", "model", "live", "mode", "path", "git", "pr"],
	right: ["session_name", "token_total", "cost", "context_pct"],
};

export const CONTEXT_LINE_MODE_VALUES = ["off", "percentage", "annotated", "embedded"] as const;
export type ContextLineMode = (typeof CONTEXT_LINE_MODE_VALUES)[number];
export const STATUS_LINE_PRESET_VALUES = ["default", "minimal", "compact", "full", "nerd", "ascii", "custom"] as const;
export type StatusLinePreset = (typeof STATUS_LINE_PRESET_VALUES)[number];
export const STATUS_LINE_SEPARATOR_VALUES = [
	"powerline",
	"powerline-thin",
	"slash",
	"pipe",
	"block",
	"none",
	"ascii",
] as const;
export type StatusLineSeparatorStyle = (typeof STATUS_LINE_SEPARATOR_VALUES)[number];
