import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import type { BunPlugin } from "bun";
import { getTemplate, resolveBundledHtmlAssetPath } from "../src/export/html/index";
import vendorNotices from "../src/export/html/vendor/NOTICE" with { type: "text" };

const bundleDistUrl = new URL("../scripts/bundle-dist.ts", import.meta.url).href;
const probePath = path.resolve(import.meta.dir, "fixtures", "html-export-template-probe.ts");
const packageDir = path.resolve(import.meta.dir, "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-html-template-"));
const unrelatedCwd = path.join(tempRoot, "unrelated-cwd");
const bundleDir = path.join(tempRoot, "bundle");
const compiledPath = path.join(tempRoot, "compiled-template-probe");
let bundlePath: string;
const dependencyStubs: Record<string, string> = {
	"@oh-my-pi/omp-stats/trace":
		'export const buildSessionTraceFromSnapshots = () => { throw new Error("Trace assembly is outside the template probe"); };',
	"@oh-my-pi/pi-utils": 'export const APP_NAME = "npi"; export const isEnoent = err => err?.code === "ENOENT";',
	"@oh-my-pi/pi-tui/theme":
		"export const getResolvedThemeColors = async () => ({}); export const getThemeExportColors = async () => ({});",
	"../../session/sub-sessions": "export const collectSubSessions = async () => ({});",
	"../../session/session-manager":
		"export class SessionManager { static async open() { return new SessionManager(); } }",
};
const focusedBundlePlugin: BunPlugin = {
	name: "html-template-focused-bundle",
	setup(build) {
		build.onResolve({ filter: /.*/ }, args =>
			dependencyStubs[args.path] === undefined ? undefined : { path: args.path, namespace: "template-probe-stub" },
		);
		build.onLoad({ filter: /.*/, namespace: "template-probe-stub" }, args => ({
			contents: dependencyStubs[args.path]!,
			loader: "js",
		}));
	},
};

async function runProbe(command: string[]): Promise<string> {
	const proc = Bun.spawn(command, { cwd: unrelatedCwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return stdout;
}

beforeAll(async () => {
	await fs.mkdir(unrelatedCwd);
	const bundle = await Bun.build({
		entrypoints: [probePath],
		outdir: bundleDir,
		target: "bun",
		plugins: [focusedBundlePlugin],
		define: { "process.env.PI_BUNDLED": '"true"' },
	});
	if (!bundle.success) throw new AggregateError(bundle.logs, "Template probe bundle failed");
	const entrypoint = bundle.outputs.find(output => output.kind === "entry-point");
	if (!entrypoint) throw new Error("Template probe emitted no entry point");
	bundlePath = entrypoint.path;
	const compiled = await Bun.build({
		entrypoints: [probePath],
		target: "bun",
		plugins: [focusedBundlePlugin],
		define: { "process.env.PI_BUNDLED": '"true"' },
		compile: { outfile: compiledPath },
	});
	if (!compiled.success) throw new AggregateError(compiled.logs, "Compiled template probe failed");
}, 120_000);

afterAll(async () => {
	await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("HTML export template", () => {
	test("source exports embed the viewer and both libraries from an unrelated directory", async () => {
		const html = getTemplate();
		const { document } = parseHTML(html);
		expect(document.querySelectorAll("script[src]")).toHaveLength(0);
		expect(document.querySelectorAll('script:not([type="application/json"])')).toHaveLength(4);
		expect(document.querySelector("#third-party-notices pre")?.textContent).toBe(vendorNotices);
		expect(html).toBe(await runProbe([process.execPath, probePath]));
	});

	test("resolves file-loader assets without parsing Windows drive letters as URLs", () => {
		expect(resolveBundledHtmlAssetPath("C:\\exports\\viewer.js", "/module")).toBe("C:\\exports\\viewer.js");
		expect(resolveBundledHtmlAssetPath("/exports/viewer.js", "/module")).toBe("/exports/viewer.js");
		expect(resolveBundledHtmlAssetPath("viewer.js", "/module")).toBe(path.resolve("/module", "viewer.js"));
	});

	test("packaged exports embed the same viewer without network scripts", async () => {
		const html = await runProbe([process.execPath, bundlePath]);
		const { document } = parseHTML(html);
		expect(document.querySelectorAll("script[src]")).toHaveLength(0);
		expect(html).toBe(getTemplate());
	});

	test("npm-style bundle and compiled binary export identical standalone HTML", async () => {
		const expected = await runProbe([process.execPath, bundlePath]);
		expect(await runProbe([compiledPath])).toBe(expected);
		const sidecars = (await fs.readdir(bundleDir)).filter(name => name !== path.basename(bundlePath));
		expect(sidecars).toHaveLength(3);
		for (const name of sidecars) {
			expect(name).toMatch(/^(?:(?:viewer|marked)\.generated|highlight\.min)-[^.]+\.js$/);
		}
	});

	test("npm packages retain standalone sidecars but omit source-only viewer build inputs", async () => {
		const productionDir = path.join(tempRoot, "production-bundle");
		const staleAsset = path.join(productionDir, "template-stale.css");
		await Bun.write(staleAsset, "obsolete viewer sidecar");
		const runner = path.join(tempRoot, "bundle-dist-runner.ts");
		await Bun.write(
			runner,
			`import { bundleDist } from ${JSON.stringify(bundleDistUrl)};\nawait bundleDist(${JSON.stringify(productionDir)});\n`,
		);
		const proc = Bun.spawn([process.execPath, runner], {
			cwd: packageDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
		expect(await Bun.file(staleAsset).exists()).toBe(false);

		const packRoot = path.join(tempRoot, "production-workspace");
		const packDir = path.join(packRoot, "packages", "coding-agent");
		const workspace: { workspaces: { packages: string[]; catalog: Record<string, string> } } = await Bun.file(
			path.resolve(packageDir, "../../package.json"),
		).json();
		workspace.workspaces.packages = ["packages/coding-agent"];
		await Bun.write(path.join(packRoot, "package.json"), JSON.stringify(workspace));
		await Bun.write(path.join(packRoot, "bun.lock"), Bun.file(path.resolve(packageDir, "../../bun.lock")));
		await Bun.write(path.join(packDir, "package.json"), Bun.file(path.join(packageDir, "package.json")));
		await fs.cp(productionDir, path.join(packDir, "dist"), { recursive: true });
		await fs.cp(path.join(packageDir, "src/export/html"), path.join(packDir, "src/export/html"), { recursive: true });
		const pack = Bun.spawn([process.execPath, "pm", "pack", "--dry-run", "--ignore-scripts"], {
			cwd: packDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [packOut, packErr, packExit] = await Promise.all([
			new Response(pack.stdout).text(),
			new Response(pack.stderr).text(),
			pack.exited,
		]);
		expect(packExit, packErr).toBe(0);
		const packed = Array.from(packOut.matchAll(/^packed \S+ (.+)$/gm), match => match[1]);
		expect(packed).toContain("src/export/html/template.html.txt");
		expect(packed).toContain("src/export/html/viewer.generated.json");
		expect(packed).toContain("src/export/html/viewer.generated.js");
		expect(packed).toContain("src/export/html/marked.generated.js");
		expect(packed).toContain("src/export/html/vendor/highlight.min.js");
		expect(packed).toContain("src/export/html/vendor/NOTICE");
		for (const name of ["shell.html", "template.css", "template.js", "share-loader.js"]) {
			expect(packed).not.toContain(`src/export/html/${name}`);
		}
		const sidecars = packed.filter(file => /^dist\/(?:(?:viewer|marked)\.generated|highlight\.min)-/.test(file));
		expect(sidecars).toHaveLength(3);
		expect(packed.filter(file => /^dist\/(?:template-|tool-views\.)/.test(file))).toEqual([]);
	}, 60_000);
});
