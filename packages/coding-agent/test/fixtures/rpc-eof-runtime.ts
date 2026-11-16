import { expect, spyOn, vi } from "bun:test";
import { postmortem } from "@oh-my-pi/pi-utils";
import { createAgentSession, Settings } from "../../src/sdk";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode";

// Each fixture runs in its own process and isolated profile. No provider or real live transport is used.
spyOn(globalThis, "fetch").mockRejectedValue(new Error("EOF fixture refuses network access"));
const scenario = process.argv[2];
const startupEntered = Promise.withResolvers<void>();
const blocked = Promise.withResolvers<void>().promise;
const phase = (name: string): void => {
	process.stdout.write(`${JSON.stringify({ type: "fixture_phase", name })}\n`);
};
const { session } = await createAgentSession({
	cwd: process.cwd(),
	toolNames: [],
	enableMCP: false,
	enableLsp: false,
	disableExtensionDiscovery: true,
	settings: Settings.isolated({ "compaction.enabled": false, "marketplace.autoUpdate": "off" }),
	extensions:
		scenario === "clock"
			? [
					pi => {
						pi.on("session_start", async () => {
							startupEntered.resolve();
							await blocked;
						});
					},
				]
			: [],
});

if (scenario === "revoke") {
	session.refreshRpcHostTools = async () => {
		phase("revoke");
		await blocked;
	};
}
if (scenario === "stderr" || scenario === "failure-stdout" || scenario === "normal-failure") {
	const failure = new Error("ENOSPC: EOF fixture persistence failure");
	// Replay a latched failure and the identical disposal rejection, as the real store does.
	session.sessionManager.onPersistenceError = listener => {
		listener(failure);
		return () => {};
	};
	session.dispose = async () => {
		throw failure;
	};
	if (scenario === "stderr") {
		process.stderr.write = () => {
			phase("stderr");
			return false;
		};
	}
}

if (scenario === "clock") {
	let closeInput!: () => void;
	const input = new ReadableStream<Uint8Array>({
		start(controller) {
			closeInput = () => controller.close();
		},
	});
	vi.useFakeTimers();
	const deadlineArmed = Promise.withResolvers<void>();
	const setTimer = globalThis.setTimeout;
	spyOn(globalThis, "setTimeout").mockImplementation(
		Object.assign((...args: Parameters<typeof setTimeout>) => {
			const timer = setTimer(...args);
			if (args[1] === 10_000) deadlineArmed.resolve();
			return timer;
		}, setTimer),
	);
	const hardExit = spyOn(postmortem, "exitProcess").mockResolvedValue(undefined);
	void runRpcMode(session, { input, exitOnInputClosed: true });
	await startupEntered.promise;
	closeInput();
	await deadlineArmed.promise;
	vi.advanceTimersByTime(9_999);
	expect(hardExit).not.toHaveBeenCalled();
	vi.advanceTimersByTime(1);
	expect(hardExit).toHaveBeenCalledTimes(1);
	expect(hardExit).toHaveBeenCalledWith(129);
	phase("deadline-at-10000");
	process.exit(0);
}

await runRpcMode(session, {
	exitOnInputClosed: scenario !== "normal-failure",
	createLiveSession: () => ({
		muted: false,
		sdpAnswer: undefined,
		start: async () => {},
		toggleMute: () => {},
		stop: async () => {
			phase("live-stop");
			await blocked;
		},
	}),
});
