import { expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { $ } from "bun";
import { compileCodingAgent } from "../scripts/compile-binary";

it("runs compiled bytecode containing dependency import.meta.resolve calls", async () => {
	using temp = TempDir.createSync("@omp-bytecode-");
	const entrypoint = temp.join("entry.ts");
	const outfile = temp.join(process.platform === "win32" ? "probe.exe" : "probe");
	await Bun.write(entrypoint, 'console.log(import.meta.resolve("node:fs"));\n');
	await compileCodingAgent({
		repoRoot: temp.path(),
		entrypoint,
		outfile,
		buildInfo: { gitSha: null, dirty: null },
		native: null,
	});
	const result = await $`${outfile}`.quiet().nothrow();
	expect(result.exitCode).toBe(0);
	expect(result.text().trim()).toBe("node:fs");
}, 30_000);

it("runs code behind a lazy import() from a split chunk of the compiled binary", async () => {
	using temp = TempDir.createSync("@omp-split-chunk-");
	const entrypoint = temp.join("entry.ts");
	const outfile = temp.join(process.platform === "win32" ? "probe.exe" : "probe");
	// The dynamic import is the chunk boundary: lazy.ts becomes a separate embedded chunk.
	await Bun.write(temp.join("lazy.ts"), 'export const value = ["lazy", "chunk"].join(" ");\n');
	await Bun.write(entrypoint, 'const { value } = await import("./lazy.ts");\nconsole.log(value);\n');
	await compileCodingAgent({
		repoRoot: temp.path(),
		entrypoint,
		outfile,
		buildInfo: { gitSha: null, dirty: null },
		native: null,
	});
	const result = await $`${outfile}`.quiet().nothrow();
	expect(result.exitCode).toBe(0);
	expect(result.text().trim()).toBe("lazy chunk");
}, 30_000);
