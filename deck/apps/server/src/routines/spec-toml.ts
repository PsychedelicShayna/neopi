import { createSettingsTomlCodec, plainSettingsTomlTable } from "@npi-deck/protocol/settings-toml-codec";
import { parse as parseSmol } from "smol-toml";

const codec = createSettingsTomlCodec(parseSmol);

function omitUndefined(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(omitUndefined);
	if (!plainSettingsTomlTable(value)) return value;
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, omitUndefined(entry)]),
	);
}

/** Decode reserved null metadata before schema validation or execution. */
export const parse = codec.parseSettingsToml;

/** Keep RoutineSpec fields at the root; shared metadata preserves explicit JSON nulls. */
export function stringify(spec: object): string {
	return codec.stringifySettingsToml(omitUndefined(spec) as Record<string, unknown>);
}
