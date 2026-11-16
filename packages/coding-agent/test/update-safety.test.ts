import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistUpdateChannel, readUpdatePreferences } from "../src/cli/update-config";
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

for (const tomlName of ["config.toml", "settings.toml"]) {
	for (const yamlName of [undefined, "config.yml", "config.yaml"]) {
		for (const [channel, auto, expectedChannel, expectedMode] of [
			['"stable"', '"off"', "stable", "off"],
			['"stable"', '"notify"', "stable", "notify"],
			['"stable"', '"auto"', "stable", "auto"],
			['"nightly"', '"auto"', "nightly", "auto"],
			['"canary"', '"off"', process.env.PI_UPDATE_CHANNEL === "stable" ? "stable" : "nightly", "off"],
			['"stable"', undefined, "stable", "notify"],
		] as const) {
			test(`Settings and recovery agree on ${tomlName} ${channel}/${auto} over ${yamlName ?? "absent YAML"}`, async () => {
				const root = await mkdtemp(join(tmpdir(), "neopi-update-settings-"));
				try {
					if (yamlName) await writeFile(join(root, yamlName), "update:\n  channel: nightly\n  auto: auto\n");
					await writeFile(
						join(root, tomlName),
						`[update]\nchannel = ${channel}\n${auto === undefined ? "" : `auto = ${auto}\n`}`,
					);
					let settings = await Settings.loadReadOnly({ agentDir: root, cwd: root });
					expect(cfgUpdateChannel.get(settings)).toBe(expectedChannel);
					expect(cfgUpdateAuto.get(settings)).toBe(expectedMode);
					expect(await readUpdatePreferences(root)).toEqual({ channel: expectedChannel, mode: expectedMode });
					await persistUpdateChannel("nightly", root);
					settings = await Settings.loadReadOnly({ agentDir: root, cwd: root });
					expect(cfgUpdateChannel.get(settings)).toBe("nightly");
					expect(cfgUpdateAuto.get(settings)).toBe(expectedMode);
				} finally {
					await rm(root, { recursive: true, force: true });
				}
			});
		}
	}
}

for (const tomlName of ["config.toml", "settings.toml"]) {
	for (const [legacy, expected] of [
		[true, "auto"],
		[false, "off"],
	] as const) {
		test(`Settings and recovery retain legacy YAML ${legacy} beneath unrelated ${tomlName}`, async () => {
			const root = await mkdtemp(join(tmpdir(), "neopi-update-settings-"));
			try {
				await writeFile(join(root, "config.yml"), `update:\n  channel: canary\n  auto: ${legacy}\n`);
				await writeFile(join(root, tomlName), "[startup]\nquiet = true\n");
				const settings = await Settings.loadReadOnly({ agentDir: root, cwd: root });
				expect(cfgUpdateChannel.get(settings)).toBe("nightly");
				expect(cfgUpdateAuto.get(settings)).toBe(expected);
				expect(await readUpdatePreferences(root)).toEqual({ channel: "nightly", mode: expected });
				const before = { channel: cfgUpdateChannel.get(settings), mode: cfgUpdateAuto.get(settings) };
				await persistUpdateChannel(before.channel, root);
				const after = await Settings.loadReadOnly({ agentDir: root, cwd: root });
				expect({ channel: cfgUpdateChannel.get(after), mode: cfgUpdateAuto.get(after) }).toEqual(before);
				expect(await readUpdatePreferences(root)).toEqual(before);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	}
}

for (const tomlName of ["config.toml", "settings.toml"]) {
	for (const [legacy, conservativeMode] of [
		[true, "notify"],
		[false, "off"],
	] as const) {
		test(`TOML legacy values never authorize more aggressive updates than Settings: ${tomlName}/${legacy}`, async () => {
			const root = await mkdtemp(join(tmpdir(), "neopi-update-settings-"));
			try {
				await writeFile(join(root, tomlName), `[update]\nchannel = "canary"\nauto = ${legacy}\n`);
				const settings = await Settings.loadReadOnly({ agentDir: root, cwd: root });
				expect(cfgUpdateAuto.get(settings)).toBe("notify");
				expect(await readUpdatePreferences(root)).toEqual({
					channel: cfgUpdateChannel.get(settings),
					mode: conservativeMode,
				});
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	}
}
