/**
 * Control-socket settings (issue #171).
 *
 * `control.enabled` publishes the socket. `control.approvals` (default off)
 * lets a control connection settle tool approvals; the pane's human owns them
 * otherwise. `control.secretInput` (default off) gates secret login prompts.
 */
import { register } from "../config/registry";

export const cfgControlEnabled = register({
	id: "control.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Control",
		label: "Control socket",
		description: "Publish a local control socket so another npi session can drive this one",
	},
});

export const cfgControlApprovals = register({
	id: "control.approvals",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Control",
		label: "Control approvals",
		description: "Let a control connection answer tool approvals. Off: the pane's human owns every approval",
	},
});

export const cfgControlSecretInput = register({
	id: "control.secretInput",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Control",
		label: "Control secret input",
		description: "Let a control connection type secret login prompts and read credential settings",
	},
});

/** Settings a control client must not weaken unless control.approvals is already on. */
export const APPROVAL_GATED_SETTINGS: readonly string[] = [
	"tools.approvalMode",
	"tools.approval",
	"control.approvals",
	"control.secretInput",
];
