import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const pkgRoot = path.resolve(import.meta.dir, "..");

async function importedModules(entry: string): Promise<string[]> {
	const probe = `await import(${JSON.stringify(path.join(pkgRoot, entry))});
		const reg = typeof Loader !== "undefined" && Loader.registry ? [...Loader.registry.keys()] : Object.keys(require.cache);
		console.log(JSON.stringify(reg));`;
	const proc = Bun.spawn([process.execPath, "-e", probe], { cwd: pkgRoot, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(code, err).toBe(0);
	const registry: string[] = JSON.parse(out.trim().split("\n").at(-1)!);
	// Windows registry keys use `\`; normalize so the path assertions below are portable.
	return registry.map(module => module.replaceAll("\\", "/"));
}

function expectGraphExcludes(modules: string[], forbidden: RegExp[]): void {
	const violations = modules.filter(module => forbidden.some(pattern => pattern.test(module)));
	expect(violations).toEqual([]);
}

describe("startup composer prepaint graph", () => {
	it("keeps CLI bootstrap isolated from command, worker, provider, and failure-runtime graphs", async () => {
		const modules = await importedModules("src/cli.ts");

		// Positive control: the CLI entry was evaluated.
		expect(modules.some(module => module.endsWith("/src/cli.ts"))).toBe(true);
		expectGraphExcludes(modules, [
			/commands\/launch/,
			/eval\/js\/worker-core/,
			/eval\/js\/shared\/runtime/,
			/eval\/preludes/,
			/tools\/browser\/aria/,
			/provider-models/,
			/providers\/.*auth/,
			/modes\/interactive-mode/,
			/postmortem/,
			/node:inspector/,
			/node:readline/,
			/node:worker_threads/,
			/omptype/,
			// The native addon costs tens of ms to load; the parent watchdog the
			// entry imports statically must not pull it in.
			/pi-natives|natives\/native/,
		]);
	});
});
