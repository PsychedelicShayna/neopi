import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistUpdateChannel } from "../src/cli/update-config";
import { Settings } from "../src/config/settings";
import { cfgUpdateAuto, cfgUpdateChannel } from "../src/modes/settings";

for (const [legacy, expected] of [
	[true, "auto"],
	[false, "off"],
] as const) {
	test(`legacy updater preferences preserve ${expected} mode and migrate canary to nightly`, () => {
		const settings = Settings.isolated({ "update.channel": "canary", "update.auto": legacy });
		expect(cfgUpdateChannel.get(settings)).toBe("nightly");
		expect(cfgUpdateAuto.get(settings)).toBe(expected);
	});
}

test("the full settings loader accepts a channel saved by the recovery path without losing unrelated preferences", async () => {
	const root = await mkdtemp(join(tmpdir(), "neopi-update-settings-"));
	try {
		await writeFile(join(root, "config.yml"), "startup:\n  quiet: true\nupdate:\n  auto: auto\n");
		await persistUpdateChannel("stable", root);
		const settings = await Settings.loadReadOnly({ agentDir: root, cwd: root });
		expect(cfgUpdateChannel.get(settings)).toBe("stable");
		expect(cfgUpdateAuto.get(settings)).toBe("auto");
		expect(settings.getGlobalSettings().startup).toEqual({ quiet: true });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
