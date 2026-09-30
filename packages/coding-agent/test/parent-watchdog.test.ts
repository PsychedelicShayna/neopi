import { describe, expect, it, vi } from "bun:test";
import { type ParentWatchdogNatives, watchParentProcess } from "../src/utils/parent-watchdog";

describe("parent watchdog", () => {
	it.each([
		["rejects", () => Promise.reject(new Error("native wait unavailable"))],
		["returns false", () => Promise.resolve(false)],
	])("keeps watching an alive parent when the native wait %s", async (_, waitForExit) => {
		let status = "running";
		const onParentExit = vi.fn();
		const natives = {
			Process: {
				fromPid: () => ({ status: () => status, waitForExit }),
			},
			ProcessStatus: { Running: "running", Exited: "exited" },
		} as unknown as ParentWatchdogNatives;
		const watch = watchParentProcess({
			parentPid: process.ppid,
			natives,
			pollIntervalMs: 5,
			onParentExit,
		});
		try {
			await Bun.sleep(30);
			expect(onParentExit).not.toHaveBeenCalled();
			status = "exited";
			await Bun.sleep(30);
			expect(onParentExit).toHaveBeenCalledTimes(1);
		} finally {
			watch.stop();
		}
	});
});
