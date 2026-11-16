import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSettingsToml } from "@oh-my-pi/pi-utils/settings-toml";
import { checkForAutomaticUpdate, runNeoPiUpdate, type UpdateOptions } from "../src/cli/neopi-updater";
import { persistUpdateChannel, readUpdatePreferences } from "../src/cli/update-config";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function profile(files: Record<string, string>): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "neopi-update-config-"));
	roots.push(root);
	await Promise.all(Object.entries(files).map(([name, content]) => fs.writeFile(path.join(root, name), content)));
	return root;
}
const staleYaml = "# keep YAML unchanged\nupdate:\n  channel: nightly\n  auto: auto\n  future: inherited\n";

for (const tomlName of ["config.toml", "settings.toml"]) {
	for (const yamlName of [undefined, "config.yml", "config.yaml"]) {
		for (const [channel, auto, expectedChannel, expectedMode] of [
			['"stable"', '"off"', "stable", "off"],
			['"stable"', '"notify"', "stable", "notify"],
			['"stable"', '"auto"', "stable", "auto"],
			['"nightly"', "true", "nightly", "notify"],
			['"canary"', "false", process.env.PI_UPDATE_CHANNEL === "stable" ? "stable" : "nightly", "off"],
		] as const) {
			test(`${tomlName} overrides ${yamlName ?? "absent YAML"}: ${channel}/${auto}`, async () => {
				const root = await profile({
					...(yamlName ? { [yamlName]: staleYaml } : {}),
					[tomlName]: `[update]\nchannel = ${channel}\nauto = ${auto}\n`,
				});
				expect(await readUpdatePreferences(root)).toEqual({ channel: expectedChannel, mode: expectedMode });
			});
		}
	}
}

test("a TOML update table replaces YAML wholesale; unrelated TOML retains the YAML table", async () => {
	const root = await profile({ "config.yml": staleYaml, "config.toml": '[update]\nchannel = "stable"\n' });
	expect(await readUpdatePreferences(root)).toEqual({ channel: "stable", mode: "notify" });
	await fs.writeFile(path.join(root, "config.toml"), "[startup]\nquiet = true\n");
	expect(await readUpdatePreferences(root)).toEqual({ channel: "nightly", mode: "auto" });
	await fs.writeFile(path.join(root, "config.toml"), '__npi = { version = 1, null_paths = ["/update"] }\n');
	expect((await readUpdatePreferences(root)).mode).toBe("notify");
});

for (const tomlName of ["config.toml", "settings.toml"]) {
	for (const yamlName of [undefined, "config.yml", "config.yaml"]) {
		test(`channel writes select ${tomlName}, preserve preferences, and never create YAML (${yamlName ?? "none"})`, async () => {
			const original =
				'# unrelated comment\n[startup]\nquiet = true # retained\n[update]\nchannel = "stable"\nauto = "off"\nfuture = "preserved"\n';
			const root = await profile({ ...(yamlName ? { [yamlName]: staleYaml } : {}), [tomlName]: original });
			await persistUpdateChannel("nightly", root);
			const saved = await fs.readFile(path.join(root, tomlName), "utf8");
			expect(parseSettingsToml(saved)).toEqual({
				startup: { quiet: true },
				update: { channel: "nightly", auto: "off", future: "preserved" },
			});
			expect(saved).toContain("# unrelated comment\n[startup]\nquiet = true # retained\n");
			expect(await readUpdatePreferences(root)).toEqual({ channel: "nightly", mode: "off" });
			expect((await fs.readdir(root)).sort()).toEqual([tomlName, ...(yamlName ? [yamlName] : [])].sort());
			if (yamlName) expect(await fs.readFile(path.join(root, yamlName), "utf8")).toBe(staleYaml);
		});
	}
}

test("first TOML update-table write copies inherited YAML keys and preserves explicit clears", async () => {
	const root = await profile({
		"config.yml": staleYaml,
		"config.toml": '# retained\nstartup = { quiet = true }\n__npi = { version = 1, null_paths = ["/future"] }\n',
	});
	await persistUpdateChannel("stable", root);
	expect(parseSettingsToml(await fs.readFile(path.join(root, "config.toml"), "utf8"))).toEqual({
		startup: { quiet: true },
		future: null,
		update: { channel: "stable", auto: "auto", future: "inherited" },
	});
	expect(await fs.readFile(path.join(root, "config.yml"), "utf8")).toBe(staleYaml);
});

for (const problem of ["malformed", "duplicate", "unreadable-toml", "dangling-toml", "unreadable-yaml"] as const) {
	test(`invalid selected sources fail closed without stale automatic preferences: ${problem}`, async () => {
		const root = await profile({ "config.yml": staleYaml });
		const toml = path.join(root, "config.toml");
		if (problem === "malformed") await fs.writeFile(toml, "update = [broken\n");
		else if (problem === "duplicate") {
			await fs.writeFile(toml, '[update]\nchannel = "stable"\n');
			await fs.writeFile(path.join(root, "settings.toml"), "");
		} else if (problem === "unreadable-toml") await fs.mkdir(toml);
		else if (problem === "dangling-toml") await fs.symlink(path.join(root, "missing"), toml);
		else {
			await fs.rm(path.join(root, "config.yml"));
			await fs.mkdir(path.join(root, "config.yml"));
			await fs.writeFile(toml, '[update]\nchannel = "stable"\nauto = "auto"\n');
		}
		const preferences = await readUpdatePreferences(root);
		expect(preferences.warning).toContain("Cannot read update preferences");
		expect(preferences.mode).toBe("notify");
		const executablePath = path.join(root, "sentinel");
		await fs.writeFile(executablePath, "not an executable");
		let requests = 0;
		await checkForAutomaticUpdate(
			{ ...preferences, agentDir: root, onMessage: () => {} },
			{
				executablePath,
				fetcher: (async (_input: string | URL | Request): Promise<Response> => {
					requests++;
					throw new Error("No network allowed");
				}) as typeof fetch,
			},
		);
		expect(requests).toBe(0);
		let committed = false;
		await expect(
			persistUpdateChannel("stable", root, async () => {
				committed = true;
			}),
		).rejects.toThrow();
		expect(committed).toBe(false);
		if (problem !== "unreadable-yaml")
			expect(await fs.readFile(path.join(root, "config.yml"), "utf8")).toBe(staleYaml);
	});
}

for (const name of ["config.yml", "config.toml", "settings.toml"]) {
	for (const linked of [false, true]) {
		test(`failed state commit restores exact bytes, link and permissions: ${name}, symlink=${linked}`, async () => {
			const original = name.endsWith("toml")
				? '# exact bytes\n[update]\nchannel="nightly"\nauto="off"\n'
				: staleYaml;
			const root = await profile(linked ? { physical: original } : { [name]: original });
			const logical = path.join(root, name);
			const physical = linked ? path.join(root, "physical") : logical;
			if (linked) await fs.symlink(physical, logical);
			await fs.chmod(physical, 0o660);
			await expect(
				persistUpdateChannel("stable", root, async () => {
					throw new Error("state disk full");
				}),
			).rejects.toThrow("state disk full");
			expect(await fs.readFile(physical, "utf8")).toBe(original);
			expect((await fs.stat(physical)).mode & 0o777).toBe(0o660);
			expect((await fs.lstat(logical)).isSymbolicLink()).toBe(linked);
			await persistUpdateChannel("stable", root);
			expect(await readUpdatePreferences(root)).toEqual({
				channel: "stable",
				mode: name.endsWith("toml") ? "off" : "auto",
			});
			expect((await fs.stat(physical)).mode & 0o777).toBe(0o660);
			expect((await fs.lstat(logical)).isSymbolicLink()).toBe(linked);
		});
	}
}

test("failed state commit removes newly-created YAML rather than leaving an empty file", async () => {
	const root = await profile({});
	await expect(
		persistUpdateChannel("stable", root, async () => {
			throw new Error("state disk full");
		}),
	).rejects.toThrow("state disk full");
	expect(await fs.readdir(root)).toEqual([]);
});

for (const name of ["config.yml", "config.toml"]) {
	test(`failed state commit preserves an external edit to ${name}`, async () => {
		const root = await profile({ [name]: name.endsWith("toml") ? '[update]\nchannel="nightly"\n' : staleYaml });
		const external = name.endsWith("toml")
			? '# external\n[update]\nchannel="stable"\nauto="off"\n'
			: "# external\nupdate:\n  auto: off\n";
		await expect(
			persistUpdateChannel("stable", root, async () => {
				await fs.writeFile(path.join(root, name), external);
				throw new Error("state disk full");
			}),
		).rejects.toThrow("refusing to overwrite the external edit");
		expect(await fs.readFile(path.join(root, name), "utf8")).toBe(external);
	});
}

for (const change of [
	"yaml-edit",
	"yaml-disappears",
	"toml-appears",
	"toml-disappears",
	"toml-edit",
	"toml-conflict",
	"yaml-selection",
	"symlink-retarget",
] as const) {
	test(`pre-publication source changes are refused without state commit: ${change}`, async () => {
		const initial = "# initial\n[startup]\nquiet=true\n";
		const root = await profile({
			"config.yaml": staleYaml,
			...(change === "toml-appears" ? {} : { "config.toml": initial }),
		});
		if (change === "symlink-retarget") {
			await fs.rename(path.join(root, "config.toml"), path.join(root, "physical"));
			await fs.symlink(path.join(root, "physical"), path.join(root, "config.toml"));
			await fs.writeFile(path.join(root, "other"), initial);
		}
		const originalWrite = fs.writeFile;
		let staged = false;
		const write = spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
			await originalWrite(file, data, options);
			if (!String(file).includes(".update-") || staged) return;
			staged = true;
			if (change === "yaml-edit") await originalWrite(path.join(root, "config.yaml"), "update:\n  auto: off\n");
			else if (change === "yaml-disappears") await fs.unlink(path.join(root, "config.yaml"));
			else if (change === "toml-appears") await originalWrite(path.join(root, "config.toml"), initial);
			else if (change === "toml-disappears") await fs.unlink(path.join(root, "config.toml"));
			else if (change === "toml-edit") await originalWrite(path.join(root, "config.toml"), "# external\n");
			else if (change === "toml-conflict") await originalWrite(path.join(root, "settings.toml"), "");
			else if (change === "yaml-selection")
				await originalWrite(path.join(root, "config.yml"), "update:\n  auto: off\n");
			else {
				await fs.unlink(path.join(root, "config.toml"));
				await fs.symlink(path.join(root, "other"), path.join(root, "config.toml"));
			}
		});
		let committed = false;
		try {
			await expect(
				persistUpdateChannel("stable", root, async () => {
					committed = true;
				}),
			).rejects.toThrow();
		} finally {
			write.mockRestore();
		}
		expect(staged).toBe(true);
		expect(committed).toBe(false);
		expect((await fs.readdir(root)).some(name => name.includes(".update-"))).toBe(false);
		if (change === "toml-disappears") expect((await fs.readdir(root)).includes("config.toml")).toBe(false);
		else
			expect(await fs.readFile(path.join(root, "config.toml"), "utf8")).toBe(
				change === "toml-edit" ? "# external\n" : initial,
			);
	});
}

// This is an ordinary non-executable sentinel, never an installed binary.
// The fetch adapter returns metadata only and refuses every download URL.
async function updaterProfile(mode: "off" | "notify" | "auto") {
	const root = await profile({
		"config.yml": staleYaml,
		"config.toml": `[update]\nchannel = "stable"\nauto = "${mode}"\n`,
		sentinel: "not an executable; must remain unchanged\n",
	});
	const executablePath = path.join(root, "sentinel");
	const requests: string[] = [];
	const published = [
		{
			id: 1,
			tag_name: "v18.19.0",
			prerelease: false,
			draft: false,
			published_at: "2026-11-10T12:00:00Z",
			assets: [],
		},
		{
			id: 2,
			tag_name: "v18.19.0-nightly.fixture",
			prerelease: true,
			draft: false,
			published_at: "2026-11-11T12:00:00Z",
			assets: [],
		},
	];
	const options: UpdateOptions = {
		agentDir: root,
		executablePath,
		version: "18.18.8",
		print: () => {},
		fetcher: (async input => {
			const url = String(input);
			requests.push(url);
			if (!url.startsWith("https://api.github.com/repos/PsychedelicShayna/neopi/releases?"))
				throw new Error(`No downloads or network access allowed: ${url}`);
			return Response.json(published);
		}) as typeof fetch,
	};
	const image = await fs.stat(executablePath);
	const installed = {
		id: 1,
		tag: "v18.19.0",
		channel: "stable",
		publishedAt: published[0].published_at,
		sha256: "",
		size: image.size,
		mtimeMs: image.mtimeMs,
	};
	return { root, executablePath, requests, options, installed };
}

for (const mode of ["off", "notify", "auto"] as const) {
	test(`startup preference flow respects TOML stable/${mode} without downloading or replacing anything`, async () => {
		const f = await updaterProfile(mode);
		if (mode === "auto")
			await fs.writeFile(`${f.executablePath}.update.json`, JSON.stringify({ version: 1, installed: f.installed }));
		const messages: string[] = [];
		const preferences = await readUpdatePreferences(f.root);
		await checkForAutomaticUpdate(
			{ ...preferences, agentDir: f.root, onMessage: message => messages.push(message) },
			f.options,
		);
		expect(await fs.readFile(f.executablePath, "utf8")).toBe("not an executable; must remain unchanged\n");
		expect(f.requests.length).toBe(mode === "off" ? 0 : 1);
		if (mode === "notify") expect(messages).toEqual(["NeoPi v18.19.0 available. Run npi update stable to install."]);
		if (mode === "auto")
			expect(JSON.parse(await fs.readFile(`${f.executablePath}.update.json`, "utf8")).lastCheck.channel).toBe(
				"stable",
			);
		expect(await fs.readFile(path.join(f.root, "config.yml"), "utf8")).toBe(staleYaml);
	});
}

test("already-installed explicit channel sync updates active TOML only, without downloading or replacing anything", async () => {
	const f = await updaterProfile("off");
	await fs.writeFile(
		`${f.executablePath}.update.json`,
		JSON.stringify({
			version: 1,
			installed: { ...f.installed, id: 2, tag: "v18.19.0-nightly.fixture", channel: "nightly" },
		}),
	);
	const messages: string[] = [];
	await runNeoPiUpdate(["nightly"], { ...f.options, print: message => messages.push(message) });
	expect(messages.join("\n")).toContain("channel set to nightly");
	expect(await readUpdatePreferences(f.root)).toEqual({ channel: "nightly", mode: "off" });
	expect(await fs.readFile(path.join(f.root, "config.yml"), "utf8")).toBe(staleYaml);
	expect(await fs.readFile(f.executablePath, "utf8")).toBe("not an executable; must remain unchanged\n");
	expect(f.requests).toHaveLength(1);
});

test("TOML-owned rollback holds ignore stale YAML edits and captured preferences, then release on an owner channel change", async () => {
	const f = await updaterProfile("notify");
	const statePath = `${f.executablePath}.update.json`;
	await fs.writeFile(statePath, JSON.stringify({ version: 1, hold: { agentDir: f.root, channel: "stable" } }));
	await fs.writeFile(path.join(f.root, "config.yml"), "update:\n  channel: nightly\n  auto: off\n");
	await checkForAutomaticUpdate(
		{ channel: "stable", mode: "notify", agentDir: f.root, onMessage: () => {} },
		f.options,
	);
	expect(JSON.parse(await fs.readFile(statePath, "utf8")).hold).toEqual({ agentDir: f.root, channel: "stable" });
	await persistUpdateChannel("nightly", f.root);
	await checkForAutomaticUpdate(
		{ channel: "stable", mode: "notify", agentDir: f.root, onMessage: () => {} },
		f.options,
	);
	expect(JSON.parse(await fs.readFile(statePath, "utf8")).hold).toBeDefined();
	expect(f.requests).toHaveLength(0);
	await checkForAutomaticUpdate(
		{ channel: "nightly", mode: "notify", agentDir: f.root, onMessage: () => {} },
		f.options,
	);
	expect(JSON.parse(await fs.readFile(statePath, "utf8")).hold).toBeUndefined();
	expect(await fs.readFile(f.executablePath, "utf8")).toBe("not an executable; must remain unchanged\n");
});

test("another profile's TOML channel cannot release a machine-wide rollback hold", async () => {
	const f = await updaterProfile("notify");
	const statePath = `${f.executablePath}.update.json`;
	const hold = { agentDir: path.join(f.root, "another-profile"), channel: "nightly" };
	await fs.writeFile(statePath, JSON.stringify({ version: 1, hold }));
	await checkForAutomaticUpdate(
		{ channel: "stable", mode: "notify", agentDir: f.root, onMessage: () => {} },
		f.options,
	);
	expect(JSON.parse(await fs.readFile(statePath, "utf8")).hold).toEqual(hold);
	expect(f.requests).toHaveLength(0);
});
