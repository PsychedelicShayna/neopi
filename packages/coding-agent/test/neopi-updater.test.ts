import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForAutomaticUpdate, runNeoPiUpdate, type UpdateOptions } from "../src/cli/neopi-updater";
import { persistUpdateChannel } from "../src/cli/update-config";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(tags = Array.from({ length: 7 }, (_, i) => `v18.18.8-nightly.fixture${i + 1}`)) {
	const root = await mkdtemp(join(tmpdir(), "neopi-update-state-"));
	roots.push(root);
	const agentDir = join(root, "profile-a");
	await mkdir(agentDir);
	await writeFile(join(agentDir, "config.yml"), "# keep me\nupdate:\n  channel: nightly\n  auto: auto\n");
	const executablePath = join(root, "npi");
	const initial = "#!/bin/sh\necho npi/18.18.8\n# local build\n";
	await writeFile(executablePath, initial);
	await chmod(executablePath, 0o755);
	const requests: string[] = [];
	const bodies = new Map<string, string>();
	const ancestry = new Map<string, string | number>();
	const releases = tags.map((tag_name, index) => {
		const version = /^v(\d+\.\d+\.\d+)/.exec(tag_name)![1];
		const body = `#!/bin/sh\necho npi/${version}\n# ${tag_name}\n`;
		const base = `https://github.com/PsychedelicShayna/neopi/releases/download/${encodeURIComponent(tag_name)}`;
		bodies.set(`${base}/npi-linux-x64`, body);
		bodies.set(`${base}/SHA256SUMS.txt`, `${createHash("sha256").update(body).digest("hex")}  npi-linux-x64\n`);
		return {
			id: index + 1,
			tag_name,
			prerelease: tag_name.includes("-nightly"),
			draft: false,
			target_commitish: "b".repeat(40),
			published_at: `2026-11-${String(index + 1).padStart(2, "0")}T12:00:00Z`,
			assets: [
				{ name: "npi-linux-x64", size: Buffer.byteLength(body), browser_download_url: `${base}/npi-linux-x64` },
				{
					name: "SHA256SUMS.txt",
					size: Buffer.byteLength(bodies.get(`${base}/SHA256SUMS.txt`)!),
					browser_download_url: `${base}/SHA256SUMS.txt`,
				},
			],
		};
	});
	const fetcher = (async (input: string | URL | Request) => {
		const url = String(input);
		requests.push(url);
		if (url.includes("/compare/")) {
			const comparison = ancestry.get(decodeURIComponent(url.slice(url.indexOf("...") + 3))) ?? "ahead";
			return typeof comparison === "number"
				? new Response("Comparison unavailable", { status: comparison })
				: Response.json({ status: comparison });
		}
		if (url.includes("api.github.com")) return Response.json(releases);
		const body = bodies.get(url);
		return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
	}) as typeof fetch;
	const options: UpdateOptions = { executablePath, agentDir, fetcher, print: () => {} };
	const state = async () => JSON.parse(await readFile(`${executablePath}.update.json`, "utf8"));
	return { root, agentDir, executablePath, initial, requests, bodies, ancestry, releases, options, state };
}

test("rollback 2 twice advances four releases from a publication-ordered cursor and holds every profile", async () => {
	const f = await fixture();
	// Deliberately scramble the release API's creation order.
	f.releases.reverse();
	await runNeoPiUpdate(["nightly"], f.options);
	await runNeoPiUpdate(["rollback", "2"], f.options);
	expect((await f.state()).installed.tag).toBe("v18.18.8-nightly.fixture5");
	await runNeoPiUpdate(["rollback", "2"], f.options);
	expect((await f.state()).installed.tag).toBe("v18.18.8-nightly.fixture3");
	expect((await f.state()).hold).toEqual({ agentDir: f.agentDir, channel: "nightly" });
	expect(await readFile(`${f.executablePath}.previous`, "utf8")).toContain("fixture5");
	const other = join(f.root, "profile-b");
	await mkdir(other);
	await writeFile(join(other, "config.yml"), "update:\n  channel: stable\n  auto: auto\n");
	const count = f.requests.length;
	await checkForAutomaticUpdate({ channel: "stable", mode: "auto", agentDir: other, onMessage: () => {} }, f.options);
	await checkForAutomaticUpdate(
		{ channel: "nightly", mode: "auto", agentDir: f.agentDir, onMessage: () => {} },
		f.options,
	);
	expect(f.requests.length).toBe(count);
	expect((await f.state()).installed.tag).toBe("v18.18.8-nightly.fixture3");
	const lines: string[] = [];
	await runNeoPiUpdate([], { ...f.options, print: line => lines.push(line) });
	expect(lines.join("\n")).toContain("Rollback hold: ON");
	await runNeoPiUpdate(["nightly"], f.options);
	expect((await f.state()).installed.tag).toBe("v18.18.8-nightly.fixture7");
	expect((await f.state()).hold).toBeUndefined();
	expect(await readFile(join(f.agentDir, "config.yml"), "utf8")).toContain("# keep me");
});

test("the hold owner's changed channel releases it; stale captured preferences do not", async () => {
	const f = await fixture(["v18.18.8-nightly.fixture1", "v18.18.8-nightly.fixture2", "v18.18.8+stable3"]);
	await runNeoPiUpdate(["nightly"], f.options);
	await runNeoPiUpdate(["rollback"], f.options);
	await checkForAutomaticUpdate(
		{ channel: "stable", mode: "auto", agentDir: f.agentDir, onMessage: () => {} },
		f.options,
	);
	expect((await f.state()).hold).toBeDefined();
	await persistUpdateChannel("stable", f.agentDir);
	const messages: string[] = [];
	await runNeoPiUpdate([], { ...f.options, print: message => messages.push(message) });
	expect(messages.join("\n")).toContain("Rollback hold: off");
	await checkForAutomaticUpdate(
		{ channel: "stable", mode: "auto", agentDir: f.agentDir, onMessage: () => {} },
		f.options,
	);
	expect((await f.state()).hold).toBeUndefined();
	expect((await f.state()).installed.tag).toBe("v18.18.8+stable3");
});

test("a newer same-semver nightly is eligible using immutable Git ancestry", async () => {
	const f = await fixture();
	await checkForAutomaticUpdate(
		{ channel: "nightly", mode: "auto", agentDir: f.agentDir, onMessage: () => {} },
		{ ...f.options, version: "18.18.8", gitSha: "a".repeat(40) },
	);
	expect((await f.state()).installed.tag).toBe("v18.18.8-nightly.fixture7");
	expect(f.requests.some(url => url.includes(`/compare/${"a".repeat(40)}...`))).toBe(true);
});

test("new local updater builds never auto-install the stale published legacy channels", async () => {
	const f = await fixture(["v18.14.0-nightly.legacy", "v18.10.3+stable"]);
	for (const channel of ["nightly", "stable"] as const) {
		await persistUpdateChannel(channel, f.agentDir);
		await checkForAutomaticUpdate(
			{ channel, mode: "auto", agentDir: f.agentDir, onMessage: () => {} },
			{ ...f.options, version: "18.18.8" },
		);
	}
	expect(await readFile(f.executablePath, "utf8")).toBe(f.initial);
	expect(f.requests.every(url => url.includes("api.github.com"))).toBe(true);
	expect((await f.state()).installed).toBeUndefined();
});

test("declining a legacy rollback preserves binary and cursor before downloading", async () => {
	const f = await fixture(["v18.14.0-nightly.legacy"]);
	const warnings: string[] = [];
	await expect(
		runNeoPiUpdate(["rollback"], {
			...f.options,
			confirmLegacy: async message => {
				warnings.push(message);
				return false;
			},
		}),
	).rejects.toThrow("cancelled");
	expect(warnings).toHaveLength(1);
	expect(await readFile(f.executablePath, "utf8")).toBe(f.initial);
	expect(f.requests.every(url => url.includes("api.github.com"))).toBe(true);
});

test("checksum refusal leaves the installed release, previous image and rollback cursor unchanged", async () => {
	const f = await fixture();
	await runNeoPiUpdate(["nightly"], f.options);
	const before = await f.state();
	const previous = await readFile(`${f.executablePath}.previous`, "utf8");
	for (const [url] of f.bodies)
		if (url.includes("fixture6") && url.endsWith("SHA256SUMS.txt"))
			f.bodies.set(url, `${"0".repeat(64)}  npi-linux-x64\n`);
	await expect(runNeoPiUpdate(["rollback"], f.options)).rejects.toThrow(/checksum|sha256/i);
	expect(await f.state()).toEqual(before);
	expect(await readFile(f.executablePath, "utf8")).toContain("fixture7");
	expect(await readFile(`${f.executablePath}.previous`, "utf8")).toBe(previous);
});

test("broken normal settings cannot prevent binary recovery or get overwritten", async () => {
	const f = await fixture();
	const broken = "update: [ definitely: not: valid yaml\n";
	await writeFile(join(f.agentDir, "config.yml"), broken);
	const messages: string[] = [];
	await runNeoPiUpdate(["nightly"], { ...f.options, print: message => messages.push(message) });
	expect((await f.state()).installed.tag).toBe("v18.18.8-nightly.fixture7");
	expect(await readFile(join(f.agentDir, "config.yml"), "utf8")).toBe(broken);
	expect(messages.join("\n")).toContain("channel was not changed");
});

test("failed channel write never calls state commit; failed state commit restores existing preferences", async () => {
	const f = await fixture();
	const path = join(f.agentDir, "config.yml");
	const original = await readFile(path, "utf8");
	await writeFile(path, "update: [broken\n");
	let committed = false;
	await expect(
		persistUpdateChannel("stable", f.agentDir, async () => {
			committed = true;
		}),
	).rejects.toThrow();
	expect(committed).toBe(false);
	await writeFile(path, original);
	await expect(
		persistUpdateChannel("stable", f.agentDir, async () => {
			throw new Error("state disk full");
		}),
	).rejects.toThrow("state disk full");
	expect(await readFile(path, "utf8")).toBe(original);
});

test("an interrupted binary commit restores the old cursor instead of skipping another release", async () => {
	const f = await fixture();
	await runNeoPiUpdate(["nightly"], f.options);
	await runNeoPiUpdate(["rollback"], f.options);
	expect((await f.state()).installed.tag).toBe("v18.18.8-nightly.fixture6");
	// Model the installer's interrupted-transaction recovery: state reached the
	// new release, but the old executable was restored before its commit marker.
	await unlink(f.executablePath);
	await rename(`${f.executablePath}.previous`, f.executablePath);
	const messages: string[] = [];
	await runNeoPiUpdate([], { ...f.options, print: message => messages.push(message) });
	expect(messages.join("\n")).toContain("Rollback cursor: v18.18.8-nightly.fixture7");
	await runNeoPiUpdate(["rollback", "2"], f.options);
	expect((await f.state()).installed.tag).toBe("v18.18.8-nightly.fixture5");
});

test("copy-based executable restoration preserves the old cursor and its machine-wide hold", async () => {
	const f = await fixture();
	await runNeoPiUpdate(["nightly"], f.options);
	await runNeoPiUpdate(["rollback"], f.options);
	await runNeoPiUpdate(["rollback"], f.options);
	expect((await f.state()).installed.tag).toBe("v18.18.8-nightly.fixture5");
	const restored = `${f.executablePath}.restored`;
	await copyFile(`${f.executablePath}.previous`, restored);
	await utimes(restored, new Date("2020-01-01"), new Date("2020-01-01"));
	await unlink(f.executablePath);
	await rename(restored, f.executablePath);
	const messages: string[] = [];
	await runNeoPiUpdate([], { ...f.options, print: message => messages.push(message) });
	expect(messages.join("\n")).toContain("Rollback cursor: v18.18.8-nightly.fixture6");
	expect(messages.join("\n")).toContain("Rollback hold: ON");
	const requests = f.requests.length;
	await checkForAutomaticUpdate(
		{ channel: "nightly", mode: "auto", agentDir: f.agentDir, onMessage: () => {} },
		f.options,
	);
	expect(f.requests.length).toBe(requests);
	await runNeoPiUpdate(["rollback", "2"], f.options);
	expect((await f.state()).installed.tag).toBe("v18.18.8-nightly.fixture4");
});

test("interrupted recovery never assigns a stale release cursor to a manually replaced build", async () => {
	const f = await fixture();
	await runNeoPiUpdate(["nightly"], f.options);
	const manualBuild = "#!/bin/sh\necho npi/18.18.8\n# separately installed, untracked manual build\n";
	await writeFile(f.executablePath, manualBuild);
	await runNeoPiUpdate(["nightly"], f.options);
	await unlink(f.executablePath);
	await rename(`${f.executablePath}.previous`, f.executablePath);
	const messages: string[] = [];
	await runNeoPiUpdate([], { ...f.options, print: message => messages.push(message) });
	expect(messages.join("\n")).toContain("Rollback cursor: current build");
	expect(messages.join("\n")).toContain("local/source build");
	await runNeoPiUpdate(["rollback", "2"], f.options);
	expect((await f.state()).installed.tag).toBe("v18.18.8-nightly.fixture6");
});

test.each(["behind", "diverged", "unknown", 503])(
	"same-version releases without verified updater ancestry (%s) require acknowledgement and never auto-install",
	async comparison => {
		const tag = "v18.18.8+legacy.fixture";
		const f = await fixture([tag]);
		f.ancestry.set(tag, comparison);
		let acknowledgements = 0;
		await expect(
			runNeoPiUpdate(["stable"], {
				...f.options,
				confirmLegacy: async () => {
					acknowledgements++;
					return false;
				},
			}),
		).rejects.toThrow("cancelled");
		expect(acknowledgements).toBe(1);
		await persistUpdateChannel("stable", f.agentDir);
		await checkForAutomaticUpdate(
			{ channel: "stable", mode: "auto", agentDir: f.agentDir, onMessage: () => {} },
			f.options,
		);
		expect(await readFile(f.executablePath, "utf8")).toBe(f.initial);
		expect((await f.state()).installed).toBeUndefined();
		expect(f.requests.every(url => url.includes("api.github.com"))).toBe(true);
	},
);

test("the first implementation's identical source ancestry is updater-capable", async () => {
	const tag = "v18.18.8-nightly.first-updater";
	const f = await fixture([tag]);
	f.ancestry.set(tag, "identical");
	await runNeoPiUpdate(["nightly"], {
		...f.options,
		confirmLegacy: async () => {
			throw new Error("Updater-capable source must not request legacy acknowledgement");
		},
	});
	expect((await f.state()).installed.tag).toBe(tag);
	expect(await readFile(f.executablePath, "utf8")).toContain(tag);
});
