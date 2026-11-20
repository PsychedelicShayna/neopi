#!/usr/bin/env bun
/** Recovery entry: do not import the ordinary CLI graph here. */
import type * as OrdinaryCli from "./cli-main";
import type * as Updater from "./cli/neopi-updater";

try {
	delete process.env.MallocStackLogging;
	delete process.env.MallocStackLoggingNoCompact;
} catch {}

/** Find the command without loading the profile parser's command registry. */
function recoveryArgv(argv: string[]): string[] | undefined {
	const positional: string[] = [];
	let updateIndex = -1;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--profile") {
			index++;
			continue;
		}
		if (arg.startsWith("--profile=")) continue;
		if (positional.length === 0 && arg === "update") updateIndex = index;
		positional.push(arg);
	}
	if (updateIndex < 0 || positional[0] !== "update") return undefined;
	// Source integration and plugins deliberately retain the ordinary CLI path.
	if (positional[1] === "source" || positional.includes("--plugins") || positional.includes("-l")) {
		return undefined;
	}
	return argv.filter((_, index) => index !== updateIndex);
}

/** SDK-compatible entry; ordinary dispatch remains synchronous until its own first await. */
export function runCli(argv: string[]): Promise<void> {
	const updateArgv = recoveryArgv(argv);
	if (updateArgv) {
		const updater: typeof Updater = require("./cli/neopi-updater");
		return updater.runNeoPiUpdate(updateArgv);
	}
	// Bun's synchronous bridge is required: awaiting import before worker dispatch
	// drops parked initial messages before the worker installs its inbox.
	const ordinary: typeof OrdinaryCli = require("./cli-main");
	return ordinary.runCli(argv);
}

// Bun.build's Windows compiled loader can report import.meta.main === false.
const isProcessEntry = import.meta.main || process.env.PI_COMPILED === "true";
if (isProcessEntry || !Bun.isMainThread) {
	const argv = process.argv.slice(2);
	const updateArgv = recoveryArgv(argv);
	if (updateArgv && Bun.isMainThread) {
		runCli(argv).catch(error => {
			process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		});
	} else {
		const ordinary: typeof OrdinaryCli = require("./cli-main");
		ordinary.startCli(isProcessEntry);
	}
}
