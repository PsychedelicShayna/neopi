import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { discoverAdvisorConfigs, type DiscoveredAdvisors } from "./config";
import { configCandidatePaths } from "./watchdog";

const ROSTER_FILES = ["WATCHDOG.yml", "WATCHDOG.yaml"];
const RELOAD_DELAY_MS = 100;

/** Watch candidate directories so creation, deletion and atomic replacement all trigger discovery. */
export function watchAdvisorConfigs(
	cwd: string,
	agentDir: string,
	apply: (discovered: DiscoveredAdvisors) => void,
): () => void {
	const candidates = configCandidatePaths(cwd, agentDir, ROSTER_FILES).candidates;
	const watchers = new Map<string, fs.FSWatcher>();
	const filenames = new Map<string, Set<string>>();
	// Some platforms report only the temporary SOURCE name for an atomic
	// rename. Compare candidate metadata on other rename events to detect the
	// destination without rediscovering on unrelated directory churn.
	const signatures = new Map<string, string>();
	const signature = (file: string): string => {
		try {
			const stat = fs.statSync(file, { throwIfNoEntry: false });
			return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : "missing";
		} catch (error) {
			return `error:${String(error)}`;
		}
	};
	const candidatesChanged = (): boolean => {
		let changed = false;
		for (const candidate of candidates) {
			const current = signature(candidate);
			if (signatures.get(candidate) !== current) changed = true;
			signatures.set(candidate, current);
		}
		return changed;
	};
	candidatesChanged();
	let timer: NodeJS.Timeout | undefined;
	let revision = 0;
	let disposed = false;

	const schedule = (): void => {
		revision++;
		if (timer) clearTimeout(timer);
		const requested = revision;
		timer = setTimeout(() => {
			timer = undefined;
			void discoverAdvisorConfigs(cwd, agentDir)
				.then(discovered => {
					if (disposed || requested !== revision || discovered.unsafeToReconcile) return;
					apply(discovered);
				})
				.catch(error => logger.warn("Failed to reload advisor roster", { error: String(error) }));
		}, RELOAD_DELAY_MS);
		timer.unref();
	};

	const refresh = (): void => {
		const next = new Map<string, Set<string>>();
		for (const candidate of candidates) {
			let directory = path.dirname(candidate);
			while (true) {
				if (watchers.has(directory) && !fs.existsSync(directory)) {
					watchers.get(directory)?.close();
					watchers.delete(directory);
				}
				if (!watchers.has(directory)) {
					try {
						const watcher = fs.watch(directory, { persistent: false }, (_event, name) => {
							if (disposed) return;
							const tracked = name && filenames.get(directory)?.has(String(name));
							if (!tracked && (_event !== "rename" || !candidatesChanged())) return;
							if (tracked) candidatesChanged();
							refresh();
							schedule();
						});
						watcher.on("error", error => {
							watcher.close();
							watchers.delete(directory);
							logger.warn("Advisor config watcher failed", { path: directory, error: String(error) });
							if (!disposed) refresh();
						});
						watchers.set(directory, watcher);
					} catch (error) {
						if (!isEnoent(error)) {
							logger.warn("Cannot watch advisor config directory", { path: directory, error: String(error) });
							break;
						}
						const parent = path.dirname(directory);
						if (parent === directory) break;
						directory = parent;
						continue;
					}
				}
				const nextPart = path.relative(directory, candidate).split(path.sep)[0];
				const names = next.get(directory) ?? new Set<string>();
				names.add(nextPart);
				next.set(directory, names);
				break;
			}
		}
		for (const [directory, watcher] of watchers) {
			if (next.has(directory)) continue;
			watcher.close();
			watchers.delete(directory);
		}
		filenames.clear();
		for (const [directory, names] of next) filenames.set(directory, names);
	};

	refresh();
	return () => {
		disposed = true;
		revision++;
		if (timer) clearTimeout(timer);
		for (const watcher of watchers.values()) watcher.close();
		watchers.clear();
	};
}
