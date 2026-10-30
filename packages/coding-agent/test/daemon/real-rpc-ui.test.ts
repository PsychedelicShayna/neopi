import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ptree, readLines } from "@oh-my-pi/pi-utils";
import { SessionDaemonClient } from "../../src/daemon/client";
import { SessionDaemon } from "../../src/daemon/server";

/**
 * The daemon hosting a real `npi --mode rpc-ui` child against the scripted
 * OpenAI-compatible server from test/rpc-wire. Proves what the scripted child in
 * server.test.ts cannot: that a late attacher rebuilds history from
 * `journal_state{reason:"snapshot"}` + `get_messages` + live deltas, and that
 * each hosted child publishes a control socket `ctl list` sees.
 */
const cli = path.join(import.meta.dir, "../../src/cli.ts");
const fakeModel = path.join(import.meta.dir, "../rpc-wire/fake-openai-server.ts");

let root: string;
let daemon: SessionDaemon | undefined;
let model: ReturnType<typeof ptree.spawn> | undefined;
const clients: SessionDaemonClient[] = [];

async function until(check: () => boolean, ms = 30_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await Bun.sleep(25);
	}
}

async function start(): Promise<{
	daemon: SessionDaemon;
	project: string;
	agentDir: string;
	env: Record<string, string>;
}> {
	root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "daemon-real-"));
	const home = path.join(root, "home");
	const agentDir = path.join(home, "agent");
	const project = path.join(root, "project");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(project);
	// Do not inherit API keys, profiles, provider overrides or external-tool configs.
	const env = {
		PATH: `${path.dirname(process.execPath)}${path.delimiter}${Bun.env.PATH ?? ""}`,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: path.join(home, ".config"),
		PI_CONFIG_DIR: ".omp",
		PI_CODING_AGENT_DIR: agentDir,
		PI_NO_TITLE: "1",
	};
	model = ptree.spawn([process.execPath, fakeModel, agentDir], { cwd: project, env, stdin: "pipe", detached: true });
	let ready = "";
	for await (const line of readLines(model.stdout, AbortSignal.timeout(10_000))) {
		ready = new TextDecoder().decode(line);
		break;
	}
	expect(ready).toMatch(/^READY \d+/);
	daemon = new SessionDaemon({
		dir: path.join(agentDir, "run", "session-daemon"),
		env,
		sessionCommand: args => [
			process.execPath,
			cli,
			"--mode",
			"rpc-ui",
			"--model",
			"fake/fake-model",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--no-lsp",
			"--no-prewalk",
			...args,
		],
	});
	expect(await daemon.start()).toBe(true);
	return { daemon, project, agentDir, env };
}

async function connect(d: SessionDaemon): Promise<SessionDaemonClient> {
	const client = await SessionDaemonClient.connect(d.endpoint);
	clients.push(client);
	return client;
}

function collect(client: SessionDaemonClient): Record<string, unknown>[] {
	const frames: Record<string, unknown>[] = [];
	client.onFrame(frame => frames.push(frame));
	return frames;
}

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	await daemon?.shutdown();
	daemon = undefined;
	model?.kill();
	model = undefined;
	await fs.rm(root, { recursive: true, force: true });
});

describe("SessionDaemon over a real rpc-ui child", () => {
	it("a late attacher rebuilds history from the snapshot and get_messages, and ctl sees the child", async () => {
		const { daemon: d, project, env } = await start();
		const a = await connect(d);
		const { id } = await a.create(project);
		const aFrames = collect(a);
		await a.attach(id);
		await until(() => aFrames.some(f => f.type === "ready"), 60_000);
		await until(() => d.list()[0]?.model === "fake/fake-model", 60_000);

		await a.request({ type: "prompt", message: "first" });
		await until(() => aFrames.some(f => f.type === "agent_end"), 60_000);
		expect(aFrames.filter(f => f.type === "message_update").length).toBeGreaterThan(0);

		// Attach B after the turn: the cut gives journal identity, then history by request.
		const b = await connect(d);
		const bFrames = collect(b);
		await b.attach(id);
		await until(() => bFrames.some(f => f.type === "journal_state" && f.reason === "snapshot"));
		const messages = (await b.request({ type: "get_messages" })) as {
			messages: { role: string; content: unknown }[];
		};
		expect(messages.messages.map(m => m.role)).toEqual(["user", "assistant"]);
		const text = JSON.stringify(messages.messages[1]!.content);
		expect(text).toContain("pong");
		// B saw no live deltas from a turn that ended before it attached.
		expect(bFrames.some(f => f.type === "message_update")).toBe(false);

		// Second turn prompted by B: A and B both get exactly the live deltas.
		const aBefore = aFrames.length;
		const bBefore = bFrames.length;
		await b.request({ type: "prompt", message: "second" });
		await until(() => aFrames.slice(aBefore).some(f => f.type === "agent_end"), 60_000);
		await until(() => bFrames.slice(bBefore).some(f => f.type === "agent_end"), 60_000);
		const live = (frames: Record<string, unknown>[], from: number) =>
			frames
				.slice(from)
				.filter(f => f.type === "message_update")
				.map(f => JSON.stringify(f));
		expect(live(aFrames, aBefore)).toEqual(live(bFrames, bBefore));
		expect(live(aFrames, aBefore).length).toBeGreaterThan(0);

		// Third turn streams slowly; C attaches mid-reply and must rebuild it exactly once
		// from its snapshot message plus the live deltas that follow its cut.
		const textDeltas = (frames: Record<string, unknown>[]) =>
			frames
				.filter(f => f.type === "message_update")
				.map(f => f.assistantMessageEvent as { type: string; delta?: string })
				.filter(e => e?.type === "text_delta")
				.map(e => e.delta ?? "");
		const aTurn3 = aFrames.length;
		await a.request({ type: "prompt", message: "slow_stream" });
		await until(() => textDeltas(aFrames.slice(aTurn3)).length >= 2, 60_000);
		const c = await connect(d);
		const cFrames = collect(c);
		await c.attach(id);
		await until(() => cFrames.some(f => f.type === "agent_end"), 60_000);
		await until(() => aFrames.slice(aTurn3).some(f => f.type === "agent_end"), 60_000);
		expect(textDeltas(aFrames.slice(aTurn3)).join("")).toBe("one two three four five");
		const snap = cFrames.find(f => f.type === "message_start" && f.snapshot === true) as
			| { message: { content: { type: string; text?: string }[] } }
			| undefined;
		expect(snap).toBeDefined();
		const snapText = snap!.message.content
			.filter(part => part.type === "text")
			.map(part => part.text ?? "")
			.join("");
		expect(snapText.length).toBeGreaterThan(0);
		expect(snapText + textDeltas(cFrames).join("")).toBe("one two three four five");
		// A saw none of C's snapshot frames.
		expect(aFrames.slice(aTurn3).some(f => f.snapshot === true || f.reason === "snapshot")).toBe(false);

		// The hosted child published its own control socket: `ctl list` and `ctl state` reach it.
		const pid = d.list()[0]!.pid;
		const list = Bun.spawnSync([process.execPath, cli, "ctl", "list", "--json"], { cwd: project, env });
		expect(list.exitCode, new TextDecoder().decode(list.stderr)).toBe(0);
		const rows = JSON.parse(new TextDecoder().decode(list.stdout)).sessions as {
			meta: { pid: number; instanceId: string };
			snapshot: unknown;
		}[];
		const row = rows.find(r => r.meta.pid === pid);
		expect(row?.snapshot).toBeTruthy();
		const state = Bun.spawnSync([process.execPath, cli, "ctl", row!.meta.instanceId, "state", "--json"], {
			cwd: project,
			env,
		});
		expect(state.exitCode, new TextDecoder().decode(state.stderr)).toBe(0);
	}, 180_000);
});
