import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

export interface RpcChildOptions {
	/** Bun runtime arguments (e.g. a test-only preload), before the CLI entrypoint. */
	bunArgs?: string[];
	/** Extra CLI arguments appended after `--mode <mode>`. */
	args?: string[];
	/** Include discovered extensions and custom commands in the child. */
	enableExtensions?: boolean;
	mode?: "rpc" | "rpc-ui";
	/** Extra environment; merged over the isolated defaults. */
	env?: Record<string, string>;
	/** Reuse an existing root (agent dir, XDG dirs) instead of creating one. */
	root?: string;
}

export type RpcFrame = Record<string, unknown>;

/**
 * A source-CLI RPC process with an isolated agent/config/data root.
 *
 * Every stdout frame is recorded in arrival order; `waitFor` scans recorded
 * frames first, so a frame that arrived before the wait began is still found.
 */
export class RpcChild {
	readonly root: string;
	readonly agentDir: string;
	readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly frames: RpcFrame[] = [];
	#stderr = "";
	#waiters: Array<{ predicate: (frame: RpcFrame) => boolean; resolve: (frame: RpcFrame) => void }> = [];
	#closed = Promise.withResolvers<void>();
	#nextId = 0;
	#ownedRoot: TempDir | undefined;

	constructor(root: string, ownedRoot: TempDir | undefined, options: RpcChildOptions) {
		this.root = root;
		this.#ownedRoot = ownedRoot;
		this.agentDir = path.join(root, "agent");
		fs.mkdirSync(this.agentDir, { recursive: true });
		const packageRoot = path.join(import.meta.dir, "..", "..");
		this.process = Bun.spawn(
			[
				"bun",
				...(options.bunArgs ?? []),
				path.join(packageRoot, "src", "cli.ts"),
				"--mode",
				options.mode ?? "rpc",
				...(options.enableExtensions ? [] : ["--no-extensions"]),
				"--no-skills",
				"--no-rules",
				...(options.args ?? []),
			],
			{
				cwd: packageRoot,
				env: {
					...Bun.env,
					ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
					PI_NO_TITLE: "1",
					NO_COLOR: "1",
					XDG_DATA_HOME: root,
					XDG_CONFIG_HOME: root,
					XDG_STATE_HOME: root,
					PI_CODING_AGENT_DIR: this.agentDir,
					...options.env,
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		void this.#pumpStdout();
		void this.#pumpStderr();
	}

	static async spawn(options: RpcChildOptions = {}): Promise<RpcChild> {
		if (options.root) return new RpcChild(options.root, undefined, options);
		const tempDir = await TempDir.create("@rpc-child-");
		return new RpcChild(tempDir.path(), tempDir, options);
	}

	get stderr(): string {
		return this.#stderr;
	}

	/** Resolves when stdout ends. */
	get closed(): Promise<void> {
		return this.#closed.promise;
	}

	send(frame: object): void {
		this.process.stdin.write(`${JSON.stringify(frame)}\n`);
		void this.process.stdin.flush();
	}

	/** Send a command and resolve with its correlated `response` frame. */
	async request(command: Record<string, unknown>, timeoutMs = 20_000): Promise<RpcFrame> {
		const id = typeof command.id === "string" ? command.id : `req-${++this.#nextId}`;
		const response = this.waitFor(frame => frame.type === "response" && frame.id === id, timeoutMs);
		this.send({ ...command, id });
		return response;
	}

	waitFor(predicate: (frame: RpcFrame) => boolean, timeoutMs = 20_000): Promise<RpcFrame> {
		const found = this.frames.find(predicate);
		if (found) return Promise.resolve(found);
		const { promise, resolve, reject } = Promise.withResolvers<RpcFrame>();
		const waiter = { predicate, resolve };
		this.#waiters.push(waiter);
		const timer = setTimeout(() => {
			this.#waiters = this.#waiters.filter(entry => entry !== waiter);
			reject(new Error(`Timed out waiting for RPC frame. stderr:\n${this.#stderr}`));
		}, timeoutMs);
		return promise.finally(() => clearTimeout(timer));
	}

	/** Close stdin, wait for exit (killing after `timeoutMs`), and remove an owned root. */
	async dispose(timeoutMs = 10_000): Promise<number | null> {
		try {
			this.process.stdin.end();
		} catch {}
		const timer = setTimeout(() => this.process.kill(), timeoutMs);
		const exitCode = await this.process.exited.catch(() => null);
		clearTimeout(timer);
		await this.#ownedRoot?.remove();
		return exitCode;
	}

	async #pumpStdout(): Promise<void> {
		try {
			for await (const frame of readJsonl<unknown>(this.process.stdout as ReadableStream<Uint8Array>)) {
				if (!isRecord(frame)) continue;
				this.frames.push(frame);
				const matched = this.#waiters.filter(waiter => waiter.predicate(frame));
				this.#waiters = this.#waiters.filter(waiter => !matched.includes(waiter));
				for (const waiter of matched) waiter.resolve(frame);
			}
		} finally {
			this.#closed.resolve();
		}
	}

	async #pumpStderr(): Promise<void> {
		const decoder = new TextDecoder();
		for await (const chunk of this.process.stderr as ReadableStream<Uint8Array>) {
			this.#stderr += decoder.decode(chunk, { stream: true });
		}
	}
}
