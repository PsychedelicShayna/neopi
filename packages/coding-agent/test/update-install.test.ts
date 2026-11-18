import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type InstallRelease, installRelease, recoverPendingUpdate, withUpdateLock } from "../src/cli/update-install";
import { WINDOWS_RECOVERY_HELPER } from "../src/cli/update-recovery-helper";

const VERSION = "18.18.8";
const ORIGINAL = "#!/bin/sh\nprintf '18.18.7\\n'\n";
const PREVIOUS = "#!/bin/sh\nprintf '18.18.6\\n'\n";
const BINARY = `#!/bin/sh\n[ "$PI_CODING_AGENT_DIR" = "$HOME/agent" ] || exit 9\nprintf '${VERSION}\\n'\n`;
const encoder = new TextEncoder();

interface Fixture {
	release: InstallRelease;
	fetcher: typeof fetch;
	requests: string[];
}

function fixture(name = "npi-linux-x64", binary = BINARY, checksumRows?: string): Fixture {
	const bytes = encoder.encode(binary);
	const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	const sums = checksumRows ?? `${sha256}  ${name}\n`;
	const assets = [
		{
			name,
			browser_download_url: `https://github.com/PsychedelicShayna/neopi/releases/download/v${VERSION}/${name}`,
			size: bytes.byteLength,
		},
		{
			name: "SHA256SUMS.txt",
			browser_download_url: `https://github.com/PsychedelicShayna/neopi/releases/download/v${VERSION}/SHA256SUMS.txt`,
			size: encoder.encode(sums).byteLength,
		},
	];
	const requests: string[] = [];
	const fetcher = (async input => {
		const url = String(input);
		requests.push(url);
		if (url === assets[1]!.browser_download_url) return new Response(sums);
		if (url !== assets[0]!.browser_download_url) throw new Error(`Unexpected fetch: ${url}`);
		let offset = 0;
		return new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					if (offset === bytes.length) return controller.close();
					const end = Math.min(offset + 7, bytes.length);
					controller.enqueue(bytes.subarray(offset, end));
					offset = end;
				},
			}),
		);
	}) as typeof fetch;
	return { release: { tag_name: `v${VERSION}`, assets }, fetcher, requests };
}

function failure(message: string, code = "EPERM"): Error {
	return Object.assign(new Error(message), { code });
}

// These execute the real installer, probes and filesystem on POSIX. The win32
// option plus narrow syscall failures exercise Windows sequencing, NOT Windows
// loader/share semantics; a real Windows canary remains required.
describe.skipIf(process.platform === "win32")("release executable installation", () => {
	let directory: string;
	let target: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "npi-update-install-"));
		target = path.join(directory, "npi");
		await Bun.write(target, ORIGINAL);
		await fs.chmod(target, 0o755);
		await Bun.write(`${target}.previous`, PREVIOUS);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(directory, { recursive: true, force: true });
		if (process.platform === "linux") {
			const hash = new Bun.CryptoHasher("sha256").update(target).digest("hex");
			await fs.rm(path.join(process.env.XDG_RUNTIME_DIR || "/tmp", `npi-install-${hash}.lock`), { force: true });
		}
	});

	async function unchanged(): Promise<void> {
		expect(await Bun.file(target).text()).toBe(ORIGINAL);
		expect(await Bun.file(`${target}.previous`).text()).toBe(PREVIOUS);
	}

	async function transactions(): Promise<string[]> {
		return (await fs.readdir(directory)).filter(name => name.startsWith("npi.update-transaction-"));
	}

	it.each([
		["linux", "x64", "glibc", "npi-linux-x64"],
		["linux", "arm64", "glibc", "npi-linux-arm64"],
		["linux", "x64", "musl", "npi-linux-musl-x64"],
		["linux", "arm64", "musl", "npi-linux-musl-arm64"],
		["darwin", "x64", undefined, "npi-darwin-x64"],
		["darwin", "arm64", undefined, "npi-darwin-arm64"],
		["win32", "x64", undefined, "npi-windows-x64.exe"],
		["win32", "arm64", undefined, "npi-windows-arm64.exe"],
	] as const)("selects only the exact %s-%s-%s asset", async (platform, arch, libc, name) => {
		const { release, fetcher, requests } = fixture(name);
		const result = await installRelease(release, { executablePath: target, fetcher, platform, arch, libc });
		expect(await Bun.file(target).text()).toBe(BINARY);
		expect(await Bun.file(result.previousPath).text()).toBe(ORIGINAL);
		expect(result.previousPath).toBe(`${await fs.realpath(target)}.previous`);
		expect(result.sha256).toBe(new Bun.CryptoHasher("sha256").update(BINARY).digest("hex"));
		expect(requests).toEqual([release.assets[1]!.browser_download_url, release.assets[0]!.browser_download_url]);
		expect(await transactions()).toEqual([]);
	});

	it("refuses source-mode default replacement before fetching", async () => {
		const { release, fetcher, requests } = fixture();
		await expect(installRelease(release, { fetcher, platform: "linux", arch: "x64", libc: "glibc" })).rejects.toThrow(
			"compiled npi",
		);
		expect(requests).toEqual([]);
		await unchanged();
	});

	it("refuses unsupported platforms, duplicate assets and foreign URLs before downloading", async () => {
		const test = fixture();
		await expect(
			installRelease(test.release, { executablePath: target, fetcher: test.fetcher, platform: "freebsd" }),
		).rejects.toThrow("Unsupported");
		test.release.assets.push(test.release.assets[0]!);
		await expect(
			installRelease(test.release, {
				executablePath: target,
				fetcher: test.fetcher,
				libc: "glibc",
				platform: "linux",
				arch: "x64",
			}),
		).rejects.toThrow("exactly one");
		test.release.assets.pop();
		test.release.assets[0]!.browser_download_url =
			"https://github.com/oh-my-pi/oh-my-pi/releases/download/v18.18.8/npi-linux-x64";
		await expect(
			installRelease(test.release, {
				executablePath: target,
				fetcher: test.fetcher,
				libc: "glibc",
				platform: "linux",
				arch: "x64",
			}),
		).rejects.toThrow("non-NeoPi");
		expect(test.requests).toEqual([]);
		await unchanged();
	});

	it("refuses a final-component symlink rather than replacing its target", async () => {
		const alias = path.join(directory, "alias");
		await fs.symlink(target, alias);
		const { release, fetcher } = fixture();
		await expect(
			installRelease(release, { executablePath: alias, fetcher, platform: "linux", arch: "x64", libc: "glibc" }),
		).rejects.toThrow("non-regular");
		await unchanged();
	});

	it.each(["mismatch", "duplicate", "wrong-name", "malformed"] as const)(
		"refuses %s checksum rows without touching either recovery image",
		async kind => {
			const hash = new Bun.CryptoHasher("sha256").update(BINARY).digest("hex");
			const row = `${hash}  npi-linux-x64\n`;
			const rows =
				kind === "mismatch"
					? `${"0".repeat(64)}  npi-linux-x64\n`
					: kind === "duplicate"
						? row + row
						: kind === "wrong-name"
							? `${hash}  npi-linux-arm64\n`
							: "not a checksum\n";
			const { release, fetcher } = fixture("npi-linux-x64", BINARY, rows);
			await expect(
				installRelease(release, { executablePath: target, fetcher, platform: "linux", arch: "x64", libc: "glibc" }),
			).rejects.toThrow();
			await unchanged();
			expect(await transactions()).toEqual([]);
		},
	);

	it.each([-1, 1])("rejects a streamed binary whose size differs from metadata by %s", async difference => {
		const { release, fetcher } = fixture();
		release.assets[0]!.size += difference;
		await expect(
			installRelease(release, { executablePath: target, fetcher, platform: "linux", arch: "x64", libc: "glibc" }),
		).rejects.toThrow("size");
		await unchanged();
	});

	it.each(["SHA256SUMS.txt", "npi-linux-x64"])("refuses HTTP errors fetching %s", async asset => {
		const test = fixture();
		const fetcher = (async (input, init) =>
			String(input).endsWith(`/${asset}`)
				? new Response("missing", { status: 404 })
				: test.fetcher(input, init)) as typeof fetch;
		await expect(
			installRelease(test.release, {
				executablePath: target,
				fetcher,
				platform: "linux",
				arch: "x64",
				libc: "glibc",
			}),
		).rejects.toThrow("HTTP 404");
		await unchanged();
	});

	it("rejects wrong-version startup before replacing current or previous", async () => {
		const { release, fetcher } = fixture("npi-linux-x64", "#!/bin/sh\nprintf '19.0.0\\n'\n");
		await expect(
			installRelease(release, { executablePath: target, fetcher, platform: "linux", arch: "x64", libc: "glibc" }),
		).rejects.toThrow("startup check failed");
		await unchanged();
	});

	it("rolls back if startup fails only after publishing", async () => {
		const binary = `#!/bin/sh\ncase "$0" in */staged) ;; *) exit 8 ;; esac\nprintf '${VERSION}\\n'\n`;
		const { release, fetcher } = fixture("npi-linux-x64", binary);
		await expect(
			installRelease(release, { executablePath: target, fetcher, platform: "linux", arch: "x64", libc: "glibc" }),
		).rejects.toThrow("startup check failed");
		await unchanged();
	});

	it.each(["stage", "move-current", "publish", "save-previous", "publish-previous"] as const)(
		"restores both images when Windows sequencing fails at %s",
		async step => {
			const { release, fetcher } = fixture("npi-windows-x64.exe");
			const rename = fs.rename;
			const link = fs.link;
			const renames: [string, string][] = [];
			let injected = false;
			spyOn(fs, "rename").mockImplementation(async (from, to) => {
				const source = String(from);
				const destination = String(to);
				renames.push([source, destination]);
				if (source === target && destination === `${target}.old`)
					expect(await Bun.file(`${target}.recover.ps1`).exists()).toBe(true);
				if (
					!injected &&
					((step === "stage" && destination === `${target}.new`) ||
						(step === "move-current" && source === target && destination === `${target}.old`) ||
						(step === "publish" && source === `${target}.new` && destination === target) ||
						(step === "save-previous" && source === `${target}.previous`))
				) {
					injected = true;
					throw failure(`injected ${step}`);
				}
				await rename(from, to);
			});
			spyOn(fs, "link").mockImplementation(async (from, to) => {
				if (
					!injected &&
					step === "publish-previous" &&
					String(from) === `${target}.old` &&
					String(to) === `${target}.previous`
				) {
					injected = true;
					throw failure(`injected ${step}`, "EIO");
				}
				await link(from, to);
			});
			await expect(
				installRelease(release, { executablePath: target, fetcher, platform: "win32", arch: "x64" }),
			).rejects.toThrow(`injected ${step}`);
			expect(injected).toBe(true);
			if (step === "publish") {
				const publication = renames.findIndex(([from, to]) => from === `${target}.new` && to === target);
				expect(renames[publication + 1]).toEqual([`${target}.old`, target]);
			}
			await unchanged();
			expect(await transactions()).toEqual([]);
		},
	);

	it.each(["linux", "win32"] as const)(
		"does not invent a previous image when the first %s installation rolls back",
		async platform => {
			await fs.unlink(`${target}.previous`);
			const { release, fetcher } = fixture(platform === "win32" ? "npi-windows-x64.exe" : "npi-linux-x64");
			await expect(
				installRelease(release, {
					executablePath: target,
					fetcher,
					platform,
					arch: "x64",
					libc: "glibc",
					onInstalled: async () => {
						throw new Error("first persistence failed");
					},
				}),
			).rejects.toThrow("first persistence failed");
			expect(await Bun.file(target).text()).toBe(ORIGINAL);
			expect(await Bun.file(`${target}.previous`).exists()).toBe(false);
			expect(await transactions()).toEqual([]);
		},
	);

	it.each(["linux", "win32"] as const)(
		"uses a real %s copy fallback when hard links are unavailable",
		async platform => {
			const { release, fetcher } = fixture(platform === "win32" ? "npi-windows-x64.exe" : "npi-linux-x64");
			spyOn(fs, "link").mockImplementation(async () => {
				throw failure("hard links unavailable");
			});
			await expect(
				installRelease(release, {
					executablePath: target,
					fetcher,
					platform,
					libc: "glibc",
					arch: "x64",
					onInstalled: async () => {
						throw new Error("copy-backed persistence failed");
					},
				}),
			).rejects.toThrow("copy-backed persistence failed");
			await unchanged();
			expect(await transactions()).toEqual([]);
		},
	);

	it.each(["linux", "win32"] as const)(
		"restores both images when %s state persistence fails after verified installation",
		async platform => {
			const { release, fetcher } = fixture(platform === "win32" ? "npi-windows-x64.exe" : "npi-linux-x64");
			let persisted = false;
			await expect(
				installRelease(release, {
					executablePath: target,
					fetcher,
					platform,
					arch: "x64",
					libc: "glibc",
					onInstalled: async result => {
						persisted = true;
						expect(await Bun.file(target).text()).toBe(BINARY);
						expect(await Bun.file(result.previousPath).text()).toBe(ORIGINAL);
						throw new Error("state persistence failed");
					},
				}),
			).rejects.toThrow("state persistence failed");
			expect(persisted).toBe(true);
			await unchanged();
		},
	);

	it("keeps the only old executable if Windows publication AND restoration fail, then recovers it under the next lock", async () => {
		const { release, fetcher } = fixture("npi-windows-x64.exe");
		const rename = fs.rename;
		const injection = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(to) === target && (String(from) === `${target}.new` || String(from) === `${target}.old`))
				throw failure("publication unavailable");
			await rename(from, to);
		});
		await expect(
			installRelease(release, { executablePath: target, fetcher, platform: "win32", arch: "x64" }),
		).rejects.toThrow("Recovery files:");
		expect(await Bun.file(target).exists()).toBe(false);
		const pending = await transactions();
		expect(pending).toHaveLength(1);
		expect(await Bun.file(`${target}.old`).text()).toBe(ORIGINAL);
		expect(await Bun.file(`${target}.previous`).text()).toBe(PREVIOUS);
		injection.mockRestore();
		await withUpdateLock(target, unchanged);
		expect(await transactions()).toEqual([]);
	});

	it("retains a cleanup journal while Windows still maps an old executable and retries deletion later", async () => {
		const { release, fetcher } = fixture("npi-windows-x64.exe");
		const rm = fs.rm;
		let mapped = true;
		spyOn(fs, "rm").mockImplementation(async (file, options) => {
			if (mapped && String(file).endsWith("/original")) throw failure("image still mapped");
			await rm(file, options);
		});
		await installRelease(release, { executablePath: target, fetcher, platform: "win32", arch: "x64" });
		expect(await transactions()).toHaveLength(1);
		const pending = (await transactions())[0]!;
		expect(await Bun.file(path.join(directory, pending, "manifest.json")).json()).toMatchObject({
			phase: "committed",
		});
		await withUpdateLock(target, async () => expect(await Bun.file(target).text()).toBe(BINARY));
		expect(await transactions()).toHaveLength(1);
		mapped = false;
		await withUpdateLock(target, async () => expect(await Bun.file(`${target}.previous`).text()).toBe(ORIGINAL));
		expect(await transactions()).toEqual([]);
		expect(await Bun.file(`${target}.old`).exists()).toBe(false);
	});

	it("does not replay a completed rollback from a partially cleaned transaction", async () => {
		const { release, fetcher } = fixture("npi-windows-x64.exe");
		const rm = fs.rm;
		const injection = spyOn(fs, "rm").mockImplementation(async (file, options) => {
			if (path.basename(String(file)).startsWith("discard-")) throw failure("cleanup denied");
			await rm(file, options);
		});
		await expect(
			installRelease(release, {
				executablePath: target,
				fetcher,
				platform: "win32",
				arch: "x64",
				onInstalled: async () => {
					throw new Error("persistence failed");
				},
			}),
		).rejects.toThrow("persistence failed");
		await unchanged();
		expect(await transactions()).toHaveLength(1);
		injection.mockRestore();
		await withUpdateLock(target, unchanged);
		expect(await transactions()).toEqual([]);
	});

	it.each(["promote", "committed"] as const)(
		"restores both images if the Windows %s journal cannot persist",
		async phase => {
			const { release, fetcher } = fixture("npi-windows-x64.exe");
			const rename = fs.rename;
			let injected = false;
			spyOn(fs, "rename").mockImplementation(async (from, to) => {
				if (!injected && path.basename(String(from)) === "manifest.tmp") {
					const journal = await Bun.file(String(from)).json();
					if (journal.phase === phase) {
						injected = true;
						throw failure(`cannot persist ${phase}`, "EIO");
					}
				}
				await rename(from, to);
			});
			await expect(
				installRelease(release, {
					executablePath: target,
					fetcher,
					platform: "win32",
					arch: "x64",
				}),
			).rejects.toThrow(`cannot persist ${phase}`);
			expect(injected).toBe(true);
			await unchanged();
			expect(await transactions()).toEqual([]);
		},
	);

	it("replays rollback when its final Windows checkpoint could not persist", async () => {
		const { release, fetcher } = fixture("npi-windows-x64.exe");
		const rename = fs.rename;
		const injection = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (path.basename(String(from)) === "manifest.tmp") {
				const journal = await Bun.file(String(from)).json();
				if (journal.phase === "rolled-back") throw failure("rollback checkpoint unavailable", "EIO");
			}
			await rename(from, to);
		});
		await expect(
			installRelease(release, {
				executablePath: target,
				fetcher,
				platform: "win32",
				arch: "x64",
				onInstalled: async () => {
					throw new Error("state persistence failed");
				},
			}),
		).rejects.toThrow("rollback checkpoint unavailable");
		await unchanged();
		expect(await transactions()).toHaveLength(1);
		injection.mockRestore();
		expect(await recoverPendingUpdate(target)).toHaveLength(1);
		await unchanged();
		expect(await transactions()).toEqual([]);
	});

	it("verifies the Windows download without moving current when its checksum is wrong", async () => {
		const { release, fetcher } = fixture("npi-windows-x64.exe", BINARY, `${"0".repeat(64)}  npi-windows-x64.exe\n`);
		const rename = fs.rename;
		let movedCurrent = false;
		spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(from) === target) movedCurrent = true;
			await rename(from, to);
		});
		await expect(
			installRelease(release, {
				executablePath: target,
				fetcher,
				platform: "win32",
				arch: "x64",
			}),
		).rejects.toThrow("SHA256");
		expect(movedCurrent).toBe(false);
		await unchanged();
		expect(await transactions()).toEqual([]);
	});

	it.each([".new", ".old"] as const)("never deletes an unowned adjacent %s image", async suffix => {
		const unrelated = `unrelated ${suffix}`;
		await Bun.write(`${target}${suffix}`, unrelated);
		const { release, fetcher } = fixture("npi-windows-x64.exe");
		await expect(
			installRelease(release, {
				executablePath: target,
				fetcher,
				platform: "win32",
				arch: "x64",
			}),
		).rejects.toThrow("Unowned");
		await unchanged();
		expect(await Bun.file(`${target}${suffix}`).text()).toBe(unrelated);
		expect(await transactions()).toEqual([]);
	});

	it("retires mapped cleanup images so a subsequent Windows update can use stable names", async () => {
		const { release, fetcher } = fixture("npi-windows-x64.exe");
		const rm = fs.rm;
		const injection = spyOn(fs, "rm").mockImplementation(async (file, options) => {
			if (String(file).endsWith("/original")) throw failure("old image still mapped");
			await rm(file, options);
		});
		await withUpdateLock(target, () =>
			installRelease(release, {
				executablePath: target,
				fetcher,
				platform: "win32",
				arch: "x64",
			}),
		);
		expect(await transactions()).toHaveLength(1);
		expect(await Bun.file(`${target}.old`).exists()).toBe(false);
		await withUpdateLock(target, () =>
			installRelease(release, {
				executablePath: target,
				fetcher,
				platform: "win32",
				arch: "x64",
			}),
		);
		expect(await Bun.file(target).text()).toBe(BINARY);
		expect(await Bun.file(`${target}.previous`).text()).toBe(BINARY);
		expect(await transactions()).toHaveLength(2);
		injection.mockRestore();
		expect(await recoverPendingUpdate(target)).toHaveLength(2);
		expect(await transactions()).toEqual([]);
	});

	const crashSteps = [
		"initializing",
		"partial-download",
		"staging",
		"replace-checkpoint",
		"new-ready",
		"old-moved",
		"published",
		"promote",
		"previous-saved",
		"previous-published",
		"callback",
		"committed",
		"cleanup-retired",
		"cleanup-detached",
		"rollback-current",
		"rollback-previous",
		"rollback-checkpoint",
	] as const;
	type CrashStep = (typeof crashSteps)[number];

	// The child terminates without running installer catch/finally handlers.
	// These real on-disk journal snapshots model each durable syscall boundary,
	// not Windows loader behavior. The helper runner never launches target.
	async function terminateAt(step: CrashStep): Promise<void> {
		const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
		const script = `
			import * as fs from "node:fs/promises";
			import * as path from "node:path";
			const target = ${JSON.stringify(target)};
			const step = ${JSON.stringify(step)};
			const tx = await fs.mkdtemp(target + ".update-transaction-");
			const journal = {
				version: 1, target, platform: "win32", phase: "staging", hadPrevious: true,
				windows: {
					sha256: ${JSON.stringify(hash(BINARY))},
					originalSha256: ${JSON.stringify(hash(ORIGINAL))},
					previousSha256: ${JSON.stringify(hash(PREVIOUS))}
				}
			};
			async function save() {
				const f = await fs.open(path.join(tx, "manifest.tmp"), "w");
				try { await f.writeFile(JSON.stringify(journal)); await f.sync(); }
				finally { await f.close(); }
				await fs.rename(path.join(tx, "manifest.tmp"), path.join(tx, "manifest.json"));
			}
			function crash(at) { if (step === at) process.exit(77); }
			await fs.mkdir(target + ".update-lock");
			await fs.writeFile(path.join(target + ".update-lock", process.pid + "-dead.owner"), "{}");
			crash("initializing");
			await save();
			if (step === "partial-download") {
				await fs.writeFile(path.join(tx, "staged"), "incomplete binary");
				process.exit(77);
			}
			await fs.writeFile(path.join(tx, "staged"), ${JSON.stringify(BINARY)});
			crash("staging");
			journal.phase = "replace"; await save(); crash("replace-checkpoint");
			await fs.rename(path.join(tx, "staged"), target + ".new"); crash("new-ready");
			await fs.rename(target, target + ".old"); crash("old-moved");
			await fs.rename(target + ".new", target); crash("published");
			journal.phase = "promote"; await save(); crash("promote");
			await fs.rename(target + ".previous", path.join(tx, "previous")); crash("previous-saved");
			await fs.copyFile(target + ".old", target + ".previous"); crash("previous-published");
			crash("callback");
			if (step.startsWith("rollback-")) {
				await fs.rename(target, path.join(tx, "discard-new"));
				await fs.rename(target + ".old", target); crash("rollback-current");
				await fs.unlink(target + ".previous");
				await fs.copyFile(path.join(tx, "previous"), target + ".previous"); crash("rollback-previous");
				journal.phase = "rolled-back"; await save(); crash("rollback-checkpoint");
			}
			journal.phase = "committed"; await save(); crash("committed");
			await fs.rename(target + ".old", path.join(tx, "original")); crash("cleanup-retired");
			journal.windows.detached = true; await save(); crash("cleanup-detached");
			throw new Error("unknown crash step");
		`;
		const child = Bun.spawn([process.execPath, "-e", script], {
			env: { ...process.env, BUN_BE_BUN: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = new Response(child.stderr).text();
		expect({ code: await child.exited, stderr: await stderr }).toEqual({ code: 77, stderr: "" });
	}

	function committedCrash(step: CrashStep): boolean {
		return step === "committed" || step.startsWith("cleanup-");
	}

	it.each([...crashSteps])(
		"recovers a terminated Windows transaction at %s without requiring target presence",
		async step => {
			await terminateAt(step);
			if (step === "old-moved") expect(await Bun.file(target).exists()).toBe(false);
			expect(await recoverPendingUpdate(target)).toHaveLength(1);
			expect(await Bun.file(target).text()).toBe(committedCrash(step) ? BINARY : ORIGINAL);
			expect(await Bun.file(`${target}.previous`).text()).toBe(committedCrash(step) ? ORIGINAL : PREVIOUS);
			expect(await Bun.file(`${target}.old`).exists()).toBe(false);
			expect(await Bun.file(`${target}.new`).exists()).toBe(false);
			expect(await transactions()).toEqual([]);
			expect(await recoverPendingUpdate(target)).toEqual([]);
		},
	);

	async function verifyIndependentHelper(step: CrashStep): Promise<void> {
		const helper = `${target}.recover.ps1`;
		const powershell = process.env.NPI_TEST_PWSH!;
		expect(path.isAbsolute(powershell)).toBe(true);
		const child = Bun.spawn([powershell, "-NoProfile", "-NonInteractive", "-File", helper], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = new Response(child.stdout).text();
		const errors = new Response(child.stderr).text();
		expect({ code: await child.exited, stderr: await errors }).toEqual({ code: 0, stderr: "" });
		expect(await output).toContain("Recovered Windows update journal");
		expect(await Bun.file(target).text()).toBe(committedCrash(step) ? BINARY : ORIGINAL);
		expect(await Bun.file(`${target}.previous`).text()).toBe(committedCrash(step) ? ORIGINAL : PREVIOUS);
		expect(await transactions()).toEqual([]);
		expect(await Bun.file(helper).exists()).toBe(true);
	}

	// These initialization snapshots precede the first executable move. The
	// independent script can also repair them when installed by an earlier update.
	// PowerShell 7 on Linux is not Windows PowerShell 5.1 or loader/share proof.
	it.skipIf(!process.env.NPI_TEST_PWSH).each(crashSteps.slice(0, 4))(
		"runs the independent helper against an initialization journal at %s",
		async step => {
			await terminateAt(step);
			await Bun.write(`${target}.recover.ps1`, WINDOWS_RECOVERY_HELPER);
			await verifyIndependentHelper(step);
		},
	);

	async function terminateInstallerAt(step: CrashStep): Promise<void> {
		const { release } = fixture("npi-windows-x64.exe");
		const installer = path.resolve(import.meta.dir, "../src/cli/update-install.ts");
		const scriptPath = path.join(directory, "terminate-installer.test.ts");
		await Bun.write(
			scriptPath,
			`
			import { test, spyOn } from "bun:test";
			import * as fs from "node:fs/promises";
			import * as path from "node:path";
			import { installRelease, withUpdateLock } from ${JSON.stringify(installer)};
			test("terminate the production installer", async () => {
				const target = ${JSON.stringify(target)};
				const step = ${JSON.stringify(step)};
				const release = ${JSON.stringify(release)};
				const binary = ${JSON.stringify(BINARY)};
				const hash = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
				const fetcher = async input => new Response(String(input).endsWith("/SHA256SUMS.txt")
					? hash + "  npi-windows-x64.exe\\n" : binary);
				const terminate = at => { if (step === at) process.kill(process.pid, "SIGKILL"); };
				const rename = fs.rename;
				spyOn(fs, "rename").mockImplementation(async (from, to) => {
					await rename(from, to);
					const source = String(from), destination = String(to);
					if (destination === target + ".new") terminate("new-ready");
					if (source === target && destination === target + ".old") terminate("old-moved");
					if (source === target + ".new" && destination === target) terminate("published");
					if (source === target + ".previous") terminate("previous-saved");
					if (source === target + ".old" && destination.endsWith("/original")) terminate("cleanup-retired");
					if (source === target + ".old" && destination === target) terminate("rollback-current");
					if (path.basename(source).startsWith("restore-") && destination === target + ".previous") terminate("rollback-previous");
					if (destination.endsWith("/manifest.json")) {
						const journal = JSON.parse(await fs.readFile(destination, "utf8"));
						if (journal.phase === "promote") terminate("promote");
						if (journal.phase === "committed") terminate(journal.windows?.detached ? "cleanup-detached" : "committed");
						if (journal.phase === "rolled-back") terminate("rollback-checkpoint");
					}
				});
				const link = fs.link;
				spyOn(fs, "link").mockImplementation(async (from, to) => {
					await link(from, to);
					if (String(from) === target + ".old" && String(to) === target + ".previous") terminate("previous-published");
				});
				await withUpdateLock(target, () => installRelease(release, {
					executablePath: target, fetcher, platform: "win32", arch: "x64",
					onInstalled: async () => {
						terminate("callback");
						if (step.startsWith("rollback-")) throw new Error("force production rollback before termination");
					},
				}));
				throw new Error("Requested termination boundary was not reached: " + step);
			});
		`,
		);
		const child = Bun.spawn([process.execPath, "test", scriptPath], {
			cwd: directory,
			env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, BUN_BE_BUN: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ code, signal: child.signalCode, stdout, stderr }).toMatchObject({ signal: "SIGKILL" });
	}

	// Unlike the projected replay snapshots above, these kill the real installer
	// after its actual syscalls. The helper must have been installed BEFORE death.
	it.skipIf(!process.env.NPI_TEST_PWSH).each(crashSteps.slice(4))(
		"runs the already-installed independent helper after killing the real installer at %s",
		async step => {
			await terminateInstallerAt(step);
			expect(await Bun.file(`${target}.recover.ps1`).exists()).toBe(true);
			if (step === "old-moved") expect(await Bun.file(target).exists()).toBe(false);
			await verifyIndependentHelper(step);
		},
	);

	it("rejects a concurrent updater, releases a failed action, and returns the action result", async () => {
		let secondRan = false;
		await expect(
			withUpdateLock(target, async () => {
				await expect(
					withUpdateLock(target, async () => {
						secondRan = true;
					}),
				).rejects.toThrow("Another updater");
				throw new Error("selection failed");
			}),
		).rejects.toThrow("selection failed");
		expect(secondRan).toBe(false);
		expect(await withUpdateLock(target, async () => 42)).toBe(42);
	});

	it("reclaims only a verifiably dead PID owner, not an incomplete lock", async () => {
		const child = Bun.spawn([process.execPath, "-e", ""], {
			env: { BUN_BE_BUN: "1" },
			stdout: "ignore",
			stderr: "ignore",
		});
		await child.exited;
		const lock = `${target}.update-lock`;
		await fs.mkdir(lock);
		await Bun.write(path.join(lock, `${child.pid}-${crypto.randomUUID()}.owner`), JSON.stringify({ pid: child.pid }));
		expect(await withUpdateLock(target, async () => "reclaimed")).toBe("reclaimed");
		await fs.mkdir(lock);
		await expect(withUpdateLock(target, async () => {})).rejects.toThrow("only after confirming");
		await fs.rmdir(lock);
		expect(await withUpdateLock(target, async () => "released")).toBe("released");
	});

	it.skipIf(process.platform !== "linux")("respects the source installer's destination proof hold", async () => {
		const hash = new Bun.CryptoHasher("sha256").update(target).digest("hex");
		const proof = path.join(process.env.XDG_RUNTIME_DIR || "/tmp", `npi-install-${hash}.lock`);
		await Bun.write(proof, `${Math.floor(Date.now() / 1000) + 60}\nfixture\ncanary proof\n`);
		let ran = false;
		await expect(
			withUpdateLock(target, async () => {
				ran = true;
			}),
		).rejects.toThrow("active proof hold");
		expect(ran).toBe(false);
		await Bun.write(proof, "0\n");
		expect(await withUpdateLock(target, async () => true)).toBe(true);
	});
});
