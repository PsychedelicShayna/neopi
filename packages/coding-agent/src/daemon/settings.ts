/** Session-daemon settings. */
import { register } from "../config/registry";

export const cfgDaemonEnabled = register({
	id: "daemon.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Session daemon",
		label: "Open the session hub",
		description:
			"Plain `npi` opens the session hub: sessions live in a background daemon, keep running when you close the window, and several terminals can attach to one. `npi --standalone` always runs a session without the daemon.",
	},
});
