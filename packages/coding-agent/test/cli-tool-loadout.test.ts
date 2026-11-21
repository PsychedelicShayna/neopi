import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, ptree, readLines, TempDir } from "@oh-my-pi/pi-utils";
import { RpcChild } from "./helpers/rpc-child";

const cli = path.join(import.meta.dir, "../src/cli.ts");
const fakeModel = path.join(import.meta.dir, "rpc-wire/fake-openai-server.ts");
let root: TempDir;
let agentDir: string;
let project: string;
let env: Record<string, string>;
let extensionMarker: string;

beforeEach(async () => {
	root = await TempDir.create("@cli-tool-loadout-");
	agentDir = root.join("agent");
	project = root.join("project");
	extensionMarker = root.join("extension-loaded");
	await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
	await fs.mkdir(project);
	await Bun.write(
		path.join(agentDir, "extensions", "ambient.ts"),
		`export default async () => { await Bun.write(${JSON.stringify(extensionMarker)}, "loaded"); };`,
	);
	env = {
		PATH: Bun.env.PATH ?? "",
		HOME: root.path(),
		XDG_CONFIG_HOME: root.path(),
		XDG_DATA_HOME: root.path(),
		XDG_STATE_HOME: root.path(),
		PI_CODING_AGENT_DIR: agentDir,
		PI_NO_TITLE: "1",
	};
});

afterEach(async () => {
	await root.remove();
});

test("CLI --tools refuses a model call to an unlisted tool without loading ambient extensions", async () => {
	using model = ptree.spawn([process.execPath, fakeModel, agentDir], { cwd: project, env, stdin: "pipe" });
	let ready = "";
	try {
		for await (const line of readLines(model.stdout, AbortSignal.timeout(10_000))) {
			ready = new TextDecoder().decode(line);
			break;
		}
		expect(ready, model.peekStderr()).toMatch(/^READY \d+/);
		const target = root.join("not-written.txt");
		using child = ptree.spawn(
			[
				process.execPath,
				cli,
				"--mode",
				"json",
				"--model",
				"fake/fake-model",
				"--no-session",
				"--tools",
				"read,grep,glob",
				`write_uri ${target}`,
			],
			{ cwd: project, env, stdin: "ignore", timeout: 30_000 },
		);
		const output = await new Response(child.stdout).text();
		expect(await child.exited, child.peekStderr()).toBe(0);
		const frames = Bun.JSONL.parse(output).filter(isRecord);
		const result = frames.find(frame => frame.type === "tool_execution_end" && frame.toolName === "write");
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result)).toContain("Tool write not found");
		expect(await Bun.file(target).exists()).toBe(false);
		expect(await Bun.file(extensionMarker).exists()).toBe(false);
	} finally {
		model.stdin.end();
		model.kill();
		await model.exited.catch(() => {});
	}
}, 45_000);

test("RPC --tools advertises and reports its restricted loadout and refuses added host tools", async () => {
	const child = await RpcChild.spawn({
		args: ["--tools=read,grep,glob"],
		root: root.path(),
		env,
		enableExtensions: true,
	});
	try {
		const ready = await child.waitFor(frame => frame.type === "ready");
		const state = await child.request({ type: "get_state", includeDump: true });
		expect(state.success).toBe(true);
		const { dumpTools } = state.data as { dumpTools: { name: string }[] };
		expect(dumpTools.map(tool => tool.name).sort()).toEqual(["glob", "grep", "read"]);
		expect(ready.capabilities).toContain("restricted_tool_loadout");
		const registration = await child.request({
			type: "set_host_tools",
			tools: [{ name: "outside_tool", description: "Not in the loadout", parameters: { type: "object" } }],
		});
		expect(registration).toMatchObject({ success: false, error: expect.stringContaining("restricted tool loadout") });
		expect(await Bun.file(extensionMarker).exists()).toBe(false);
	} finally {
		await child.dispose();
	}
}, 45_000);
