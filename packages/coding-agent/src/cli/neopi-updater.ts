import { readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { normalizeProfileName, resolveProfileEnv, setProfile } from "@oh-my-pi/pi-utils/dirs";
import {
	defaultUpdateChannel,
	getAgentDir,
	persistUpdateChannel,
	readUpdatePreferences,
	VERSION,
} from "./update-config";
import { installRelease, recoverPendingUpdate, type ReleaseAsset, withUpdateLock } from "./update-install";

export type UpdateChannel = "stable" | "nightly";
export type UpdateMode = "off" | "notify" | "auto";
/** First upstream version carrying this fork's recovery command. */
export const FIRST_UPDATER_VERSION = "18.18.8";
// Earlier fork builds share the same upstream version; their source ancestry
// must also include the first signed implementation, not merely match semver.
const FIRST_UPDATER_SOURCE_COMMIT = "d2774cb85c99459da0cf4d33a5fc9ccc40e9ea88";
const RELEASES_URL = "https://api.github.com/repos/PsychedelicShayna/neopi/releases";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface Release {
	id: number;
	tag_name: string;
	target_commitish: string;
	prerelease: boolean;
	draft: boolean;
	published_at: string;
	assets: ReleaseAsset[];
}
interface InstalledRelease {
	id: number;
	tag: string;
	channel: UpdateChannel;
	publishedAt: string;
	sha256: string;
	size: number;
	mtimeMs: number;
}
interface UpdateState {
	version: 1;
	installed?: InstalledRelease;
	/** Machine binary hold, not a profile preference. All profiles must honor it. */
	hold?: { agentDir: string; channel: UpdateChannel };
	lastCheck?: { at: number; channel: UpdateChannel };
	/** One bounded checkpoint reconciles a state commit interrupted before binary commit. */
	recovery?: Pick<UpdateState, "installed" | "hold"> & {
		sha256: string;
		size: number;
		mtimeMs: number;
		dev: number;
		ino: number;
	};
}
/** Internal adapters exercise the real updater interface without touching the running installation. */
export interface UpdateOptions {
	executablePath?: string;
	agentDir?: string;
	fetcher?: typeof fetch;
	version?: string;
	gitSha?: string;
	confirmLegacy?: (message: string) => Promise<boolean>;
	print?: (message: string) => void;
}

function releaseChannel(release: Release): UpdateChannel {
	return release.prerelease ? "nightly" : "stable";
}
function releaseVersion(tag: string): string {
	const version = /^v?(\d+\.\d+\.\d+)(?:[-+].*)?$/.exec(tag)?.[1];
	if (!version) throw new Error(`Unrecognized NeoPi release version: ${tag}`);
	return version;
}
async function predatesUpdater(release: Release, fetcher: typeof fetch): Promise<boolean> {
	const order = Bun.semver.order(releaseVersion(release.tag_name), FIRST_UPDATER_VERSION);
	if (order !== 0) return order < 0;
	try {
		const response = await fetcher(
			`https://api.github.com/repos/PsychedelicShayna/neopi/compare/${FIRST_UPDATER_SOURCE_COMMIT}...${encodeURIComponent(release.tag_name)}`,
			{ headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) },
		);
		if (!response.ok) return true;
		const comparison = (await response.json()) as { status?: string };
		return comparison.status !== "ahead" && comparison.status !== "identical";
	} catch {
		// An unavailable ancestry proof must never authorize an automatic
		// capability-losing replacement. Explicit installs can acknowledge it.
		return true;
	}
}

function isCompiledDestination(executable: string): boolean {
	return (
		process.env.PI_COMPILED === "true" &&
		/(?:\$bunfs|~BUN|%7EBUN)/.test(import.meta.url) &&
		/^npi(?:\.exe)?$/i.test(basename(executable))
	);
}

async function executableHash(executable: string): Promise<string> {
	const hash = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(executable).stream()) hash.update(chunk);
	return hash.digest("hex");
}

async function readState(executable: string): Promise<UpdateState> {
	try {
		const value = JSON.parse(await readFile(`${executable}.update.json`, "utf8")) as UpdateState;
		if (
			value.version !== 1 ||
			(value.hold &&
				(typeof value.hold.agentDir !== "string" || !["stable", "nightly"].includes(value.hold.channel)))
		) {
			throw new Error("Unsupported updater state; preserve this file before repairing it.");
		}
		if (value.recovery) {
			const image = await stat(executable);
			const old = value.recovery;
			const sameOriginal =
				image.size === old.size && image.mtimeMs === old.mtimeMs && image.dev === old.dev && image.ino === old.ino;
			const sameInstalled =
				value.installed && image.size === value.installed.size && image.mtimeMs === value.installed.mtimeMs;
			const restoredCopy =
				!sameInstalled &&
				image.size === old.size &&
				typeof old.sha256 === "string" &&
				(await executableHash(executable)) === old.sha256;
			if (sameOriginal || restoredCopy) {
				// Recovery may copy when hard links are unavailable. Its bytes still
				// identify the old cursor, but the copied file has new stat metadata.
				const installed = old.installed && { ...old.installed, size: image.size, mtimeMs: image.mtimeMs };
				return { ...value, installed, hold: old.hold, recovery: undefined };
			}
		}
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
		throw new Error(`Cannot read ${executable}.update.json: ${String(error)}`);
	}
}
async function saveState(executable: string, state: UpdateState): Promise<void> {
	const temporary = `${executable}.update-${process.pid}-${crypto.randomUUID()}.json`;
	try {
		await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		await rename(temporary, `${executable}.update.json`);
	} finally {
		await unlink(temporary).catch(error => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
	}
}
async function currentRelease(executable: string, state: UpdateState): Promise<InstalledRelease | undefined> {
	if (!state.installed) return undefined;
	const current = await stat(executable);
	return current.size === state.installed.size && current.mtimeMs === state.installed.mtimeMs
		? state.installed
		: undefined;
}

async function releases(fetcher: typeof fetch): Promise<Release[]> {
	const result: Release[] = [];
	for (let page = 1; ; page++) {
		const response = await fetcher(`${RELEASES_URL}?per_page=100&page=${page}`, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": `npi/${VERSION}` },
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`NeoPi GitHub release request failed: HTTP ${response.status}`);
		const data: unknown = await response.json();
		if (!Array.isArray(data)) throw new Error("Invalid NeoPi GitHub release response.");
		for (const raw of data) {
			const release = raw as Release;
			if (release.draft || !release.published_at) continue;
			if (
				!Number.isSafeInteger(release.id) ||
				typeof release.tag_name !== "string" ||
				typeof release.prerelease !== "boolean" ||
				!Number.isFinite(Date.parse(release.published_at)) ||
				!Array.isArray(release.assets)
			) {
				throw new Error("Invalid NeoPi release identity.");
			}
			releaseVersion(release.tag_name);
			for (const asset of release.assets) {
				const url = new URL(asset.browser_download_url);
				const segments = url.pathname.split("/");
				if (
					url.protocol !== "https:" ||
					url.hostname !== "github.com" ||
					url.username ||
					url.password ||
					segments.slice(0, 5).join("/") !== "/PsychedelicShayna/neopi/releases/download" ||
					decodeURIComponent(segments[5] ?? "") !== release.tag_name ||
					decodeURIComponent(segments[6] ?? "") !== asset.name ||
					segments.length !== 7
				) {
					throw new Error(`Release asset is outside its NeoPi GitHub release: ${asset.name}`);
				}
			}
			result.push(release);
		}
		if (data.length < 100) break;
	}
	const ids = new Set<number>();
	for (const release of result) {
		if (ids.has(release.id)) throw new Error(`Duplicate NeoPi release identity: ${release.id}`);
		ids.add(release.id);
	}
	// GitHub's array is creation-ordered, which is not publication order.
	return result.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || b.id - a.id);
}

async function newerThanLocal(target: Release, options: UpdateOptions): Promise<boolean> {
	const order = Bun.semver.order(releaseVersion(target.tag_name), options.version ?? VERSION);
	if (order !== 0) return order > 0;
	const sha = options.gitSha ?? process.env.PI_BUILD_GIT_SHA;
	if (!sha || !/^[a-f0-9]{40}$/i.test(sha)) return false;
	// Same-semver nightlies are distinct builds. Compare immutable Git identities,
	// not the publication date against a guessed local build date.
	const response = await (options.fetcher ?? fetch)(
		`https://api.github.com/repos/PsychedelicShayna/neopi/compare/${sha}...${encodeURIComponent(target.tag_name)}`,
		{ headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) },
	);
	if (!response.ok) return false;
	const comparison = (await response.json()) as { status?: string };
	return comparison.status === "ahead";
}

async function confirmLegacy(message: string): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error(`${message}\nRun this command in an interactive terminal to confirm; nothing was replaced.`);
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return (await prompt.question(`${message}\nType INSTALL LEGACY to continue: `)).trim() === "INSTALL LEGACY";
	} finally {
		prompt.close();
	}
}

async function applyRelease(
	executable: string,
	target: Release,
	state: UpdateState,
	options: UpdateOptions,
	hold: boolean,
	preference: UpdateChannel,
	switchChannel?: UpdateChannel,
): Promise<void> {
	const before = await stat(executable);
	const beforeInstalled = await currentRelease(executable, state);
	const beforeHash = beforeInstalled?.sha256 ?? (await executableHash(executable));
	await installRelease(target, {
		executablePath: executable,
		fetcher: options.fetcher,
		onInstalled: async result => {
			const info = await stat(executable);
			const next: UpdateState = {
				...state,
				installed: {
					id: target.id,
					tag: target.tag_name,
					channel: releaseChannel(target),
					publishedAt: target.published_at,
					sha256: result.sha256,
					size: info.size,
					mtimeMs: info.mtimeMs,
				},
				hold: hold ? { agentDir: options.agentDir ?? getAgentDir(), channel: preference } : undefined,
				recovery: {
					installed: beforeInstalled,
					hold: state.hold,
					sha256: beforeHash,
					size: before.size,
					mtimeMs: before.mtimeMs,
					dev: before.dev,
					ino: before.ino,
				},
			};
			if (switchChannel)
				await persistUpdateChannel(switchChannel, options.agentDir, () => saveState(executable, next));
			else await saveState(executable, next);
		},
	});
}

/** Only the hold owner's explicit config change releases a persisted hold on next launch. */
async function reconcileHold(
	executable: string,
	state: UpdateState,
	channel: UpdateChannel,
	agentDir: string,
): Promise<void> {
	if (state.hold && state.hold.agentDir === agentDir && state.hold.channel !== channel) {
		delete state.hold;
		await saveState(executable, state);
	}
}

function profileArguments(argv: readonly string[]): string[] {
	const args: string[] = [];
	let profile: string | undefined;
	let explicit = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--profile" || arg.startsWith("--profile=")) {
			const value = arg === "--profile" ? argv[++i] : arg.slice("--profile=".length);
			if (!value || value.startsWith("--")) throw new Error("--profile requires a profile name.");
			profile = normalizeProfileName(value);
			explicit = true;
		} else args.push(arg);
	}
	setProfile(
		explicit ? profile : resolveProfileEnv(process.env.OMP_PROFILE, process.env.PI_PROFILE),
		explicit ? "explicit" : "environment",
	);
	return args;
}

const HELP =
	"NeoPi binary updates (PsychedelicShayna/neopi GitHub releases only)\n" +
	"  npi update                    Status, channel and rollback hold (offline)\n" +
	"  npi update --check            Check selected channel without installing\n" +
	"  npi update stable|nightly     Sync now, switch channel and release rollback hold\n" +
	"  npi update rollback [N]       Step back N releases from the current cursor; hold auto-update\n" +
	"  npi update source            Prompted source-fork integration workflow\n" +
	"  npi update --plugins [--check] Update/check plugins (separate from binary updates)";

/** Recovery entry: this graph deliberately excludes normal CLI, native startup and Settings. */
export async function runNeoPiUpdate(argv: string[], options: UpdateOptions = {}): Promise<void> {
	const args = profileArguments(argv);
	const print = options.print ?? console.log;
	if (args[0] === "--help" || args[0] === "-h") {
		print(HELP);
		return;
	}
	const command = args[0];
	if (
		command !== undefined &&
		command !== "--check" &&
		command !== "stable" &&
		command !== "nightly" &&
		command !== "rollback"
	) {
		throw new Error(`Unknown NeoPi update command: ${command}\n${HELP}`);
	}
	const steps = command === "rollback" ? Number(args[1] ?? 1) : 0;
	if (
		(command === "rollback" && (!Number.isSafeInteger(steps) || steps < 1 || !/^\d+$/.test(args[1] ?? "1"))) ||
		args.length > (command === "rollback" ? 2 : command === undefined ? 0 : 1)
	)
		throw new Error(`Invalid update arguments.\n${HELP}`);
	const executable = await realpath(options.executablePath ?? process.execPath);
	const agentDir = options.agentDir ?? getAgentDir();
	for (const message of await recoverPendingUpdate(executable)) print(message);
	const preferences = await readUpdatePreferences(agentDir);
	if (preferences.warning) print(preferences.warning);
	let state = await readState(executable);
	if (!preferences.warning && state.hold?.agentDir === agentDir && state.hold.channel !== preferences.channel) {
		await withUpdateLock(executable, async () => {
			state = await readState(executable);
			await reconcileHold(executable, state, preferences.channel, agentDir);
		});
	}
	const installed = await currentRelease(executable, state);
	if (command === undefined) {
		print(
			`NeoPi ${options.version ?? VERSION}\nExecutable: ${executable}\nChannel: ${preferences.channel}\nAutomatic updates: ${preferences.mode}\nInstalled release: ${installed?.tag ?? "local/source build (not a tracked GitHub release)"}\nRollback cursor: ${installed?.tag ?? "current build"}\nRollback hold: ${state.hold ? "ON — automatic replacement paused; run npi update stable|nightly or change the channel" : "off"}`,
		);
		return;
	}
	if (command === "--check") {
		const latest = (await releases(options.fetcher ?? fetch)).find(
			release => releaseChannel(release) === preferences.channel,
		);
		if (!latest) throw new Error(`No published NeoPi ${preferences.channel} releases found.`);
		print(
			`Latest ${preferences.channel}: ${latest.tag_name}${(await predatesUpdater(latest, options.fetcher ?? fetch)) ? " (predates or cannot verify this updater; interactive acknowledgement required to install)" : ""}\nNo binary was replaced.${state.hold ? " Rollback hold is ON." : ""}`,
		);
		return;
	}
	if (!options.executablePath && !isCompiledDestination(executable)) {
		throw new Error(
			"Binary replacement requires the dedicated compiled npi executable; Bun/source and package-manager runtimes are not update destinations.",
		);
	}
	await withUpdateLock(executable, async () => {
		const latestState = await readState(executable);
		const current = await currentRelease(executable, latestState);
		const all = await releases(options.fetcher ?? fetch);
		const channel = command === "rollback" ? (current?.channel ?? defaultUpdateChannel()) : command;
		const history = all.filter(release => releaseChannel(release) === channel);
		let target: Release | undefined;
		if (command === "rollback") {
			// A tracked release is the cursor; a new source build is ahead of published releases.
			const sha = options.gitSha ?? process.env.PI_BUILD_GIT_SHA;
			const index = current
				? history.findIndex(release => release.id === current.id && release.tag_name === current.tag)
				: sha
					? history.findIndex(
							release => release.target_commitish === sha || release.tag_name.includes(sha.slice(0, 12)),
						)
					: -1;
			if (current && index < 0)
				throw new Error(`Rollback cursor ${current.tag} is no longer published; refusing to reset it silently.`);
			target = history[index + steps];
		} else target = history[0];
		if (!target) throw new Error(`Not enough published ${channel} releases for this update/rollback.`);
		if (command !== "rollback" && current?.id === target.id && current.tag === target.tag_name) {
			const finish = async () => {
				delete latestState.hold;
				await saveState(executable, latestState);
			};
			if (preferences.warning) await finish();
			else await persistUpdateChannel(channel, agentDir, finish);
			print(
				`Already installed ${target.tag_name}; ${preferences.warning ? "unreadable config preserved" : `channel set to ${channel}`}; rollback hold released.`,
			);
			return;
		}
		if (await predatesUpdater(target, options.fetcher ?? fetch)) {
			const warning = `WARNING: ${target.tag_name} predates or cannot be verified to include NeoPi's recovery updater (${FIRST_UPDATER_VERSION}, first source ${FIRST_UPDATER_SOURCE_COMMIT}). After installing it, npi update stable/nightly/rollback may no longer be available. Recovery requires the retained ${executable}.previous binary or manual NeoPi installation.`;
			if (!(await (options.confirmLegacy ?? confirmLegacy)(warning)))
				throw new Error("Legacy release installation cancelled; nothing was replaced.");
		}
		const switchChannel = command === "rollback" || preferences.warning ? undefined : channel;
		await applyRelease(
			executable,
			target,
			latestState,
			{ ...options, agentDir },
			command === "rollback",
			preferences.channel,
			switchChannel,
		);
		const channelMessage = preferences.warning
			? "Binary recovery succeeded; the unreadable config was preserved and its channel was not changed."
			: `Channel set to ${channel}; rollback hold released.`;
		print(
			`Installed ${target.tag_name} (${releaseChannel(target)}). Previous binary: ${executable}.previous.\n${command === "rollback" ? "Rollback hold ON; repeating rollback continues from this release." : channelMessage}\nExisting sessions keep running their loaded version; restart to use the installed build.`,
		);
	});
}

/** Explicit setting changes are the only cross-profile way to clear a machine-binary hold. */
export async function releaseRollbackHold(_channel: UpdateChannel): Promise<void> {
	const executable = await realpath(process.execPath);
	if (!isCompiledDestination(executable)) return;
	await withUpdateLock(executable, async () => {
		const state = await readState(executable);
		if (!state.hold) return;
		delete state.hold;
		await saveState(executable, state);
	});
}

export async function checkForAutomaticUpdate(
	options: { channel: UpdateChannel; mode: UpdateMode; agentDir: string; onMessage: (message: string) => void },
	adapters: UpdateOptions = {},
): Promise<void> {
	if (options.mode === "off") return;
	const executable = await realpath(adapters.executablePath ?? process.execPath);
	if (!adapters.executablePath && !isCompiledDestination(executable)) return;
	await withUpdateLock(executable, async () => {
		const state = await readState(executable);
		const preferences = await readUpdatePreferences(options.agentDir);
		// A startup task may have captured old values before another session edited
		// the config. Never mistake those for a deliberate post-rollback change.
		if (preferences.warning || preferences.channel !== options.channel || preferences.mode !== options.mode) return;
		// Re-read under the destination lock: another session may have just rolled back.
		await reconcileHold(executable, state, options.channel, options.agentDir);
		if (state.hold) return;
		if (state.lastCheck?.channel === options.channel && Date.now() - state.lastCheck.at < CHECK_INTERVAL_MS) return;
		const current = await currentRelease(executable, state);
		const target = (await releases(adapters.fetcher ?? fetch)).find(
			release => releaseChannel(release) === options.channel,
		);
		state.lastCheck = { at: Date.now(), channel: options.channel };
		await saveState(executable, state);
		if (!target || target.id === current?.id) return;
		const changingChannel = options.channel !== (current?.channel ?? defaultUpdateChannel());
		if (!changingChannel && current && Date.parse(target.published_at) <= Date.parse(current.publishedAt)) return;
		if (!changingChannel && !current && !(await newerThanLocal(target, adapters))) return;
		if (await predatesUpdater(target, adapters.fetcher ?? fetch)) {
			options.onMessage(
				`${target.tag_name} predates or cannot be verified to include the recovery updater and was not installed automatically. Use npi update ${options.channel} for an interactive sync.`,
			);
			return;
		}
		if (options.mode === "notify") {
			options.onMessage(`NeoPi ${target.tag_name} available. Run npi update ${options.channel} to install.`);
			return;
		}
		await applyRelease(
			executable,
			target,
			state,
			{ ...adapters, agentDir: options.agentDir },
			false,
			options.channel,
		);
		options.onMessage(`NeoPi ${target.tag_name} installed for the next launch. Existing sessions are unchanged.`);
	});
}
