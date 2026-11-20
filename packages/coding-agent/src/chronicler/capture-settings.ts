import { register, type UiNumber } from "../config/registry";

function numberUi(label: string, description: string, value: number): UiNumber {
	return {
		tab: "chronicler",
		group: "Chronicler",
		label,
		description,
		options: [{ value: String(value), label: `${value} (default)` }],
		customInput: true,
	};
}

function integer(minimum: number, maximum = Number.MAX_SAFE_INTEGER): (value: unknown) => void {
	return value => {
		if (value === undefined) return;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
			throw new Error(`Expected an integer from ${minimum} through ${maximum}.`);
		}
	};
}

export const cfgChroniclerCapturePrefixEntries = register({
	id: "chronicler.capture.prefixEntries",
	type: "number",
	default: 60,
	validate: integer(1),
	ui: numberUi("Capture prefix entries", "Maximum unseen transcript entries offered in one capture pass.", 60),
});
export const cfgChroniclerCaptureBeatListing = register({
	id: "chronicler.capture.beatListing",
	type: "number",
	default: 200,
	validate: integer(0),
	ui: numberUi(
		"Capture beat listing",
		"Maximum recent committed beats listed in capture context before budget trimming.",
		200,
	),
});
export const cfgChroniclerCaptureUnseenFlushChars = register({
	id: "chronicler.capture.unseenFlushChars",
	type: "number",
	default: 80_000,
	validate: integer(0),
	ui: numberUi(
		"Capture unseen character threshold",
		"Unseen serialized characters required to capture while the primary agent will continue. Turn-end flushes bypass this threshold.",
		80_000,
	),
});
export const cfgChroniclerCaptureFallbackTokens = register({
	id: "chronicler.capture.fallbackTokens",
	type: "number",
	default: 32_000,
	validate: integer(1),
	ui: numberUi(
		"Capture fallback token budget",
		"Input token budget when the selected model has no usable context-window size.",
		32_000,
	),
});
export const cfgChroniclerCaptureContextFraction = register({
	id: "chronicler.capture.contextFraction",
	type: "number",
	default: 0.7,
	validate: value => {
		if (value === undefined) return;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
			throw new Error("Capture context fraction must be greater than zero and at most one.");
		}
	},
	ui: numberUi(
		"Capture context fraction",
		"Fraction of the model context window available to capture input, including retained conversation and tools.",
		0.7,
	),
});
export const cfgChroniclerCaptureAttempts = register({
	id: "chronicler.capture.attempts",
	type: "number",
	default: 3,
	validate: integer(1),
	ui: numberUi(
		"Capture consecutive attempts",
		"Failed attempts allowed in one capture burst before autonomous recovery takes over.",
		3,
	),
});
export const cfgChroniclerCaptureRetryBackoffMs = register({
	id: "chronicler.capture.retryBackoffMs",
	type: "array",
	default: [2_000, 4_000] as readonly number[],
	validate: value => {
		if (value === undefined) return;
		if (!Array.isArray(value) || value.length === 0)
			throw new Error("Capture retry backoff requires at least one delay.");
		for (const delay of value) integer(1, 2_147_483_647)(delay);
	},
	ui: {
		tab: "chronicler",
		group: "Chronicler",
		label: "Capture retry backoff (ms)",
		description:
			"Delays between retries of the same unseen prefix. Later retries reuse the last delay; autonomous recovery starts with the first.",
		editor: "json",
		ordered: true,
	},
});
export const cfgChroniclerCaptureRecoveryMaxMs = register({
	id: "chronicler.capture.recoveryMaxMs",
	type: "number",
	default: 60_000,
	validate: integer(1, 2_147_483_647),
	ui: numberUi(
		"Capture recovery maximum (ms)",
		"Upper bound on the delay before autonomous recovery retries.",
		60_000,
	),
});
export const cfgChroniclerCaptureRecoveryMultiplier = register({
	id: "chronicler.capture.recoveryMultiplier",
	type: "number",
	default: 2,
	validate: integer(1),
	ui: numberUi("Capture recovery multiplier", "Multiplier applied to each successive autonomous recovery delay.", 2),
});
export const cfgChroniclerCaptureRecoveryExponent = register({
	id: "chronicler.capture.recoveryExponent",
	type: "number",
	default: 5,
	validate: integer(0),
	ui: numberUi(
		"Capture recovery exponent cap",
		"Maximum number of exponential backoff steps before the delay stops growing.",
		5,
	),
});
export const cfgChroniclerCaptureOwnershipCheckMs = register({
	id: "chronicler.capture.ownershipCheckMs",
	type: "number",
	default: 60_000,
	validate: integer(1, 2_147_483_647),
	ui: numberUi(
		"Capture ownership check (ms)",
		"Interval between checks that the capture writer still owns its session lease.",
		60_000,
	),
});
export const cfgChroniclerCaptureStreamStallMs = register({
	id: "chronicler.capture.streamStallMs",
	type: "number",
	default: 3_600_000,
	validate: integer(1, 2_147_483_647),
	ui: numberUi(
		"Capture stream stall timeout (ms)",
		"Abort an attempt after this long without a streamed assistant event.",
		3_600_000,
	),
});
export const cfgChroniclerCaptureDeadlineMs = register({
	id: "chronicler.capture.deadlineMs",
	type: "number",
	default: 3_900_000,
	validate: integer(1, 2_147_483_647),
	ui: numberUi(
		"Capture attempt deadline (ms)",
		"Hard deadline for one model attempt, independent of stream activity.",
		3_900_000,
	),
});
export const cfgChroniclerCaptureDrainMs = register({
	id: "chronicler.capture.drainMs",
	type: "number",
	default: 20_000,
	validate: integer(0, 2_147_483_647),
	ui: numberUi(
		"Capture shutdown drain (ms)",
		"Default time allowed for model work to finish during shutdown.",
		20_000,
	),
});
export const cfgChroniclerCaptureSettledKeys = register({
	id: "chronicler.capture.settledKeys",
	type: "number",
	default: 32,
	validate: integer(1),
	ui: numberUi(
		"Capture settled-message history",
		"Recent persisted-message identities retained to match turn-end persistence rendezvous.",
		32,
	),
});
export const cfgChroniclerCaptureSleepPollMs = register({
	id: "chronicler.capture.sleepPollMs",
	type: "number",
	default: 50,
	validate: integer(1, 2_147_483_647),
	ui: numberUi(
		"Capture retry cancellation poll (ms)",
		"Interval for checking whether a settings or session change revoked a retry wait.",
		50,
	),
});
export const cfgChroniclerCaptureMaterialCriteria = register({
	id: "chronicler.capture.materialCriteria",
	type: "number",
	default: 2,
	validate: integer(1, 3),
	ui: numberUi(
		"Capture material criteria",
		"How many of the three material-worth-preserving criteria a beat should satisfy.",
		2,
	),
});
export const cfgChroniclerCaptureMinWords = register({
	id: "chronicler.capture.minWords",
	type: "number",
	default: 150,
	validate: integer(0),
	ui: numberUi(
		"Capture target minimum words",
		"Suggested lower beat word target. Meaningful shorter material is still preserved.",
		150,
	),
});
export const cfgChroniclerCaptureMaxWords = register({
	id: "chronicler.capture.maxWords",
	type: "number",
	default: 1_200,
	validate: integer(1),
	ui: numberUi("Capture target maximum words", "Suggested upper beat word target, not a truncation limit.", 1_200),
});
export const cfgChroniclerCaptureIncludeThinking = register({
	id: "chronicler.capture.includeThinking",
	type: "boolean",
	default: true,
	ui: {
		tab: "chronicler",
		group: "Chronicler",
		label: "Capture thinking blocks",
		description: "Include available assistant thinking blocks in the transcript evidence sent to the Chronicler.",
	},
});
export const cfgChroniclerCaptureCarryChars = register({
	id: "chronicler.capture.carryChars",
	type: "number",
	default: 8_000,
	validate: integer(0),
	ui: numberUi(
		"Capture carry characters",
		"Maximum pending-context characters accepted when finishing a pass. Zero disables nonempty carry.",
		8_000,
	),
});
export const cfgChroniclerCaptureReadPageSize = register({
	id: "chronicler.capture.readPageSize",
	type: "number",
	default: 50,
	validate: integer(1),
	ui: numberUi(
		"Capture read default page size",
		"Default committed-beat metadata rows per read_chronicle call, bounded by the maximum page size.",
		50,
	),
});
export const cfgChroniclerCaptureReadPageMax = register({
	id: "chronicler.capture.readPageMax",
	type: "number",
	default: 100,
	validate: integer(1),
	ui: numberUi(
		"Capture read maximum page size",
		"Maximum committed-beat metadata rows accepted in one read_chronicle call.",
		100,
	),
});
export const cfgChroniclerCaptureReadTitleChars = register({
	id: "chronicler.capture.readTitleChars",
	type: "number",
	default: 240,
	validate: integer(1),
	ui: numberUi(
		"Capture read title characters",
		"Maximum title characters in read_chronicle metadata pages, including the truncation marker.",
		240,
	),
});
export const cfgChroniclerCaptureIndexSourceIds = register({
	id: "chronicler.capture.indexSourceIds",
	type: "number",
	default: 6,
	validate: integer(0),
	ui: numberUi(
		"Capture index source IDs",
		"Maximum source entry IDs shown for each beat in the generated session index.",
		6,
	),
});
export const cfgChroniclerCaptureLeaseRetries = register({
	id: "chronicler.capture.leaseRetries",
	type: "number",
	default: 1,
	validate: integer(0),
	ui: numberUi(
		"Capture lease acquisition retries",
		"Retries used when acquiring the session writer lease before reporting contention.",
		1,
	),
});

export const chroniclerCaptureSettings = [
	cfgChroniclerCapturePrefixEntries,
	cfgChroniclerCaptureBeatListing,
	cfgChroniclerCaptureUnseenFlushChars,
	cfgChroniclerCaptureFallbackTokens,
	cfgChroniclerCaptureContextFraction,
	cfgChroniclerCaptureAttempts,
	cfgChroniclerCaptureRetryBackoffMs,
	cfgChroniclerCaptureRecoveryMaxMs,
	cfgChroniclerCaptureRecoveryMultiplier,
	cfgChroniclerCaptureRecoveryExponent,
	cfgChroniclerCaptureOwnershipCheckMs,
	cfgChroniclerCaptureStreamStallMs,
	cfgChroniclerCaptureDeadlineMs,
	cfgChroniclerCaptureDrainMs,
	cfgChroniclerCaptureSettledKeys,
	cfgChroniclerCaptureSleepPollMs,
	cfgChroniclerCaptureMaterialCriteria,
	cfgChroniclerCaptureMinWords,
	cfgChroniclerCaptureMaxWords,
	cfgChroniclerCaptureIncludeThinking,
	cfgChroniclerCaptureCarryChars,
	cfgChroniclerCaptureReadPageSize,
	cfgChroniclerCaptureReadPageMax,
	cfgChroniclerCaptureReadTitleChars,
	cfgChroniclerCaptureIndexSourceIds,
	cfgChroniclerCaptureLeaseRetries,
] as const;
