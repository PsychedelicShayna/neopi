import { afterEach, expect, it } from "bun:test";
import * as path from "node:path";
import type { MixtureDefinition } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { RpcChild } from "./helpers/rpc-child";

let child: RpcChild | undefined;

afterEach(async () => {
	await child?.dispose();
	child = undefined;
});

it("creates a graph in MIXTURES.toml, registers it as a model, and selects it on the live session", async () => {
	child = await RpcChild.spawn();
	await child.waitFor(frame => frame.type === "ready");
	const definition: MixtureDefinition = {
		name: "rpc-graph",
		entry: "draft",
		members: [
			{ id: "draft", model: "anthropic/claude-sonnet-4-5", systemPrompt: "Draft the answer.", tools: false },
			{ id: "edit", model: "anthropic/claude-sonnet-4-5", systemPrompt: "Edit the draft.", tools: false },
		],
		edges: [{ from: "draft", to: "edit", x: { output: true } }],
	};
	const invalid = await child.request({
		type: "create_mixture",
		scope: "user",
		definition: { ...definition, edges: [{ from: "draft", to: "missing", x: { output: true } }] },
	});
	expect(invalid.success).toBe(false);
	expect(await Bun.file(path.join(child.agentDir, "MIXTURES.toml")).exists()).toBe(false);

	const created = await child.request({ type: "create_mixture", scope: "user", definition });
	expect(created.success, JSON.stringify(created)).toBe(true);
	expect(created.data).toMatchObject({ name: "rpc-graph", path: path.join(child.agentDir, "MIXTURES.toml") });
	const listed = await child.request({ type: "list_mixtures" });
	expect(listed.data).toMatchObject({ mixtures: [{ name: "rpc-graph", registered: true, errors: [] }] });
	const listViaSlash = await child.request({ type: "prompt", message: "/moa list" });
	expect(listViaSlash.success, JSON.stringify(listViaSlash)).toBe(true);
	expect(
		child.frames.some(frame => frame.type === "command_output" && String(frame.text).includes("rpc-graph (ready)")),
	).toBe(true);
	const useViaSlash = await child.request({ type: "prompt", message: "/moa use rpc-graph" });
	expect(useViaSlash.success, JSON.stringify(useViaSlash)).toBe(true);
	expect((await child.request({ type: "get_state" })).data).toMatchObject({
		model: { provider: "mixture", id: "rpc-graph" },
	});
	await child.request({ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4-5" });
	const selected = await child.request({ type: "select_mixture", name: "rpc-graph" });
	expect(selected.success, JSON.stringify(selected)).toBe(true);
	expect((await child.request({ type: "get_state" })).data).toMatchObject({
		model: { provider: "mixture", id: "rpc-graph" },
	});
	expect((await child.request({ type: "create_mixture", scope: "user", definition })).success).toBe(false);
});
