import { expect, it } from "bun:test";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

it.skipIf(process.platform === "win32")(
	"Ctrl+D force-exits while committed shutdown waits for process cleanup",
	async () => {
		using tempDir = TempDir.createSync("@omp-committed-shutdown-");
		const ready = Promise.withResolvers<void>();
		const menu = Promise.withResolvers<void>();
		const cleaningUp = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const decoder = new TextDecoder();
		let output = "";
		await using terminal = new Bun.Terminal({
			cols: 120,
			rows: 32,
			data(_terminal, bytes) {
				output += decoder.decode(bytes, { stream: true });
				if (output.includes("committed-shutdown: ready")) ready.resolve();
				if (output.includes("Agent Menu")) menu.resolve();
				if (output.includes("committed-shutdown: cleanup started")) cleaningUp.resolve();
			},
			exit() {
				closed.resolve();
			},
		});
		const proc = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/committed-shutdown-tui.ts`], {
			cwd: tempDir.path(),
			env: {
				...process.env,
				HOME: tempDir.path(),
				PI_CODING_AGENT_DIR: tempDir.path(),
				OMP_TUI_DEBUG: undefined,
				PI_TEST_RUNTIME: undefined,
				BUN_ENV: undefined,
				NODE_ENV: undefined,
				TERM: "xterm-256color",
				TERM_PROGRAM: undefined,
				OMP_TUI_NATIVE: "0",
				PI_TUI_NATIVE: "0",
			},
			terminal,
		});
		const prematureExit = proc.exited.then(code => {
			throw new Error(`Shutdown PTY fixture exited early (status ${code}): ${Bun.stripANSI(output)}`);
		});
		try {
			await Promise.race([ready.promise, prematureExit]);
			terminal.write("keep me\x04");
			await Promise.race([menu.promise, prematureExit]);
			terminal.write("\r");
			await Promise.race([cleaningUp.promise, prematureExit]);

			const beforeForce = output.length;
			terminal.write("\x04");
			const exitCode = await withTimeout(proc.exited, 1000, "Ctrl+D did not interrupt process cleanup");
			expect(exitCode).toBe(130);
			terminal.close();
			await closed.promise;
			const finalOutput = output.slice(beforeForce);
			expect(finalOutput).toContain("\x1b[?2004l");
			expect(finalOutput).not.toContain("Agent Menu");
		} finally {
			if (proc.exitCode === null) proc.kill();
			await proc.exited;
		}
	},
	30_000,
);
