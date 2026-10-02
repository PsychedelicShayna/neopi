import * as path from "node:path";
import type { BunPlugin } from "bun";

const [mode, destination] = process.argv.slice(2);
if ((mode !== "bundle" && mode !== "compile") || !destination) {
	throw new Error("Expected bundle or compile and an output destination");
}
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const stubPath = path.join(import.meta.dir, "changelog-utils-stub.ts");
// Native loading is outside the emitted changelog asset contract.
const plugin: BunPlugin = {
	name: "changelog-utils-stub",
	setup(build) {
		build.onResolve({ filter: /^@oh-my-pi\/pi-utils$/ }, () => ({ path: stubPath }));
		build.onResolve({ filter: /^\.\.\/config$/ }, args =>
			args.importer.endsWith("/utils/changelog.ts") ? { path: stubPath } : undefined,
		);
	},
};
const result = await Bun.build({
	entrypoints: [path.join(import.meta.dir, "changelog-bundle-fallback-probe.ts")],
	root: repoRoot,
	target: "bun",
	external: ["omp-legacy-pi-modules"],
	plugins: [plugin],
	...(mode === "compile"
		? {
				compile: {
					outfile: destination,
					autoloadBunfig: false,
					autoloadDotenv: false,
					autoloadTsconfig: false,
					autoloadPackageJson: false,
				},
			}
		: { outdir: destination }),
});
if (!result.success) throw new Error(result.logs.map(log => log.message).join("\n"));
const output = mode === "compile" ? destination : result.outputs.find(output => output.kind === "entry-point")?.path;
if (!output) throw new Error("Changelog build did not emit an entrypoint");
process.stdout.write(JSON.stringify(output));
