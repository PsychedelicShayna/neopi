import { type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

/** Split a recognized trailing thinking suffix without loading model or task discovery. */
export function parseSelectorSuffix(value: string): { base: string; level: ConfiguredThinkingLevel } | undefined {
	const colonIdx = value.lastIndexOf(":");
	if (colonIdx <= 0 || colonIdx === value.length - 1) return undefined;
	const level = parseConfiguredThinkingLevel(value.slice(colonIdx + 1));
	return level === undefined ? undefined : { base: value.slice(0, colonIdx), level };
}
