/**
 * Issue #103 over the wire: `set_mode` is advertised, switches the session
 * between `default` and `plan`, announces each transition with `mode_changed`,
 * and `get_state` reports the result. A disabled plan mode fails with a
 * machine-readable code and leaves the session unchanged.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { RpcChild } from "./helpers/rpc-child";

const children: RpcChild[] = [];
const roots: TempDir[] = [];

afterEach(async () => {
	await Promise.all(children.splice(0).map(child => child.dispose()));
	await Promise.all(roots.splice(0).map(root => root.remove()));
});

/** Spawn an RPC child; `configYaml` becomes its agent `config.yml` before startup. */
async function spawn(configYaml?: string): Promise<RpcChild> {
	let root: string | undefined;
	if (configYaml) {
		const dir = await TempDir.create("@rpc-set-mode-");
		roots.push(dir);
		root = dir.path();
		await Bun.write(path.join(root, "agent", "config.yml"), configYaml);
	}
	const child = await RpcChild.spawn({ root });
	children.push(child);
	await child.waitFor(frame => frame.type === "ready", 30_000);
	return child;
}

describe("RPC set_mode", () => {
	test("switches into plan mode and back, reporting each transition", async () => {
		const child = await spawn();
		const ready = child.frames.find(frame => frame.type === "ready");
		expect(ready?.capabilities).toContain("set_mode");

		const entered = await child.request({ type: "set_mode", mode: "plan" }, 30_000);
		expect(entered).toMatchObject({ success: true, data: { mode: "plan", planFilePath: "local://PLAN.md" } });
		expect(child.frames.filter(frame => frame.type === "mode_changed")).toEqual([
			{ type: "mode_changed", mode: "plan", planFilePath: "local://PLAN.md" },
		]);
		const planState = await child.request({ type: "get_state" });
		expect(planState.data).toMatchObject({
			mode: "plan",
			planMode: { planFilePath: "local://PLAN.md", workflow: "parallel" },
		});

		const left = await child.request({ type: "set_mode", mode: "default" });
		expect(left).toMatchObject({ success: true, data: { mode: "default" } });
		expect(child.frames.filter(frame => frame.type === "mode_changed").at(-1)).toEqual({
			type: "mode_changed",
			mode: "default",
		});
		const defaultState = (await child.request({ type: "get_state" })).data as Record<string, unknown>;
		expect(defaultState.mode).toBe("default");
		expect("planMode" in defaultState).toBe(false);
	}, 60_000);

	test("fails with plan_disabled when plan.enabled is false", async () => {
		const child = await spawn("plan:\n  enabled: false\n");

		const response = await child.request({ type: "set_mode", mode: "plan" }, 30_000);
		expect(response).toMatchObject({ success: false, command: "set_mode", code: "plan_disabled" });
		expect(child.frames.some(frame => frame.type === "mode_changed")).toBe(false);
		expect((await child.request({ type: "get_state" })).data).toMatchObject({ mode: "default" });
	}, 60_000);
});
