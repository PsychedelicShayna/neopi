import { expect, test } from "bun:test";
import * as path from "node:path";
import { readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import type { RpcFrame } from "./helpers/rpc-child";

async function withRuntime(
	scenario: string,
	run: (runtime: {
		child: Bun.Subprocess<"pipe", "pipe", "pipe">;
		until: (predicate: (frame: RpcFrame) => boolean) => Promise<RpcFrame>;
		stderr: Promise<string>;
	}) => Promise<void>,
): Promise<void> {
	await using root = await TempDir.create("@rpc-eof-runtime-");
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/rpc-eof-runtime.ts"), scenario], {
		cwd: root.path(),
		env: {
			PATH: Bun.env.PATH,
			BUN_BE_BUN: "1",
			HOME: root.join("home"),
			PI_CODING_AGENT_DIR: root.join("agent"),
			XDG_CONFIG_HOME: root.join("config"),
			XDG_DATA_HOME: root.join("data"),
			XDG_CACHE_HOME: root.join("cache"),
			PI_NO_TITLE: "1",
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 30_000,
		killSignal: "SIGKILL",
	});
	const stderr = new Response(child.stderr).text();
	const frames = readJsonl<RpcFrame>(child.stdout)[Symbol.asyncIterator]();
	const seen: RpcFrame[] = [];
	const until = async (predicate: (frame: RpcFrame) => boolean): Promise<RpcFrame> => {
		const found = seen.find(predicate);
		if (found) return found;
		while (true) {
			const next = await frames.next();
			if (next.done) throw new Error(`RPC exited before expected frame: ${await stderr}`);
			seen.push(next.value);
			if (predicate(next.value)) return next.value;
		}
	};
	try {
		if (scenario !== "clock") {
			// A correlated response proves that startup (not just the early ready frame) finished.
			child.stdin.write(`${JSON.stringify({ type: "get_state", id: "initialized" })}\n`);
			await child.stdin.flush();
			await until(frame => frame.type === "response" && frame.id === "initialized");
		}
		await run({ child, until, stderr });
	} finally {
		child.kill("SIGKILL");
		await child.exited;
		await frames.return?.(undefined);
		await stderr;
	}
}

test("the EOF hard exit fires at exactly ten seconds during startup", async () => {
	await withRuntime("clock", async ({ child, until }) => {
		await until(frame => frame.type === "fixture_phase" && frame.name === "deadline-at-10000");
		expect(await child.exited).toBe(0);
	});
}, 45_000);

async function expectForcedExit(child: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
	// This subprocess contract deliberately measures real OS pipe/exit behavior; fake timers cannot drive it.
	const started = performance.now();
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error("RPC exceeded the EOF ceiling")), 12_000);
	try {
		child.stdin.end();
		expect(await Promise.race([child.exited, timeout.promise])).toBe(129);
		expect(performance.now() - started).toBeLessThan(12_000);
	} finally {
		clearTimeout(timer);
	}
}

test("the EOF deadline covers the first pending host-tool revocation", async () => {
	await withRuntime("revoke", async ({ child, until }) => {
		await Promise.all([
			expectForcedExit(child),
			until(frame => frame.type === "fixture_phase" && frame.name === "revoke"),
		]);
	});
}, 45_000);

test("the EOF deadline covers the first pending live controller stop", async () => {
	await withRuntime("live", async ({ child, until }) => {
		child.stdin.write(`${JSON.stringify({ type: "live_start", id: "live" })}\n`);
		await child.stdin.flush();
		expect(await until(frame => frame.type === "response" && frame.id === "live")).toMatchObject({ success: true });
		await Promise.all([
			expectForcedExit(child),
			until(frame => frame.type === "fixture_phase" && frame.name === "live-stop"),
		]);
	});
}, 45_000);

test.each(["stdout", "failure-stdout"])(
	"the EOF deadline survives cooperative teardown with a stalled %s sink",
	async scenario => {
		await withRuntime(scenario, async ({ child }) => {
			// Keep the pipe open, but do not consume any more frames: four MiB exceeds its capacity.
			for (let id = 0; id < 128; id++) {
				child.stdin.write(`${JSON.stringify({ type: "get_state", id: `${id}:${"x".repeat(32768)}` })}\n`);
			}
			await child.stdin.flush();
			await expectForcedExit(child);
		});
	},
	45_000,
);

test("the EOF deadline covers a latched persistence failure's blocked stderr mirror", async () => {
	await withRuntime("stderr", async ({ child, until }) => {
		await Promise.all([
			expectForcedExit(child),
			until(frame => frame.type === "fixture_phase" && frame.name === "stderr"),
		]);
	});
}, 45_000);

test("a completed persistence failure still drains its notice and exits with code one", async () => {
	await withRuntime("normal-failure", async ({ child, until, stderr }) => {
		child.stdin.end();
		await until(frame => frame.type === "notice" && frame.source === "session-persistence");
		expect(await child.exited).toBe(1);
		expect(await stderr).toContain("ENOSPC: EOF fixture persistence failure");
	});
}, 45_000);
