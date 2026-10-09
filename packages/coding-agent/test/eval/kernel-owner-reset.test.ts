import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	disposeVmContextsByOwner,
	executeInVmContext,
	snapshotVmContext,
} from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import {
	disposeKernelSessionsByOwner,
	executePython,
	shadowPlanPythonIfPresent,
} from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function createSession(ownerId: string): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalKernelOwnerId: () => ownerId,
		settings: Settings.isolated(),
	};
}

describe("owner-scoped retained kernel resets", () => {
	it("isolates JavaScript child resets, subsequent cells, and owner cleanup", async () => {
		const sessionId = `owner-reset-js-${crypto.randomUUID()}`;
		const parentId = `${sessionId}:parent`;
		const childId = `${sessionId}:child`;
		const parent = createSession(parentId);
		const child = createSession(childId);
		const run = async (session: ToolSession, code: string, reset = false): Promise<unknown[]> => {
			const outputs: unknown[] = [];
			await executeInVmContext({
				sessionKey: sessionId,
				sessionId,
				cwd: process.cwd(),
				session,
				code,
				reset,
				filename: "owner-reset.js",
				runState: {
					onDisplay: output => {
						if (output.type === "json") outputs.push(output.data);
					},
				},
			});
			return outputs;
		};
		try {
			await run(parent, "globalThis.parentValue = 17;");
			expect(await run(child, "globalThis.childOldValue = 19; display([parentValue]);")).toEqual([[17]]);
			expect(await run(parent, "display([childOldValue]);")).toEqual([[19]]);
			expect(
				await run(child, "display([typeof parentValue, typeof childOldValue]); globalThis.childValue = 23;", true),
			).toEqual([["undefined", "undefined"]]);
			expect(await run(child, "display([typeof parentValue, childValue]);")).toEqual([["undefined", 23]]);
			expect(await run(parent, "display([parentValue, childOldValue, typeof childValue]);")).toEqual([
				[17, 19, "undefined"],
			]);

			expect(
				(await snapshotVmContext({ sessionKey: sessionId, sessionId, cwd: process.cwd(), ownerId: childId }))
					?.values,
			).toEqual({ childValue: 23 });
			expect(await run(child, "display([typeof childValue]); globalThis.childValue = 29;", true)).toEqual([
				["undefined"],
			]);
			expect(await run(child, "display([childValue]);")).toEqual([[29]]);

			await disposeVmContextsByOwner(childId);
			expect(await run(parent, "display([parentValue, childOldValue]);")).toEqual([[17, 19]]);
			await run(child, "globalThis.childValue = 31;", true);
			await disposeVmContextsByOwner(parentId);
			expect(await run(child, "display([typeof parentValue, childValue]);")).toEqual([["undefined", 31]]);
		} finally {
			await Promise.all([disposeVmContextsByOwner(childId), disposeVmContextsByOwner(parentId)]);
		}
	}, 60_000);

	it("keeps a cancelled JavaScript fork isolated when its worker is recreated", async () => {
		const sessionId = `owner-reset-cancel-${crypto.randomUUID()}`;
		const parentId = `${sessionId}:parent`;
		const childId = `${sessionId}:child`;
		const parent = createSession(parentId);
		const child = createSession(childId);
		const controller = new AbortController();
		const abortError = new Error("cancel child fork");
		const run = async (session: ToolSession, code: string, reset = false): Promise<unknown[]> => {
			const outputs: unknown[] = [];
			await executeInVmContext({
				sessionKey: sessionId,
				sessionId,
				cwd: process.cwd(),
				session,
				code,
				reset,
				filename: "owner-reset-cancel.js",
				runState: {
					onDisplay: output => {
						if (output.type === "json") outputs.push(output.data);
					},
				},
			});
			return outputs;
		};
		try {
			await run(parent, "globalThis.parentValue = 41;");
			await run(child, "globalThis.childValue = 43;", true);
			await expect(
				executeInVmContext({
					sessionKey: sessionId,
					sessionId,
					cwd: process.cwd(),
					session: child,
					filename: "owner-reset-cancel.js",
					code: "display({ ready: true }); await Promise.withResolvers().promise;",
					runState: {
						signal: controller.signal,
						onDisplay: output => {
							if (output.type === "json") controller.abort(abortError);
						},
					},
				}),
			).rejects.toThrow("cancel child fork");
			expect(await run(child, "display([typeof parentValue, typeof childValue]);")).toEqual([
				["undefined", "undefined"],
			]);
			expect(await run(parent, "display([parentValue]);")).toEqual([[41]]);
		} finally {
			controller.abort(abortError);
			await Promise.all([disposeVmContextsByOwner(childId), disposeVmContextsByOwner(parentId)]);
		}
	}, 60_000);

	it("isolates Python child resets, retained namespace lookup, and owner cleanup", async () => {
		const sessionId = `owner-reset-python-${crypto.randomUUID()}`;
		const parentId = `${sessionId}:parent`;
		const childId = `${sessionId}:child`;
		const run = async (kernelOwnerId: string, code: string, reset = false): Promise<string> => {
			const result = await executePython(code, { cwd: process.cwd(), sessionId, kernelOwnerId, reset });
			expect(result.exitCode).toBe(0);
			return result.output.trim();
		};
		try {
			await run(parentId, "parent_value = 17");
			expect(await run(childId, "child_old_value = 19\nprint(parent_value)")).toBe("17");
			expect(await run(parentId, "print(child_old_value)")).toBe("19");
			expect(
				await run(
					childId,
					"print('parent_value' in globals(), 'child_old_value' in globals())\nchild_value = 23",
					true,
				),
			).toBe("False False");
			expect(await run(childId, "print('parent_value' in globals(), child_value)")).toBe("False 23");
			expect(await run(parentId, "print(parent_value, child_old_value, 'child_value' in globals())")).toBe(
				"17 19 False",
			);

			const projected = await shadowPlanPythonIfPresent({
				cwd: process.cwd(),
				sessionId,
				kernelOwnerId: childId,
				code: "print(child_value)",
			});
			expect(projected?.snapshot.values.child_value).toBe(23);
			expect(projected?.snapshot.values.parent_value).toBeUndefined();
			expect(await run(childId, "print('child_value' in globals())\nchild_value = 29", true)).toBe("False");
			expect(await run(childId, "print(child_value)")).toBe("29");

			await disposeKernelSessionsByOwner(childId);
			expect(await run(parentId, "print(parent_value, child_old_value)")).toBe("17 19");
			await run(childId, "child_value = 31", true);
			await disposeKernelSessionsByOwner(parentId);
			expect(await run(childId, "print('parent_value' in globals(), child_value)")).toBe("False 31");
		} finally {
			await Promise.all([disposeKernelSessionsByOwner(childId), disposeKernelSessionsByOwner(parentId)]);
		}
	}, 60_000);
});
