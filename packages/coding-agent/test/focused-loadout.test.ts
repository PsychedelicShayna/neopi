import { expect, it } from "bun:test";
import * as path from "node:path";
import type { RuntimeModelLoadout } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createLoadoutFeature, LoadoutStore } from "@oh-my-pi/pi-coding-agent/neopi/loadout";
import { TempDir } from "@oh-my-pi/pi-utils";

it("switches a focused loadout without changing the profile or a sibling's activation", async () => {
	const temp = TempDir.createSync("@pi-focused-loadout-");
	try {
		const store = new LoadoutStore(path.join(temp.path(), "loadouts.json"));
		const loadout = (name: string): RuntimeModelLoadout => ({
			name,
			mainModel: "test/model",
			modelRoles: {},
			retryFallbackChains: {},
			taskAgentModelOverrides: {},
		});
		const main = loadout("Main");
		const worker = loadout("Worker");
		await store.write({ schemaVersion: 1, loadouts: { Main: main, Worker: worker }, activeLoadout: "Main" });
		const focused = createLoadoutFeature(store, "session");
		const sibling = createLoadoutFeature(store, "session");
		let applied: RuntimeModelLoadout | undefined;
		const host = {
			isIdle: () => true,
			async applyRuntimeModelLoadout(value: RuntimeModelLoadout | undefined) {
				applied = value;
			},
		};
		await focused.use("Worker", host);
		expect(applied).toEqual(worker);
		expect((await focused.data()).active).toBe("Worker");
		expect(await sibling.status()).toBe("Loadout: off");
		expect(await createLoadoutFeature(store).status()).toBe("Loadout: Main");
		await focused.off(host);
		expect(applied).toBeUndefined();
		expect((await store.read()).activeLoadout).toBe("Main");
	} finally {
		temp.removeSync();
	}
});
