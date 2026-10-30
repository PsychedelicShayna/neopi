import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import type { Terminal, TerminalAppearance, TerminalAppearanceRequestToken } from "@oh-my-pi/pi-tui/terminal";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { RenderScheduler } from "@oh-my-pi/pi-tui/tui";
import { isEnoent, readLines } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { Settings } from "../../src/config/settings";
import { SessionDaemonClient } from "../../src/daemon/client";
import { RemoteAgentSession } from "../../src/daemon/remote-session";
import { SessionDaemon } from "../../src/daemon/server";
import { InteractiveMode } from "../../src/modes/interactive-mode";
import * as workerClient from "../../src/subprocess/worker-client";

const cli = path.join(import.meta.dir, "../../src/cli.ts");
const providerFixture = path.join(import.meta.dir, "interactive-mode-provider.ts");
const width = 240;
const toolLabels = ["viewer-live-card", "viewer-late-card"] as const;

/** The production render-cli sink: no real TTY input, output, title or progress. */
class SinkTerminal implements Terminal {
	#onInput: ((data: string) => void) | undefined;
	start(onInput: (data: string) => void): void {
		this.#onInput = onInput;
	}
	stop(): void {
		this.#onInput = undefined;
	}
	input(data: string): void {
		if (!this.#onInput) throw new Error("viewer terminal is not accepting input");
		this.#onInput(data);
	}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	get columns(): number {
		return width;
	}
	get rows(): number {
		return 60;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	get kittyEnableSequence(): string | null {
		return null;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
	refreshAppearance(_requestToken?: TerminalAppearanceRequestToken): void {}
	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}
}

/** Like render-cli, drain real Composer paints without a terminal clock. */
class DrainScheduler implements RenderScheduler {
	#time = 0;
	#immediate: (() => void)[] = [];
	#renders = new Map<number, () => void>();
	#nextId = 0;

	now(): number {
		this.#time += 20;
		return this.#time;
	}
	scheduleImmediate(callback: () => void): void {
		this.#immediate.push(callback);
	}
	scheduleRender(callback: () => void, _delayMs: number): { cancel(): void } {
		const id = this.#nextId++;
		this.#renders.set(id, callback);
		return { cancel: () => void this.#renders.delete(id) };
	}
	drain(): void {
		for (let round = 0; this.#immediate.length > 0 || this.#renders.size > 0; round++) {
			if (round > 100) throw new Error("viewer render scheduler did not settle");
			const immediate = this.#immediate;
			this.#immediate = [];
			for (const callback of immediate) callback();
			const renders = [...this.#renders.values()];
			this.#renders.clear();
			for (const callback of renders) callback();
		}
	}
}

interface Viewer {
	remote: RemoteAgentSession;
	mode: InteractiveMode;
	composer: Composer;
	scheduler: DrainScheduler;
	terminal: SinkTerminal;
	detached: boolean;
}

async function until(check: () => boolean | Promise<boolean>, description: string, ms = 60_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
		await Bun.sleep(25);
	}
}

function transcript(viewer: Viewer): string {
	viewer.scheduler.drain();
	return viewer.mode.chatContainer.render(width).map(line => Bun.stripANSI(line)).join("\n");
}

async function rendered(viewer: Viewer, text: string): Promise<string> {
	let output = "";
	await until(() => {
		output = transcript(viewer);
		return output.includes(text);
	}, `rendered transcript containing ${JSON.stringify(text)}`);
	return output;
}

function once(output: string, text: string): void {
	expect(output.split(text).length - 1, `rendered occurrences of ${JSON.stringify(text)}`).toBe(1);
}

/** Only PID files written by this fixture's own gated tool children are considered. */
async function finishTool(gates: string, label: string): Promise<void> {
	const pidFile = path.join(gates, `${label}.pid`);
	try {
		await until(async () => !(await Bun.file(pidFile).exists()), `${label} child exit`, 5_000);
	} catch {
		let pid: number;
		try {
			pid = Number(await Bun.file(pidFile).text());
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid fixture child PID: ${pid}`);
		try {
			process.kill(pid, "SIGKILL");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
		}
	}
}

describe("InteractiveMode attached to a real daemon session", () => {
	it("renders history, live replies and real tools, then rebuilds them when reattaching mid-tool", async () => {
		const scratch = process.env.NPI_TEST_SCRATCH_DIR ?? path.join(os.homedir(), ".cache", "npi-canary");
		await fs.mkdir(scratch, { recursive: true });
		const root = await fs.mkdtemp(path.join(scratch, "daemon-viewer-"));
		const home = path.join(root, "home");
		const agentDir = path.join(home, "agent");
		const project = path.join(root, "project");
		const gates = path.join(project, "gates");
		const env = {
			PATH: `${path.dirname(process.execPath)}${path.delimiter}${Bun.env.PATH ?? ""}`,
			HOME: home,
			USERPROFILE: home,
			XDG_CONFIG_HOME: path.join(home, ".config"),
			XDG_DATA_HOME: path.join(home, ".local", "share"),
			XDG_STATE_HOME: path.join(home, ".local", "state"),
			XDG_CACHE_HOME: path.join(home, ".cache"),
			TMPDIR: path.join(root, "scratch"),
			PI_CONFIG_DIR: ".omp",
			PI_CODING_AGENT_DIR: agentDir,
			PI_NO_TITLE: "1",
		};
		// SessionDaemon overlays env onto its parent by default. Keep the real
		// child-spawn path, but do not forward owner credentials or profile hooks.
		const envSpy = vi.spyOn(workerClient, "workerEnvFromParent").mockImplementation(overlay => ({ ...env, ...overlay }));
		const settings = Settings.isolated({ "startup.quiet": true, "daemon.enabled": false });
		const clients: SessionDaemonClient[] = [];
		const remotes: RemoteAgentSession[] = [];
		const viewers: Viewer[] = [];
		let daemon: SessionDaemon | undefined;
		let provider: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
		let providerStderr: Promise<void> | undefined;
		let providerErrors = "";

		async function connect(): Promise<SessionDaemonClient> {
			if (!daemon) throw new Error("test daemon has not started");
			const client = await SessionDaemonClient.connect(daemon.endpoint);
			clients.push(client);
			return client;
		}
		async function attach(id: string): Promise<RemoteAgentSession> {
			const remote = await RemoteAgentSession.attach(await connect(), id, project);
			remotes.push(remote);
			return remote;
		}
		async function openViewer(id: string): Promise<Viewer> {
			const remote = await attach(id);
			const scheduler = new DrainScheduler();
			const terminal = new SinkTerminal();
			const composer = new Composer({
				terminal,
				tuiOptions: { renderScheduler: scheduler },
				preferences: { quiet: true },
			});
			const mode = new InteractiveMode(
				remote,
				VERSION,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				composer,
				undefined,
				undefined,
				{ settings, onDetach: () => { viewer.detached = true; } },
			);
			const viewer: Viewer = { remote, mode, composer, scheduler, terminal, detached: false };
			viewers.push(viewer);
			await mode.init({ suppressWelcomeIntro: true });
			await mode.renderInitialMessages();
			scheduler.drain();
			return viewer;
		}

		try {
			await fs.mkdir(agentDir, { recursive: true });
			await fs.mkdir(gates, { recursive: true });
			await fs.mkdir(env.TMPDIR);
			await fs.symlink(providerFixture, path.join(project, "viewer-tool.ts"));
			await Bun.write(
				path.join(agentDir, "config.yml"),
				"daemon:\n  enabled: false\nasync:\n  enabled: false\nbash:\n  autoBackground:\n    enabled: false\n",
			);
			provider = Bun.spawn([process.execPath, providerFixture, agentDir, gates], {
				cwd: project,
				env,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			const providerErrorStream = provider.stderr;
			providerStderr = (async () => {
				const decoder = new TextDecoder();
				for await (const chunk of providerErrorStream) providerErrors += decoder.decode(chunk, { stream: true });
				providerErrors += decoder.decode();
			})();
			let ready = "";
			for await (const line of readLines(provider.stdout, AbortSignal.timeout(10_000))) {
				ready = new TextDecoder().decode(line);
				break;
			}
			expect(ready).toMatch(/^READY \d+$/);
			daemon = new SessionDaemon({
				dir: path.join(root, "daemon"),
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
			const hosted = await (await connect()).create(project);
			await until(() => daemon?.list().find(session => session.id === hosted.id)?.model === "fake/fake-model", "rpc-ui child ready");
			const control = await attach(hosted.id);
			await control.prompt("seed_history");
			await until(() => !control.isStreaming && JSON.stringify(control.messages).includes("prior-history-reply"), "seeded prior history");
			await initTheme(false);

			const first = await openViewer(hosted.id);
			once(await rendered(first, "prior-history-reply"), "prior-history-reply");
			expect(first.composer.editor.onSubmit).toBeDefined();
			first.composer.editor.setText("stream_reply");
			first.composer.editor.submit();
			const partial = await rendered(first, "live-first-chunk");
			expect(first.remote.isStreaming).toBe(true);
			expect(partial).not.toContain("live-final-chunk");
			await Bun.write(path.join(gates, "stream.release"), "release");
			await rendered(first, "live-first-chunk live-final-chunk");
			await until(() => !first.remote.isStreaming, "live reply completion");

			first.composer.editor.setText("run_tool_live");
			first.composer.editor.submit();
			await until(() => Bun.file(path.join(gates, "viewer-live-card.started")).exists(), "live bash child start");
			const running = await rendered(first, "viewer-live-card");
			expect(running).toContain("--tool");
			expect(running).not.toContain("viewer-live-card-finished-output");
			await Bun.write(path.join(gates, "viewer-live-card.release"), "release");
			await rendered(first, "viewer-live-card-finished-output");
			await until(() => !first.remote.isStreaming, "live tool turn completion");
			const beforeDetach = transcript(first);
			once(beforeDetach, "prior-history-reply");
			once(beforeDetach, "live-first-chunk live-final-chunk");

			// No viewer exists when this second real bash child starts. The next
			// InteractiveMode must rebuild its pending card from the attach cut.
			first.terminal.input("\x18");
			first.terminal.input("d");
			await until(() => first.detached, "Ctrl+X d viewer detach", 5_000);
			viewers.splice(viewers.indexOf(first), 1);
			remotes.splice(remotes.indexOf(first.remote), 1);
			await control.prompt("run_tool_late");
			await until(() => Bun.file(path.join(gates, "viewer-late-card.started")).exists(), "detached bash child start");
			const second = await openViewer(hosted.id);
			const reattached = await rendered(second, "viewer-late-card");
			once(reattached, "prior-history-reply");
			once(reattached, "live-first-chunk live-final-chunk");
			expect(reattached).toContain("viewer-live-card-finished-output");
			expect(reattached.split("--tool").length - 1).toBe(2);
			expect(reattached).not.toContain("viewer-late-card-finished-output");
			expect(second.remote.isStreaming).toBe(true);
			await Bun.write(path.join(gates, "viewer-late-card.release"), "release");
			await rendered(second, "viewer-late-card-finished-output");
			await until(() => !second.remote.isStreaming, "reattached tool completion");
			const completed = transcript(second);
			once(completed, "prior-history-reply");
			once(completed, "live-first-chunk live-final-chunk");
			expect(completed.split("--tool").length - 1).toBe(2);
		} catch (error) {
			const outputs = viewers.map(viewer => {
				try {
					return transcript(viewer);
				} catch (renderError) {
					return `Unable to render diagnostic transcript: ${String(renderError)}`;
				}
			});
			throw new Error(
				[
					error instanceof Error ? error.message : String(error),
					`Provider stderr:\n${providerErrors}`,
					`Hosted sessions:\n${JSON.stringify(daemon?.list() ?? [], null, 2)}`,
					`Remote messages:\n${JSON.stringify(remotes.map(remote => remote.messages), null, 2)}`,
					`Rendered transcripts:\n${outputs.join("\n--- viewer ---\n")}`,
				].join("\n\n"),
				{ cause: error },
			);
		} finally {
			try {
				await Bun.write(path.join(gates, "stream.release"), "release");
				for (const label of toolLabels) await Bun.write(path.join(gates, `${label}.release`), "release");
				for (const viewer of viewers) viewer.mode.stop();
				for (const remote of remotes) await remote.dispose();
				for (const client of clients) client.close();
				for (const label of toolLabels) await finishTool(gates, label);
			} finally {
				try {
					await daemon?.shutdown();
				} finally {
					if (provider) {
						provider.stdin.end();
						provider.kill();
						await provider.exited;
						await providerStderr;
					}
					envSpy.mockRestore();
					await fs.rm(root, { recursive: true, force: true });
				}
			}
		}
	}, 240_000);
});
