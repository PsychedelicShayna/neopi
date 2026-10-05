import type { Subprocess } from "bun";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildNonInteractiveEnv, NON_INTERACTIVE_ENV } from "@oh-my-pi/pi-coding-agent/exec/non-interactive-env";

describe("buildNonInteractiveEnv", () => {
	it("defaults Windows child-process encoding to UTF-8 when inherited env is unset", () => {
		const env = buildNonInteractiveEnv(undefined, {}, "win32");

		expect(env.PYTHONIOENCODING).toBe("utf-8");
		expect(env.PYTHONUTF8).toBe("1");
		expect(env.LANG).toBe("C.UTF-8");
		expect(env.LC_ALL).toBe("C.UTF-8");
	});

	it("preserves inherited Windows encoding groups as user-owned", () => {
		const env = buildNonInteractiveEnv(undefined, { PYTHONUTF8: "0", LANG: "de_DE.UTF-8" }, "win32");

		expect(env.PYTHONIOENCODING).toBeUndefined();
		expect(env.PYTHONUTF8).toBeUndefined();
		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
	});

	it("preserves per-command Windows encoding groups as user-owned", () => {
		const env = buildNonInteractiveEnv({ PYTHONUTF8: "0", LC_ALL: "en_US.UTF-8" }, {}, "win32");

		expect(env.PYTHONIOENCODING).toBeUndefined();
		expect(env.PYTHONUTF8).toBe("0");
		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBe("en_US.UTF-8");
	});

	it("preserves inherited Windows LC category locales as user-owned", () => {
		const env = buildNonInteractiveEnv(undefined, { LC_CTYPE: "en_US.UTF-8" }, "win32");

		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
	});

	it("does not force UTF-8 encoding defaults on non-Windows platforms", () => {
		const env = buildNonInteractiveEnv(undefined, {}, "linux");

		expect(env.PYTHONIOENCODING).toBeUndefined();
		expect(env.PYTHONUTF8).toBeUndefined();
		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
	});

	it("does not invent a bogus GPG_TTY", () => {
		const env = buildNonInteractiveEnv(undefined, {}, "linux");

		expect(env).not.toHaveProperty("GPG_TTY");
	});

	it("preserves per-command GPG_TTY overrides", () => {
		const env = buildNonInteractiveEnv({ GPG_TTY: "/dev/pts/7" }, {}, "linux");

		expect(env.GPG_TTY).toBe("/dev/pts/7");
	});

	it("uses an executable SSH askpass rejector on POSIX", async () => {
		if (process.platform === "win32") return;
		const proc = Bun.spawn([NON_INTERACTIVE_ENV.SSH_ASKPASS], {
			stdout: "ignore",
			stderr: "ignore",
		});

		expect(await proc.exited).toBe(1);
	});

	it("injects clap-compatible CI=true by default", () => {
		expect(buildNonInteractiveEnv(undefined, {}, "linux").CI).toBe("true");
		expect(buildNonInteractiveEnv(undefined, {}, "win32").CI).toBe("true");
	});

	it("drops CI when PI_BASH_NO_CI or its legacy alias is set", () => {
		expect(buildNonInteractiveEnv(undefined, { PI_BASH_NO_CI: "1" }, "linux")).not.toHaveProperty("CI");
		expect(buildNonInteractiveEnv(undefined, { CLAUDE_BASH_NO_CI: "1" }, "linux")).not.toHaveProperty("CI");
		expect(buildNonInteractiveEnv(undefined, { PI_BASH_NO_CI: "1" }, "win32")).not.toHaveProperty("CI");
	});

	it("lets a per-command CI override win over the opt-out", () => {
		expect(buildNonInteractiveEnv({ CI: "0" }, { PI_BASH_NO_CI: "1" }, "linux").CI).toBe("0");
	});
});

it("filters expanded dotenv values while preserving matching and empty launcher values", async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-env-"));
	try {
		await Bun.write(
			path.join(tmp, ".env"),
			[
				"BASE=loaded-by-omp",
				"EMPTY_PARENT_VAR=project-secret",
				"TEST_ENV_FROM_DOTENV=$BASE-suffix",
				"NODE_ENV=development",
				"export EXPORTED_SECRET=exported",
				"COMMENTED_SECRET=secret # trailing comment",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(tmp, ".env.local"),
			"CONVEX_DEPLOYMENT=anonymous:root-local\nCONVEX_URL=http://127.0.0.1:3210\n",
		);
		const procmgrPath = path.resolve(import.meta.dir, "../../utils/src/procmgr.ts");
		const script = [
			`import { getShellConfig } from ${JSON.stringify(procmgrPath)};`,
			"const env = getShellConfig().env;",
			"console.log(JSON.stringify({",
			"	project: env.TEST_ENV_FROM_DOTENV ?? null,",
			"	deployment: env.CONVEX_DEPLOYMENT ?? null,",
			"	url: env.CONVEX_URL ?? null,",
			"	inherited: env.OMP_TEST_INHERITED_MARKER ?? null,",
			"	empty: env.EMPTY_PARENT_VAR ?? null,",
			"	matching: env.NODE_ENV ?? null,",
			"	exported: env.EXPORTED_SECRET ?? null,",
			"	commented: env.COMMENTED_SECRET ?? null,",
			"}));",
		].join("\n");
		const bunArgSets = process.platform === "linux" ? [[], ["--no-env-file"]] : [["--no-env-file"]];
		for (const bunArgs of bunArgSets) {
			const proc = Bun.spawn([process.execPath, ...bunArgs, "--no-install", "--eval", script], {
				cwd: tmp,
				env: {
					HOME: process.env.HOME ?? "",
					EMPTY_PARENT_VAR: "",
					OMP_TEST_INHERITED_MARKER: "keep-me",
					NODE_ENV: "development",
					PATH: process.env.PATH ?? "",
					SHELL: process.env.SHELL ?? "/bin/bash",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			const payload: {
				project: string | null;
				deployment: string | null;
				url: string | null;
				inherited: string | null;
				empty: string | null;
				matching: string | null;
				exported: string | null;
				commented: string | null;
			} = JSON.parse(stdout);
			expect(payload).toEqual({
				project: null,
				deployment: null,
				url: null,
				inherited: "keep-me",
				matching: "development",
				empty: "",
				exported: null,
				commented: null,
			});
		}
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
});

it("restores launcher editor and credentials for interactive children without unsanitizing tool commands", async () => {
	if (process.platform === "win32") return;
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-host-env-"));
	try {
		await Bun.write(path.join(tmp, ".env"), "HOST_ENV_DOTENV_SECRET=project-only\n");
		const hostModule = path.resolve(import.meta.dir, "../src/exec/host-env.ts");
		const toolModule = path.resolve(import.meta.dir, "../src/exec/non-interactive-env.ts");
		const selected = [
			"EDITOR", "VISUAL", "SSH_ASKPASS", "SUDO_ASKPASS", "TERM", "CI", "GIT_EDITOR",
			"HOST_ENV_DOTENV_SECRET", "HOST_ENV_LITERAL",
		];
		const probe = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(selected)}.map(key => [key, process.env[key] ?? null]))))`;
		const script = [
			`import { getHostEnvForTools } from ${JSON.stringify(hostModule)};`,
			`import { buildNonInteractiveEnv } from ${JSON.stringify(toolModule)};`,
			`import { filterChildShellEnv } from ${JSON.stringify(path.resolve(import.meta.dir, "../../utils/src/env.ts"))};`,
			'process.env.EDITOR = "true"; process.env.TERM = "dumb";',
			"const host = await getHostEnvForTools();",
			"const env = { ...filterChildShellEnv(process.env), ...buildNonInteractiveEnv(host) };",
			`const run = async restored => {`,
			`	const child = Bun.spawn(["/bin/sh", "-c", restored ? '. "$OMP_HOST_ENV_FILE"; exec "$@"' : 'exec "$@"', "probe", process.execPath, "--no-env-file", "--eval", ${JSON.stringify(probe)}], { env, stdout: "pipe", stderr: "pipe" });`,
			"	const output = await new Response(child.stdout).text();",
			"	if (await child.exited !== 0) throw new Error(await new Response(child.stderr).text());",
			"	return JSON.parse(output);",
			"};",
			"const stat = await Bun.file(host.OMP_HOST_ENV_FILE).stat();",
			"console.log(JSON.stringify({ tool: await run(false), restored: await run(true), file: host.OMP_HOST_ENV_FILE, mode: stat.mode & 0o777, editor: host.OMP_HOST_EDITOR, term: host.OMP_HOST_TERM }));",
		].join("\n");
		const literal = "spaces 'quotes' $dollars `backticks`\nand a newline";
		const child = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd: tmp,
			env: {
				HOME: tmp, PI_CONFIG_DIR: ".omp", XDG_STATE_HOME: "", XDG_CACHE_HOME: "", XDG_DATA_HOME: "",
				PATH: process.env.PATH ?? "", SHELL: "/bin/sh",
				EDITOR: "nvim", VISUAL: "", SSH_ASKPASS: "/host/askpass", TERM: "xterm-256color",
				HOST_ENV_LITERAL: literal,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
		]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout);
		expect(result.tool.EDITOR).toBe("true");
		expect(result.tool.VISUAL).toBe("true");
		expect(result.tool.SSH_ASKPASS).toBe(NON_INTERACTIVE_ENV.SSH_ASKPASS);
		expect(result.tool.TERM).toBe("xterm-256color");
		expect(result.restored).toEqual({
			EDITOR: "nvim", VISUAL: "", SSH_ASKPASS: "/host/askpass", SUDO_ASKPASS: null,
			TERM: "xterm-256color", CI: null, GIT_EDITOR: null,
			HOST_ENV_DOTENV_SECRET: null, HOST_ENV_LITERAL: literal,
		});
		expect(result.editor).toBe("nvim");
		expect(result.term).toBe("xterm-256color");
		expect(result.mode).toBe(0o600);
		expect(await Bun.file(result.file).exists()).toBe(false);
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
});

it("excludes autoloaded project credentials from host restoration when the launch environment is unavailable", async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-host-fallback-"));
	try {
		await Bun.write(path.join(tmp, ".env"), "HOST_ENV_PROJECT_SECRET=project-only\nBASE=loaded\nHOST_ENV_EXPANDED=$BASE-secret\n");
		const hostModule = path.resolve(import.meta.dir, "../src/exec/host-env.ts");
		const script = [
			'import { spyOn } from "bun:test";',
			'import * as fs from "node:fs";',
			"const originalRead = fs.readFileSync;",
			'spyOn(fs, "readFileSync").mockImplementation((file, ...args) => { if (file === "/proc/self/environ") throw new Error("procfs unavailable"); return originalRead(file, ...args); });',
			`const { getHostEnvForTools } = require(${JSON.stringify(hostModule)});`,
			"const host = await getHostEnvForTools();",
			'const text = await Bun.file(host.OMP_HOST_ENV_FILE).text();',
			'console.log(JSON.stringify({ secret: text.includes("HOST_ENV_PROJECT_SECRET"), expanded: text.includes("HOST_ENV_EXPANDED"), editor: host.OMP_HOST_EDITOR }));',
		].join("\n");
		const child = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd: tmp,
			env: { HOME: tmp, PI_CONFIG_DIR: ".omp", XDG_STATE_HOME: "", XDG_CACHE_HOME: "", XDG_DATA_HOME: "", PATH: process.env.PATH ?? "", EDITOR: "nvim" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
		]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ secret: false, expanded: false, editor: "nvim" });
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
});

it("prunes host credentials abandoned by SIGKILL without deleting live launch snapshots", async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-host-crash-"));
	const children: Subprocess[] = [];
	try {
		const hostModule = path.resolve(import.meta.dir, "../src/exec/host-env.ts");
		const script = [
			`import { getHostEnvForTools } from ${JSON.stringify(hostModule)};`,
			"console.log((await getHostEnvForTools()).OMP_HOST_ENV_FILE);",
			"await Bun.sleep(60000);",
		].join("\n");
		const launch = async () => {
			const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "--eval", script], {
				cwd: tmp,
				env: { HOME: tmp, PI_CONFIG_DIR: ".omp", XDG_STATE_HOME: "", XDG_CACHE_HOME: "", XDG_DATA_HOME: "", PATH: process.env.PATH ?? "", HOST_PRIVATE_CREDENTIAL: "private" },
				stdout: "pipe",
				stderr: "inherit",
			});
			children.push(child);
			const reader = child.stdout.getReader();
			const { value } = await reader.read();
			reader.releaseLock();
			return { child, file: new TextDecoder().decode(value).trim() };
		};
		const abandoned = await launch();
		abandoned.child.kill("SIGKILL");
		await abandoned.child.exited;
		expect(await Bun.file(abandoned.file).exists()).toBe(true);
		const live = await launch();
		expect(await Bun.file(abandoned.file).exists()).toBe(false);
		await launch();
		expect(await Bun.file(live.file).text()).toContain("HOST_PRIVATE_CREDENTIAL='private'");
	} finally {
		for (const child of children) child.kill("SIGKILL");
		await Promise.all(children.map(child => child.exited));
		await fs.rm(tmp, { recursive: true, force: true });
	}
});
