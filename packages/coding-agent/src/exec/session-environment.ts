import type { SessionEnvironment } from "../session/environment";
import { NON_INTERACTIVE_ENV } from "./non-interactive-env";

/** Apply live overrides after shell/direnv loading, without weakening unattended policy. */
export function applySessionEnvironment(
	command: string,
	env: Record<string, string> | undefined,
	environment?: SessionEnvironment,
	explicit?: Record<string, string>,
): { command: string; env: Record<string, string> | undefined } {
	if (!environment?.overrides().size) return { command, env };
	const merged = { ...env };
	const unset: string[] = [];
	for (const [name, value] of environment.overrides()) {
		if (Object.hasOwn(NON_INTERACTIVE_ENV, name) || (explicit && Object.hasOwn(explicit, name))) continue;
		if (value === undefined) {
			delete merged[name];
			unset.push(name);
		} else {
			merged[name] = value;
		}
	}
	return { command: unset.length ? `unset -v ${unset.join(" ")}; ${command}` : command, env: merged };
}
