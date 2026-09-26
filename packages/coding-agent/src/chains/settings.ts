/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Post-processing chains
export const cfgChainingAuto = register({
	id: "chaining.auto",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Chaining",
		label: "Chain Every Prompt",
		description:
			"Send every composer prompt through the active post-processing chain (/chaining on|off). Alt+C runs the chain for one prompt either way.",
	},
});

export const cfgChainingActive = register({ id: "chaining.active", type: "string", default: "" });
