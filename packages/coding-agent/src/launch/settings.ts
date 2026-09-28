/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

/**
 * Start the shared daemon broker in its own transient systemd user scope (Linux with a reachable
 * user manager), so a client confined to a unit that is killed on exit cannot take the broker and
 * its supervised daemons down with it. `false` keeps the broker in the spawning client's cgroup.
 */
export const cfgLaunchBrokerScope = register({ id: "launch.brokerScope", type: "boolean", default: true });

/**
 * Slice for the broker's transient scope. systemd nests dash-separated slice names, so the default
 * lands under `neopi.slice` in the user manager.
 */
export const cfgLaunchBrokerSlice = register({
	id: "launch.brokerSlice",
	type: "string",
	default: "neopi-broker.slice",
});
