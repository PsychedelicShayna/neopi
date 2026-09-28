import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

// Contract (neopi#127): a headless `-p --mode json` run dies with the host that
// spawned it, even when the host is SIGKILLed — taking its running bash command
// and its stdio MCP servers' process groups with it.

const CLI = path.join(import.meta.dir, "../src/cli.ts");

/** Stdio MCP server that ignores stdin EOF and SIGTERM and keeps a grandchild in its process group. */
const STUBBORN_MCP_SERVER = `
process.on("SIGTERM", () => {});
await Bun.write(process.env.MCP_PID_FILE, String(process.pid));
Bun.spawn(["sleep", "300"], { stdio: ["ignore", "ignore", "ignore"] });
setInterval(() => {}, 1 << 30);
let buffered = "";
process.stdin.on("data", chunk => {
	buffered += chunk.toString();
	for (let nl = buffered.indexOf("\\n"); nl >= 0; nl = buffered.indexOf("\\n")) {
		const line = buffered.slice(0, nl).trim();
		buffered = buffered.slice(nl + 1);
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.id === undefined) continue;
		const result =
			message.method === "initialize"
				? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stubborn", version: "1" } }
				: message.method === "tools/list"
					? { tools: [] }
					: {};
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
	}
});
process.stdin.on("end", () => {});
`;

/**
 * Host stand-in: spawns the run with piped stdout, stderr to a file, as an
 * orchestrator would. HOST_STDIN=<path> opens that file as the run's stdin.
 */
const HOST = `
const [cli, pidFile, stderrFile, ...args] = process.argv.slice(2);
const run = Bun.spawn([process.execPath, cli, ...args], {
	stdin: process.env.HOST_STDIN ? Bun.file(process.env.HOST_STDIN) : "ignore",
	stdout: "pipe",
	stderr: Bun.file(stderrFile),
});
await Bun.write(pidFile, String(run.pid));
void new Response(run.stdout).text();
await run.exited;
`;

/** `[state, pgrp]` from /proc/<pid>/stat; zombies count as gone (their reaper may lag). */
function procStat(pid: string): [string, number] | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return [fields[0], Number(fields[2])];
	} catch {
		return undefined;
	}
}

function isAlive(pid: number): boolean {
	const stat = procStat(String(pid));
	return stat !== undefined && stat[0] !== "Z";
}

function groupAlive(pgid: number): boolean {
	return fs.readdirSync("/proc").some(entry => {
		if (!/^\d+$/.test(entry)) return false;
		const stat = procStat(entry);
		return stat !== undefined && stat[0] !== "Z" && stat[1] === pgid;
	});
}

async function readPid(file: string): Promise<number | undefined> {
	if (!fs.existsSync(file)) return undefined;
	const pid = Number((await Bun.file(file).text()).trim());
	return pid > 0 ? pid : undefined;
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await Bun.sleep(50);
	}
	return condition();
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Sandbox {
	dir: string;
	agentDir: string;
	work: string;
	hostFile: string;
	runPidFile: string;
	stderrFile: string;
	env: Record<string, string | undefined>;
}

/** Temp agent dir, HOME and XDG dirs, plus the host script, so runs never touch the user's config. */
async function createSandbox(): Promise<Sandbox> {
	const root = await TempDir.create("@omp-exit-with-parent-");
	cleanups.push(() => root.remove());
	const dir = root.path();
	const agentDir = path.join(dir, "agent");
	const home = path.join(dir, "home");
	const work = path.join(dir, "work");
	for (const d of [agentDir, home, work]) fs.mkdirSync(d, { recursive: true });
	const hostFile = path.join(dir, "host.ts");
	await Bun.write(hostFile, HOST);
	return {
		dir,
		agentDir,
		work,
		hostFile,
		runPidFile: path.join(dir, "run.pid"),
		stderrFile: path.join(dir, "run.stderr"),
		env: {
			...process.env,
			HOME: home,
			PI_CODING_AGENT_DIR: agentDir,
			FAKEAI_KEY: "test",
			XDG_CONFIG_HOME: path.join(home, ".config"),
			XDG_DATA_HOME: path.join(home, ".local/share"),
			XDG_STATE_HOME: path.join(home, ".local/state"),
			XDG_CACHE_HOME: path.join(home, ".cache"),
		},
	};
}

describe.skipIf(process.platform !== "linux")("print mode exit-with-parent", () => {
	it("tears down the bash command and the MCP process group when the host is SIGKILLed", async () => {
		const { dir, agentDir, work, hostFile, runPidFile, stderrFile, env } = await createSandbox();
		const bashPidFile = path.join(dir, "bash.pid");
		const mcpPidFile = path.join(dir, "mcp.pid");

		// Deterministic OpenAI-compatible model: always asks for one long bash command.
		const bashCommand = `sh -c 'echo $$ > ${bashPidFile}; exec sleep 300'`;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				const body = (await req.json()) as { model: string };
				const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: body.model };
				const chunks = [
					{
						...base,
						choices: [
							{
								index: 0,
								delta: {
									role: "assistant",
									content: null,
									tool_calls: [
										{
											index: 0,
											id: "call_1",
											type: "function",
											function: { name: "bash", arguments: JSON.stringify({ command: bashCommand }) },
										},
									],
								},
							},
						],
					},
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				];
				const sse = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
				return new Response(sse, { headers: { "content-type": "text/event-stream" } });
			},
		});
		cleanups.push(() => server.stop(true));

		await Bun.write(
			path.join(agentDir, "models.yml"),
			[
				"providers:",
				"  fakeai:",
				`    baseUrl: http://127.0.0.1:${server.port}/v1`,
				"    apiKey: FAKEAI_KEY",
				"    api: openai-completions",
				"    models:",
				"      - id: fake-model",
				"        reasoning: false",
				"        input: [text]",
				"        contextWindow: 128000",
				"        maxTokens: 4096",
				"",
			].join("\n"),
		);
		const mcpServerFile = path.join(dir, "mcp-server.ts");
		await Bun.write(mcpServerFile, STUBBORN_MCP_SERVER);
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					stubborn: { command: process.execPath, args: [mcpServerFile], env: { MCP_PID_FILE: mcpPidFile } },
				},
			}),
		);

		const host = Bun.spawn(
			[
				process.execPath,
				hostFile,
				CLI,
				runPidFile,
				stderrFile,
				"-p",
				"--mode",
				"json",
				"--no-session",
				"--no-title",
				"--no-skills",
				"--no-rules",
				"--no-lsp",
				"--model",
				"fakeai/fake-model",
				"run the long command",
			],
			{
				cwd: work,
				env,
				stdio: ["ignore", "ignore", "ignore"],
			},
		);
		let runPid: number | undefined;
		let bashPid: number | undefined;
		let mcpPgid: number | undefined;
		cleanups.push(() => {
			for (const pid of [host.pid, runPid, bashPid]) {
				if (pid === undefined) continue;
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
			if (mcpPgid === undefined) return;
			try {
				process.kill(-mcpPgid, "SIGKILL");
			} catch {}
		});

		const started = await waitUntil(async () => {
			runPid ??= await readPid(runPidFile);
			bashPid ??= await readPid(bashPidFile);
			// The stdio server runs detached (setsid), so its pid is its process group id.
			mcpPgid ??= await readPid(mcpPidFile);
			return runPid !== undefined && bashPid !== undefined && mcpPgid !== undefined;
		}, 60_000);
		expect({ started, runPid, bashPid, mcpPgid }).toMatchObject({ started: true });

		process.kill(host.pid, "SIGKILL");

		await waitUntil(() => !isAlive(runPid!) && !isAlive(bashPid!) && !groupAlive(mcpPgid!), 5_000);
		expect({
			run: isAlive(runPid!),
			bash: isAlive(bashPid!),
			mcpGroup: groupAlive(mcpPgid!),
		}).toEqual({ run: false, bash: false, mcpGroup: false });
	}, 90_000);

	it("exits while blocked reading a prompt from a stdin pipe that outlives the host", async () => {
		// Another process holds the stdin write end, so EOF never arrives and the
		// run would wait for its prompt forever after the host is gone.
		const { dir, work, hostFile, runPidFile, stderrFile, env } = await createSandbox();
		const fifo = path.join(dir, "stdin.fifo");
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		const writer = Bun.spawn(["sh", "-c", 'exec sleep 300 > "$0"', fifo], { stdio: ["ignore", "ignore", "ignore"] });
		const host = Bun.spawn(
			[
				process.execPath,
				hostFile,
				CLI,
				runPidFile,
				stderrFile,
				"-p",
				"--mode",
				"json",
				"--no-session",
				"--no-title",
			],
			{ cwd: work, env: { ...env, HOST_STDIN: fifo }, stdio: ["ignore", "ignore", "ignore"] },
		);
		let runPid: number | undefined;
		cleanups.push(() => {
			for (const pid of [host.pid, runPid, writer.pid]) {
				if (pid === undefined) continue;
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		});

		// The run announces the blocking read on stderr after 1 s.
		const blocked = await waitUntil(async () => {
			runPid ??= await readPid(runPidFile);
			return (
				fs.existsSync(stderrFile) && (await Bun.file(stderrFile).text()).includes("Reading prompt from piped stdin")
			);
		}, 60_000);
		expect({ blocked, runPid }).toMatchObject({ blocked: true });

		process.kill(host.pid, "SIGKILL");

		await waitUntil(() => !isAlive(runPid!), 5_000);
		expect(isAlive(runPid!)).toBe(false);
	}, 90_000);
});
