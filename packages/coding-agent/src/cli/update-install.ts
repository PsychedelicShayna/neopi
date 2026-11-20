// Recovery-route module: deliberately only built-ins and Bun; importing the normal
// environment/settings helpers here would also initialize the ordinary startup graph.
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WINDOWS_RECOVERY_HELPER } from "./update-recovery-helper";

export interface ReleaseAsset {
	name: string;
	browser_download_url: string;
	size: number;
}

export interface InstallRelease {
	tag_name: string;
	assets: ReleaseAsset[];
}

interface InstalledRelease {
	previousPath: string;
	sha256: string;
}

interface InstallOptions {
	executablePath?: string;
	fetcher?: typeof fetch;
	platform?: NodeJS.Platform;
	arch?: string;
	libc?: "glibc" | "musl";
	onInstalled?: (result: InstalledRelease) => Promise<void>;
}

interface Transaction {
	version: 1;
	target: string;
	platform: NodeJS.Platform;
	phase: "staging" | "replace" | "promote" | "committed" | "rolled-back";
	hadPrevious: boolean;
	windows?: { sha256: string; originalSha256: string; previousSha256?: string; detached?: boolean };
}

const ASSETS: Readonly<Record<string, string>> = {
	"darwin-x64": "npi-darwin-x64",
	"darwin-arm64": "npi-darwin-arm64",
	"linux-x64-glibc": "npi-linux-x64",
	"linux-arm64-glibc": "npi-linux-arm64",
	"linux-x64-musl": "npi-linux-musl-x64",
	"linux-arm64-musl": "npi-linux-musl-arm64",
	"win32-x64": "npi-windows-x64.exe",
	"win32-arm64": "npi-windows-arm64.exe",
};
const MAX_CHECKSUM_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 15_000;

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

async function regularFile(file: string): Promise<Stats | undefined> {
	try {
		const stat = await fs.lstat(file);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Updater refuses non-regular file: ${file}`);
		return stat;
	} catch (error) {
		if (hasCode(error, "ENOENT")) return undefined;
		throw error;
	}
}

async function canonicalTarget(requested: string): Promise<string> {
	if (!path.isAbsolute(requested)) throw new Error("Updater requires an absolute executable path");
	// Resolve directory aliases, never a final-component symlink that an installer
	// could redirect to a different executable between checking and publishing.
	const target = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
	await regularFile(target);
	return target;
}

function sameFile(before: Stats, after: Stats | undefined): boolean {
	return (
		after !== undefined &&
		before.dev === after.dev &&
		before.ino === after.ino &&
		before.size === after.size &&
		before.mtimeMs === after.mtimeMs
	);
}

async function nativeLibc(): Promise<"glibc" | "musl"> {
	// Bun implements process.report itself; no pi-natives loader or libc dlopen is
	// needed. Do not assume that an absent glibc field means musl.
	const report: unknown = process.report?.getReport();
	if (report && typeof report === "object") {
		if (
			"header" in report &&
			report.header &&
			typeof report.header === "object" &&
			"glibcVersionRuntime" in report.header &&
			typeof report.header.glibcVersionRuntime === "string" &&
			report.header.glibcVersionRuntime.length > 0
		)
			return "glibc";
		if (
			"sharedObjects" in report &&
			Array.isArray(report.sharedObjects) &&
			report.sharedObjects.some(item => typeof item === "string" && /(?:ld-musl-|libc\.musl-)/.test(item))
		)
			return "musl";
	}
	// Some Bun reports omit both fields. The kernel's own mapped-loader list is
	// preferable to spawning ldd (which can inspect/execute an unrelated binary).
	const maps = await Bun.file("/proc/self/maps").text();
	if (/(?:ld-musl-|libc\.musl-)/.test(maps)) return "musl";
	if (/(?:ld-linux[^/\s]*\.so|\/libc\.so\.6)/.test(maps)) return "glibc";
	throw new Error("Cannot determine this executable's libc; refusing to guess a Linux release asset");
}

async function platformAsset(options: InstallOptions): Promise<string> {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	if (!["linux", "darwin", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) {
		throw new Error(`Unsupported NeoPi update target: ${platform}-${arch}`);
	}
	const key =
		platform === "linux" ? `${platform}-${arch}-${options.libc ?? (await nativeLibc())}` : `${platform}-${arch}`;
	const name = ASSETS[key];
	if (!name) throw new Error(`Unsupported NeoPi update target: ${key}`);
	return name;
}

function releaseAsset(release: InstallRelease, name: string): ReleaseAsset {
	const matches = release.assets.filter(asset => asset.name === name);
	if (matches.length !== 1) throw new Error(`Release must contain exactly one ${name} asset`);
	const asset = matches[0]!;
	if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error(`Invalid release asset size: ${name}`);
	const url = new URL(asset.browser_download_url);
	const parts = url.pathname
		.split("/")
		.slice(1)
		.map(part => decodeURIComponent(part));
	if (
		url.protocol !== "https:" ||
		url.hostname !== "github.com" ||
		url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		parts.length !== 6 ||
		parts[0]?.toLowerCase() !== "psychedelicshayna" ||
		parts[1]?.toLowerCase() !== "neopi" ||
		parts[2] !== "releases" ||
		parts[3] !== "download" ||
		parts[4] !== release.tag_name ||
		parts[5] !== name
	) {
		throw new Error(`Refusing non-NeoPi GitHub release asset URL: ${name}`);
	}
	return asset;
}

async function fetchAsset(asset: ReleaseAsset, fetcher: typeof fetch): Promise<Response> {
	const response = await fetcher(asset.browser_download_url, { signal: AbortSignal.timeout(120_000) });
	if (response.status !== 200 || !response.body) {
		await response.body?.cancel();
		throw new Error(`Downloading ${asset.name} failed: HTTP ${response.status}`);
	}
	return response;
}

async function boundedText(stream: ReadableStream<Uint8Array>, limit: number): Promise<{ text: string; size: number }> {
	let size = 0;
	let text = "";
	const decoder = new TextDecoder();
	for await (const chunk of stream) {
		size += chunk.byteLength;
		if (size > limit) throw new Error(`Updater response exceeds ${limit} bytes`);
		text += decoder.decode(chunk, { stream: true });
	}
	return { text: text + decoder.decode(), size };
}

async function expectedHash(release: InstallRelease, binaryName: string, fetcher: typeof fetch): Promise<string> {
	const sums = releaseAsset(release, "SHA256SUMS.txt");
	if (sums.size > MAX_CHECKSUM_BYTES) throw new Error("Release checksum manifest is too large");
	const response = await fetchAsset(sums, fetcher);
	const { text, size } = await boundedText(response.body!, sums.size);
	if (size !== sums.size) throw new Error("Release checksum manifest size does not match release metadata");
	const matches: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line) continue;
		const match = /^([a-fA-F0-9]{64}) [ *]([^/\\\0]+)$/.exec(line);
		if (!match) throw new Error("Malformed SHA256SUMS.txt row");
		if (match[2] === binaryName) matches.push(match[1]!.toLowerCase());
	}
	if (matches.length !== 1) throw new Error(`SHA256SUMS.txt must contain exactly one row for ${binaryName}`);
	return matches[0]!;
}

async function downloadBinary(
	asset: ReleaseAsset,
	destination: string,
	sha256: string,
	fetcher: typeof fetch,
): Promise<void> {
	const file = await fs.open(destination, "wx", 0o700);
	try {
		const response = await fetchAsset(asset, fetcher);
		const hasher = new Bun.CryptoHasher("sha256");
		let size = 0;
		// This loop is intentional: hash and bound each network chunk while writing
		// it, without buffering a several-hundred-MB executable in memory.
		for await (const chunk of response.body!) {
			size += chunk.byteLength;
			if (size > asset.size) throw new Error(`Downloaded ${asset.name} exceeds its release asset size`);
			hasher.update(chunk);
			let offset = 0;
			while (offset < chunk.byteLength) {
				const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
				if (bytesWritten === 0) throw new Error(`Unable to finish writing ${asset.name}`);
				offset += bytesWritten;
			}
		}
		if (size !== asset.size) throw new Error(`Downloaded ${asset.name} size does not match release metadata`);
		if (hasher.digest("hex") !== sha256) throw new Error(`SHA256 mismatch for ${asset.name}`);
		await file.sync();
	} finally {
		await file.close();
	}
}

function baseVersion(value: string): string | undefined {
	return /^(?:npi[ /])?v?(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.+-]+)?$/.exec(value.trim())?.[1];
}

async function probeVersion(executable: string, release: InstallRelease, home: string): Promise<void> {
	const expected = baseVersion(release.tag_name);
	if (!expected) throw new Error(`Release tag has no supported version: ${release.tag_name}`);
	const child = Bun.spawn([executable, "--version"], {
		cwd: home,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
		// Deliberately do not inherit profiles, runtime injection, or user config.
		env: {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			WINDIR: process.env.WINDIR,
			HOME: home,
			USERPROFILE: home,
			APPDATA: home,
			LOCALAPPDATA: home,
			TMP: home,
			TEMP: home,
			TMPDIR: home,
			XDG_CONFIG_HOME: home,
			XDG_CACHE_HOME: home,
			XDG_DATA_HOME: home,
			XDG_STATE_HOME: home,
			PI_CONFIG_DIR: ".omp",
			PI_CODING_AGENT_DIR: path.join(home, "agent"),
			NO_COLOR: "1",
		},
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, PROBE_TIMEOUT_MS);
	try {
		const [exitCode, output] = await Promise.all([child.exited, boundedText(child.stdout, 4096)]);
		if (timedOut || exitCode !== 0 || baseVersion(output.text) !== expected) {
			throw new Error(`NeoPi --version startup check failed for ${executable}${timedOut ? " (timed out)" : ""}`);
		}
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
}

async function saveTransaction(directory: string, transaction: Transaction): Promise<void> {
	const temporary = path.join(directory, "manifest.tmp");
	const file = await fs.open(temporary, "w", 0o600);
	try {
		await file.writeFile(JSON.stringify(transaction));
		await file.sync();
	} finally {
		await file.close();
	}
	await fs.rename(temporary, path.join(directory, "manifest.json"));
}

async function fileHash(file: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

async function verifiedImage(file: string, sha256: string): Promise<boolean> {
	return (await regularFile(file)) !== undefined && (await fileHash(file)) === sha256;
}

async function cleanupWindowsTransaction(directory: string, transaction: Transaction): Promise<void> {
	if (transaction.phase === "rolled-back" || transaction.windows!.detached) {
		await cleanupTransaction(directory);
		return;
	}
	// Free the stable name even when Windows still maps this old image. The
	// cleanup journal owns the retired file until a later launch can delete it.
	const old = `${transaction.target}.old`;
	const retired = path.join(directory, "original");
	if (!(await regularFile(retired)) && (await regularFile(old))) {
		if (!(await verifiedImage(old, transaction.windows!.originalSha256)))
			throw new Error(`Recovery image changed; retain ${old}`);
		await fs.rename(old, retired);
	}
	// Older cleanup journals must never touch a later swap's stable names.
	const detached = { ...transaction, windows: { ...transaction.windows!, detached: true } };
	await saveTransaction(directory, detached);
	transaction.windows = detached.windows;
	await cleanupTransaction(directory);
}

async function restoreWindowsTransaction(directory: string, transaction: Transaction): Promise<void> {
	const windows = transaction.windows!;
	const target = transaction.target;
	const old = `${target}.old`;
	if (transaction.phase === "staging") {
		await cleanupTransaction(directory);
		return;
	}
	if (transaction.phase === "committed" || transaction.phase === "rolled-back") {
		try {
			await cleanupWindowsTransaction(directory, transaction);
		} catch {}
		return;
	}
	if (await verifiedImage(old, windows.originalSha256)) {
		if (await regularFile(target)) {
			if (!(await verifiedImage(target, windows.sha256)) && !(await verifiedImage(target, windows.originalSha256)))
				throw new Error(`Refusing to replace changed executable: ${target}`);
			await fs.rename(target, path.join(directory, `discard-${crypto.randomUUID()}`));
		}
		// Replay restores the stable old generation without consuming a copy.
		await fs.rename(old, target);
	} else if ((await regularFile(old)) || !(await verifiedImage(target, windows.originalSha256))) {
		throw new Error(`No verified original executable; run recovery helper ${target}.recover.ps1`);
	}
	const previous = `${target}.previous`;
	const saved = path.join(directory, "previous");
	if (await regularFile(saved)) {
		if (!windows.previousSha256 || !(await verifiedImage(saved, windows.previousSha256)))
			throw new Error(`Previous recovery image changed; retain ${directory}`);
		if (await regularFile(previous))
			await fs.rename(previous, path.join(directory, `discard-${crypto.randomUUID()}`));
		// Copy/link rather than consume the recovery image: replay remains
		// safe if journal persistence fails immediately after restoration.
		await publishRecovery(saved, previous, directory, "win32");
	} else if (!transaction.hadPrevious && (await regularFile(previous))) {
		if (!(await verifiedImage(previous, windows.originalSha256)))
			throw new Error(`Previous image changed; retain ${previous}`);
		await fs.rename(previous, path.join(directory, `discard-${crypto.randomUUID()}`));
	}
	const staged = `${target}.new`;
	if (await regularFile(staged)) {
		if (!(await verifiedImage(staged, windows.sha256)))
			throw new Error(`Unverified staged image; retain ${staged} and ${directory}`);
		await fs.rename(staged, path.join(directory, "staged-leftover"));
	}
	await saveTransaction(directory, { ...transaction, phase: "rolled-back" });
	transaction.phase = "rolled-back";
	await cleanupWindowsTransaction(directory, transaction);
}

async function cleanupTransaction(directory: string): Promise<void> {
	try {
		// Keep the cleanup-only journal until every possibly mapped executable is
		// gone. Recursive rm can delete the manifest first, then fail on Windows.
		for (const entry of await fs.readdir(directory)) {
			if (entry !== "manifest.json") await fs.rm(path.join(directory, entry), { recursive: true, force: true });
		}
		await fs.rm(path.join(directory, "manifest.json"), { force: true });
		await fs.rmdir(directory);
	} catch {
		// Cleanup is best-effort, never an installation failure after committing.
		// Windows may still map an old executable; retry on the next update.
	}
}

async function linkRecovery(source: string, destination: string): Promise<void> {
	try {
		await fs.link(source, destination);
	} catch (error) {
		if (!["EXDEV", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"].some(code => hasCode(error, code))) throw error;
		// Hard links are unavailable on some Windows/removable filesystems. Only
		// then pay for a copy; never overwrite an existing recovery image.
		await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
	}
}

async function publishRecovery(
	source: string,
	target: string,
	directory: string,
	platform: NodeJS.Platform,
): Promise<void> {
	const pending = path.join(directory, `restore-${crypto.randomUUID()}`);
	await linkRecovery(source, pending);
	if (platform === "win32" && (await regularFile(target))) {
		await fs.rename(target, path.join(directory, `discard-${crypto.randomUUID()}`));
	}
	await fs.rename(pending, target);
}

async function restoreTransaction(directory: string, transaction: Transaction): Promise<void> {
	if (transaction.windows) {
		await restoreWindowsTransaction(directory, transaction);
		return;
	}
	const target = transaction.target;
	const original = path.join(directory, "original");
	const previous = `${target}.previous`;
	const savedPrevious = path.join(directory, "previous");
	if (transaction.phase === "staging" || transaction.phase === "committed") {
		await cleanupTransaction(directory);
		return;
	}
	if (await regularFile(original)) {
		// Recovery originals remain immutable until restoration AND its journal
		// update succeed. A second interruption can replay these steps safely.
		await publishRecovery(original, target, directory, transaction.platform);
	} else if (transaction.phase === "promote" || !(await regularFile(target))) {
		throw new Error(`Interrupted update has no executable to restore; retain recovery directory ${directory}`);
	}
	if (await regularFile(savedPrevious)) {
		await publishRecovery(savedPrevious, previous, directory, transaction.platform);
	} else if (!transaction.hadPrevious && (await regularFile(previous))) {
		await fs.rename(previous, path.join(directory, `discard-${crypto.randomUUID()}`));
	}
	// Persist a cleanup-only state before deleting anything. A partial rm must
	// never cause a later invocation to mistake an older .previous for current.
	await saveTransaction(directory, { ...transaction, phase: "staging" });
	transaction.phase = "staging";
	await cleanupTransaction(directory);
}

async function recoverTransactions(target: string): Promise<string[]> {
	const messages: string[] = [];
	const parent = path.dirname(target);
	const prefix = `${path.basename(target)}.update-transaction-`;
	for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
		if (!entry.name.startsWith(prefix)) continue;
		const directory = path.join(parent, entry.name);
		if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unsafe updater recovery path: ${directory}`);
		const manifest = path.join(directory, "manifest.json");
		if (!(await regularFile(manifest))) {
			// Initial manifest creation precedes all downloads and executable moves.
			// Only an empty/initializing directory is safe to discard without it.
			const files = await fs.readdir(directory);
			if (files.some(file => file !== "manifest.tmp"))
				throw new Error(`Missing updater recovery manifest; retain ${directory}`);
			await cleanupTransaction(directory);
			messages.push(`Recovered interrupted update initialization at ${target}.`);
			continue;
		}
		const transaction: unknown = await Bun.file(manifest).json();
		if (
			!transaction ||
			typeof transaction !== "object" ||
			!("version" in transaction) ||
			transaction.version !== 1 ||
			!("target" in transaction) ||
			transaction.target !== target ||
			!("phase" in transaction) ||
			!["staging", "replace", "promote", "committed", "rolled-back"].includes(String(transaction.phase)) ||
			!("platform" in transaction) ||
			!["linux", "darwin", "win32"].includes(String(transaction.platform)) ||
			!("hadPrevious" in transaction) ||
			typeof transaction.hadPrevious !== "boolean"
		) {
			throw new Error(`Invalid updater recovery manifest; retain ${directory}`);
		}
		const windows = (transaction as Transaction).windows;
		if (
			windows &&
			((transaction as Transaction).platform !== "win32" ||
				!/^[a-f0-9]{64}$/.test(windows.sha256) ||
				!/^[a-f0-9]{64}$/.test(windows.originalSha256) ||
				((transaction as Transaction).hadPrevious && !/^[a-f0-9]{64}$/.test(windows.previousSha256 ?? "")) ||
				(windows.detached !== undefined && typeof windows.detached !== "boolean"))
		)
			throw new Error(`Invalid Windows recovery manifest; retain ${directory}`);
		const interruptedPhase = (transaction as Transaction).phase;
		await restoreTransaction(directory, transaction as Transaction);
		messages.push(
			`Recovered interrupted update journal (${interruptedPhase}) at ${target}; retained cleanup is retried on later launches.`,
		);
	}
	return messages;
}

async function claimUpdateLock(target: string): Promise<() => Promise<void>> {
	const directory = `${target}.update-lock`;
	for (;;) {
		try {
			await fs.mkdir(directory, { mode: 0o700 });
			break;
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
		}
		const stat = await fs.lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe updater lock: ${directory}`);
		const entries = await fs.readdir(directory);
		const owner = entries.length === 1 ? /^(\d+)-[a-f0-9-]+\.owner$/.exec(entries[0]!) : null;
		// Never infer staleness from age. PID reuse/EPERM means busy. An empty or
		// malformed lock (e.g. death between mkdir and owner creation) needs manual
		// removal only after confirming no updater is running; guessing is unsafe.
		if (!owner)
			throw new Error(`Incomplete updater lock ${directory}; remove it only after confirming no updater is running`);
		const pid = Number(owner[1]);
		if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid updater lock owner: ${directory}`);
		try {
			process.kill(pid, 0);
			throw new Error(`Another updater (PID ${pid}) owns ${directory}`);
		} catch (error) {
			if (!hasCode(error, "ESRCH")) throw error;
		}
		// Delete the exact unique dead-owner marker, not a reusable owner.json.
		// Only its successful remover may rmdir; competing reclaimers cannot
		// accidentally erase a newly acquired lock's different owner marker.
		try {
			await fs.unlink(path.join(directory, entries[0]!));
			await fs.rmdir(directory);
		} catch (error) {
			if (!hasCode(error, "ENOENT")) throw error;
			throw new Error(`Updater lock changed while reclaiming it; retry: ${directory}`, { cause: error });
		}
	}
	const owner = path.join(directory, `${process.pid}-${crypto.randomUUID()}.owner`);
	try {
		const file = await fs.open(owner, "wx", 0o600);
		try {
			await file.writeFile(JSON.stringify({ pid: process.pid }));
		} finally {
			await file.close();
		}
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true });
		throw error;
	}
	return async () => {
		await fs.unlink(owner);
		await fs.rmdir(directory);
	};
}

async function destinationProofLock(target: string): Promise<() => Promise<void>> {
	if (process.platform !== "linux") return async () => {};
	// This is the exact destination hash and file used by scripts/install-lock.sh.
	// A native-free flock subprocess holds the advisory lock through action(),
	// excluding root/source installers and respecting their expiring proof holds.
	const hash = new Bun.CryptoHasher("sha256").update(target).digest("hex");
	const lock = path.join(process.env.XDG_RUNTIME_DIR || "/tmp", `npi-install-${hash}.lock`);
	const file = await fs.open(lock, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new Error(`Unsafe install proof lock: ${lock}`);
	} finally {
		await file.close();
	}
	const child = Bun.spawn(
		[
			"flock",
			"--nonblock",
			"--no-fork",
			lock,
			process.execPath,
			"-e",
			"process.stdout.write('locked\\n'); process.stdin.resume();",
		],
		{
			env: { PATH: process.env.PATH, BUN_BE_BUN: "1" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		},
	);
	const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
	try {
		const reader = child.stdout.getReader();
		try {
			let ready = "";
			while (!ready.endsWith("\n") && ready.length < 64) {
				const chunk = await reader.read();
				if (chunk.done) break;
				ready += new TextDecoder().decode(chunk.value);
			}
			if (ready !== "locked\n") throw new Error(`Install destination is busy or flock is unavailable: ${target}`);
		} finally {
			reader.releaseLock();
		}
		const record = await boundedText(Bun.file(lock).stream(), 4096);
		const expiry = record.text.split("\n", 1)[0] ?? "";
		if (expiry && !/^\d{1,12}$/.test(expiry))
			throw new Error(`Invalid install proof hold; release it explicitly: ${lock}`);
		if (Number(expiry) > Date.now() / 1000) throw new Error(`Install destination has an active proof hold: ${lock}`);
	} catch (error) {
		child.kill("SIGKILL");
		await child.exited;
		throw error;
	} finally {
		clearTimeout(timer);
	}
	return async () => {
		await child.stdin.end();
		await child.exited;
	};
}

/** Lightweight recovery entry: target may be missing between Windows renames. */
export async function recoverPendingUpdate(executablePath = process.execPath): Promise<string[]> {
	const target = await canonicalTarget(executablePath);
	const prefix = `${path.basename(target)}.update-transaction-`;
	if (!(await fs.readdir(path.dirname(target))).some(entry => entry.startsWith(prefix))) return [];
	let messages: string[] = [];
	await withUpdateLock(
		target,
		async () => {},
		recovered => {
			messages = recovered;
		},
	);
	return messages;
}

/** The caller keeps release/state selection and persistence inside this lock. */
export async function withUpdateLock<T>(
	executablePath: string,
	action: () => Promise<T>,
	onRecovered?: (messages: string[]) => void,
): Promise<T> {
	const target = await canonicalTarget(executablePath);
	const releaseDirectoryLock = await claimUpdateLock(target);
	try {
		const releaseProofLock = await destinationProofLock(target);
		try {
			const recovered = await recoverTransactions(target);
			onRecovered?.(recovered);
			return await action();
		} finally {
			await releaseProofLock();
		}
	} finally {
		await releaseDirectoryLock();
	}
}

/** Called inside withUpdateLock, including the caller's onInstalled state commit. */
export async function installRelease(release: InstallRelease, options: InstallOptions = {}): Promise<InstalledRelease> {
	const name = await platformAsset(options);
	if (options.executablePath === undefined) {
		// Unlike PI_COMPILED, Bun's embedded path cannot be enabled by a source
		// caller's environment. Do not ever replace the Bun interpreter itself.
		if (!/(?:\$bunfs|~BUN|%7EBUN)/.test(Bun.main))
			throw new Error("Self-update requires a compiled npi executable, not Bun source");
	}
	const target = await canonicalTarget(options.executablePath ?? process.execPath);
	if (options.executablePath === undefined && !/^npi(?:\.exe)?$/i.test(path.basename(target))) {
		throw new Error(`Refusing to self-update an executable not named npi: ${target}`);
	}
	await recoverTransactions(target);
	const originalStat = await regularFile(target);
	if (!originalStat) throw new Error(`Installed executable does not exist: ${target}`);
	const previousPath = `${target}.previous`;
	const previousStat = await regularFile(previousPath);
	const binary = releaseAsset(release, name);
	const fetcher = options.fetcher ?? fetch;
	const sha256 = await expectedHash(release, name, fetcher);
	const directory = await fs.mkdtemp(`${target}.update-transaction-`);
	const transaction: Transaction = {
		version: 1,
		target,
		platform: options.platform ?? process.platform,
		phase: "staging",
		hadPrevious: previousStat !== undefined,
		...(options.platform === "win32" || (options.platform === undefined && process.platform === "win32")
			? {
					windows: {
						sha256,
						originalSha256: await fileHash(target),
						...(previousStat ? { previousSha256: await fileHash(previousPath) } : {}),
					},
				}
			: {}),
	};
	try {
		await saveTransaction(directory, transaction);
		if (transaction.windows) {
			// Created once and never replaced by an executable swap.
			const helperPath = `${target}.recover.ps1`;
			if (await regularFile(helperPath)) {
				if ((await Bun.file(helperPath).text()) !== WINDOWS_RECOVERY_HELPER)
					throw new Error(`Refusing to overwrite independent recovery helper: ${helperPath}`);
			} else {
				const temporaryHelper = path.join(directory, "recover.ps1");
				const helper = await fs.open(temporaryHelper, "wx", 0o700);
				try {
					await helper.writeFile(WINDOWS_RECOVERY_HELPER);
					await helper.sync();
				} finally {
					await helper.close();
				}
				await fs.rename(temporaryHelper, helperPath);
			}
			for (const file of [`${target}.new`, `${target}.old`]) {
				if (await regularFile(file)) throw new Error(`Unowned Windows update image; retain ${file}`);
			}
		}
		const staged = path.join(directory, transaction.windows ? "staged.exe" : "staged");
		await downloadBinary(binary, staged, sha256, fetcher);
		await fs.chmod(staged, originalStat.mode & 0o777);
		const home = path.join(directory, "home");
		await fs.mkdir(home, { mode: 0o700 });
		await probeVersion(staged, release, home);
		if (
			(await canonicalTarget(target)) !== target ||
			!sameFile(originalStat, await regularFile(target)) ||
			(previousStat
				? !sameFile(previousStat, await regularFile(previousPath))
				: (await regularFile(previousPath)) !== undefined)
		) {
			throw new Error("Installed executable or previous image changed during download; refusing replacement");
		}
		await saveTransaction(directory, { ...transaction, phase: "replace" });
		transaction.phase = "replace";
		const original = transaction.windows ? `${target}.old` : path.join(directory, "original");
		if (transaction.windows) {
			await fs.rename(staged, `${target}.new`);
			if (!(await verifiedImage(`${target}.new`, sha256))) throw new Error("Staged Windows SHA256 changed");
			await fs.rename(target, original);
			try {
				await fs.rename(`${target}.new`, target);
			} catch (error) {
				// Required immediate rename-back, before general journal replay.
				await fs.rename(original, target);
				throw error;
			}
		} else {
			// A hard link preserves the executing inode without copying the binary.
			await linkRecovery(target, original);
			await fs.rename(staged, target);
		}
		await probeVersion(target, release, home);
		await saveTransaction(directory, { ...transaction, phase: "promote" });
		transaction.phase = "promote";
		if (previousStat) await fs.rename(previousPath, path.join(directory, "previous"));
		await linkRecovery(original, previousPath);
		const result = { previousPath, sha256 };
		await options.onInstalled?.(result);
		await saveTransaction(directory, { ...transaction, phase: "committed" });
		transaction.phase = "committed";
		// Mapped old images keep their cleanup journal, not a failed install.
		if (transaction.windows) {
			try {
				await cleanupWindowsTransaction(directory, transaction);
			} catch {}
		} else await cleanupTransaction(directory);
		return result;
	} catch (error) {
		// The in-memory phase also covers a failed journal write before a move.
		// Never clean up on rollback failure: show the surviving recovery path.
		try {
			await restoreTransaction(directory, transaction);
		} catch (rollbackError) {
			throw new Error(
				`Update failed (${String(error)}); rollback failed (${String(rollbackError)}). Recovery files: ${directory}.${transaction.windows ? ` Run PowerShell helper ${target}.recover.ps1; if target is absent, manually rename ${target}.old back to ${target}.` : ""}`,
				{ cause: error },
			);
		}
		throw error;
	}
}
