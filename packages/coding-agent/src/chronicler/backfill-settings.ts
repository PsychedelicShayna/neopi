import { register } from "../config/registry";

export const cfgChroniclerBackfillConcurrency = register({
	id: "chronicler.backfill.concurrency",
	type: "number",
	default: 4,
	validate: value => {
		if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 1))
			throw new Error("chronicler.backfill.concurrency must be a positive integer");
	},
	ui: {
		tab: "chronicler",
		group: "Chronicler",
		label: "Backfill parallel sessions",
		description:
			"Stored sessions captured at once by npi chronicle backfill. Only runs on demand; --concurrency overrides this value.",
		options: [{ value: "4", label: "4 sessions" }],
		customInput: true,
	},
});

export const cfgChroniclerBackfillScanConcurrency = register({
	id: "chronicler.backfill.scanConcurrency",
	type: "number",
	default: 8,
	validate: value => {
		if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 1))
			throw new Error("chronicler.backfill.scanConcurrency must be a positive integer");
	},
	ui: {
		tab: "chronicler",
		group: "Chronicler",
		label: "Backfill parallel coverage scans",
		description:
			"Stored transcript coverage reads performed at once when selecting sessions for an on-demand backfill.",
		options: [{ value: "8", label: "8 scans" }],
		customInput: true,
	},
});

export const cfgChroniclerBackfillTimeoutMs = register({
	id: "chronicler.backfill.timeoutMs",
	type: "number",
	default: 7_200_000,
	validate: value => {
		if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
			throw new Error("chronicler.backfill.timeoutMs must be a nonnegative number");
	},
	ui: {
		tab: "chronicler",
		group: "Chronicler",
		label: "Backfill capture deadline (ms)",
		description:
			"Per-session capture budget before final drain during on-demand backfill, in milliseconds. --timeout overrides this value.",
		options: [{ value: "7200000", label: "2 hours" }],
		customInput: true,
	},
});

export const cfgChroniclerBackfillDrainMs = register({
	id: "chronicler.backfill.drainMs",
	type: "number",
	default: 600_000,
	validate: value => {
		if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
			throw new Error("chronicler.backfill.drainMs must be a nonnegative number");
	},
	ui: {
		tab: "chronicler",
		group: "Chronicler",
		label: "Backfill final drain (ms)",
		description:
			"Time allowed for a stored session's final capture pass before aborting it, in milliseconds. --drain overrides this value.",
		options: [{ value: "600000", label: "10 minutes" }],
		customInput: true,
	},
});

export const cfgChroniclerBackfillPollMs = register({
	id: "chronicler.backfill.pollMs",
	type: "number",
	default: 5_000,
	validate: value => {
		if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 1))
			throw new Error("chronicler.backfill.pollMs must be at least 1 millisecond");
	},
	ui: {
		tab: "chronicler",
		group: "Chronicler",
		label: "Backfill coverage poll (ms)",
		description:
			"Interval between committed coverage reads while an on-demand stored-session capture runs, in milliseconds. This does not schedule backfill or indexing.",
		options: [{ value: "5000", label: "5 seconds" }],
		customInput: true,
	},
});
