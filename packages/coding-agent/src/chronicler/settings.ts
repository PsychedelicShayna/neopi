/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgChroniclerEnabled = register({
	id: "chronicler.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "General",
		label: "Chronicler capture",
		description:
			"Continuously capture semantic beats from this session into its session artifacts directory using the @chronicler role. Independent of Memory Backend; both may be on.",
	},
});
