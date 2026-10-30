#!/usr/bin/env bun

import * as path from "node:path";
import { $ } from "bun";

const RUST_AFFECTING_FILE_NAMES = [
	"Cargo.toml",
	"Cargo.lock",
	"build.rs",
	"rust-toolchain",
	"rust-toolchain.toml",
	"clippy.toml",
	".clippy.toml",
	"rustfmt.toml",
	".rustfmt.toml",
] as const satisfies readonly string[];
// Vendored path-patched crates are workspace members for Bazel hermeticity
// (path-patch rendering is machine-local), but cargo dev tasks keep their
// historical scope: the forks are not held to workspace format/lint/test gates.
//
// pi-builtins is NOT excluded. It is first-party, and although it opts out of
// the workspace's pedantic/nursery lints in its own manifest (most of it is
// ported third-party code), it is held to default clippy and to zero rustc
// warnings like everything else.
const VENDORED_FORK_EXCLUDES = [
	"--exclude",
	"brush-core",
	"--exclude",
	"brush-parser",
	"--exclude",
	"cfg_aliases",
	"--exclude",
	"napi",
] as const satisfies readonly string[];
// grep-searcher's upstream ripgrep code predates the workspace clippy policy, but
// the fork's own `search_push` (src/searcher/push.rs, see its README.md) carries
// tests, so it is exempt from the lint gates only and still runs under test:rs.
const LINT_EXEMPT_FORK_EXCLUDES = [
	...VENDORED_FORK_EXCLUDES,
	"--exclude",
	"grep-searcher",
] as const satisfies readonly string[];
const TASK_COMMANDS = {
	"check:rs": [
		["cargo", "fmt", "--all", "--", "--check"],
		["cargo", "clippy", "--workspace", ...LINT_EXEMPT_FORK_EXCLUDES, "--no-deps", "--", "-D", "warnings"],
	],
	"fix:rs": [
		["cargo", "fmt", "--all"],
		[
			"cargo",
			"clippy",
			"--workspace",
			...LINT_EXEMPT_FORK_EXCLUDES,
			"--fix",
			"--allow-dirty",
			"--no-deps",
			"--allow-staged",
			"--allow-no-vcs",
		],
	],
	"fmt:rs": [["cargo", "fmt", "--all"]],
	"lint:rs": [["cargo", "clippy", "--workspace", ...LINT_EXEMPT_FORK_EXCLUDES, "--no-deps", "--", "-D", "warnings"]],
	"test:rs": rustTestCommands([]),
} as const satisfies Record<string, readonly (readonly string[])[]>;

type RustTaskName = keyof typeof TASK_COMMANDS;

const repoRoot = path.join(import.meta.dir, "..");
const taskName = process.argv[2];

if (import.meta.main) {
	if (!isRustTaskName(taskName)) {
		console.error(`Unknown Rust task: ${taskName ?? "(missing)"}`);
		process.exit(1);
	}

	const commands = taskName === "test:rs" ? rustTestCommands(process.argv.slice(3)) : TASK_COMMANDS[taskName];
	if (taskName !== "fmt:rs" && !(isCI() || (await hasRustAffectingChanges()))) {
		console.log(`Skipping ${taskName} (not in CI and no Rust-affecting changes were found).`);
		process.exit(0);
	}

	for (const command of commands) {
		const exitCode = await runCommand(command);
		if (exitCode !== 0) {
			process.exit(exitCode);
		}
	}
}

/** Scope both test passes together; remaining options belong to nextest only. */
export function rustTestCommands(args: readonly string[]): readonly (readonly string[])[] {
	let packageName: string | undefined;
	const nextestArgs: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--package") {
			const value = args[++index];
			if (packageName || !value || value.startsWith("-")) {
				throw new Error("test:rs accepts one --package <crate>");
			}
			packageName = value;
		} else {
			nextestArgs.push(arg);
		}
	}
	const scope = packageName ? ["--package", packageName] : ["--workspace", ...VENDORED_FORK_EXCLUDES];
	return [
		["cargo", "nextest", "run", ...scope, "--status-level=fail", "--final-status-level=fail", ...nextestArgs],
		// nextest cannot run doctests. Keep the libtest pass on the same package
		// scope, without nextest-only filters/options; cdylib crates have none.
		["cargo", "test", "--doc", ...scope],
	];
}

interface CargoPackage {
	name: string;
	targets: { kind: string[] }[];
}

export function supportsDoctests(pkg: CargoPackage): boolean {
	return pkg.targets.some(target =>
		target.kind.some(kind => ["lib", "rlib", "dylib", "staticlib", "proc-macro"].includes(kind)),
	);
}

function isRustTaskName(value: string | undefined): value is RustTaskName {
	return value != null && value in TASK_COMMANDS;
}

function isCI(): boolean {
	const value = Bun.env.CI;
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

async function hasRustAffectingChanges(): Promise<boolean> {
	const result = await $`git status --porcelain -z`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		const suffix = stderr === "" ? `exit ${result.exitCode}` : stderr;
		console.warn(`Warning: failed to inspect git status: ${suffix}. Running ${taskName} conservatively.`);
		return true;
	}
	return getChangedPathsFromPorcelain(result.stdout).some(isRustAffectingPath);
}

function getChangedPathsFromPorcelain(buf: Uint8Array): string[] {
	const entries = new TextDecoder().decode(buf).split("\0").filter(Boolean);
	const changedPaths: string[] = [];

	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry.length < 4) continue;

		const status = entry.slice(0, 2);
		const changedPath = entry.slice(3);
		if (changedPath !== "") {
			changedPaths.push(changedPath);
		}

		if (status.includes("R") || status.includes("C")) {
			const renamedPath = entries[index + 1];
			if (renamedPath) {
				changedPaths.push(renamedPath);
				index += 1;
			}
		}
	}

	return changedPaths;
}

function isRustAffectingPath(changedPath: string): boolean {
	const normalized = changedPath.replace(/\\/g, "/");
	const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
	return (
		normalized.endsWith(".rs") || normalized.startsWith(".cargo/") || isOneOf(fileName, RUST_AFFECTING_FILE_NAMES)
	);
}

function isOneOf<T extends string>(value: string, values: readonly T[]): value is T {
	return values.some(entry => entry === value);
}

async function resolveCargoBinary(): Promise<string> {
	// On macOS runners, Homebrew's `rustup-init` binary is on PATH before the
	// rustup proxies in `$CARGO_HOME/bin`, and invoking it as `cargo` falls
	// through to its installer mode ("unexpected argument 'nextest' found").
	// Ask rustup directly for the cargo binary in the active toolchain.
	const result = await $`rustup which cargo`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode === 0) {
		const resolved = result.stdout.toString().trim();
		if (resolved !== "") return resolved;
	}
	return "cargo";
}

async function runCommand(command: readonly string[]): Promise<number> {
	const [head, ...rest] = command;
	const cargoBinary = head === "cargo" ? await resolveCargoBinary() : head;
	const isCargo = head === "cargo";
	const argv = isCargo ? [cargoBinary, ...rest] : [head, ...rest];
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	if (isCargo) {
		// Cargo subprocesses (notably `rustc -vV` from `cargo metadata`) resolve
		// via PATH; ensure the active toolchain bin dir wins over Homebrew's
		// rustup-init shadow on macOS runners.
		const toolchainBin = path.dirname(cargoBinary);
		const pathSep = process.platform === "win32" ? ";" : ":";
		const currentPath = env.PATH ?? env.Path ?? "";
		env.PATH = currentPath === "" ? toolchainBin : `${toolchainBin}${pathSep}${currentPath}`;
	}
	if (isCargo && rest[0] === "test" && rest.includes("--doc")) {
		const packageIndex = rest.indexOf("--package");
		if (packageIndex !== -1) {
			const packageName = rest[packageIndex + 1];
			const metadata = await $`${cargoBinary} metadata --no-deps --format-version 1`
				.cwd(repoRoot)
				.env(env)
				.quiet()
				.nothrow();
			if (metadata.exitCode !== 0) {
				console.error(metadata.stderr.toString());
				return metadata.exitCode;
			}
			const workspace: { packages: CargoPackage[] } = metadata.json();
			const pkg = workspace.packages.find(pkg => pkg.name === packageName);
			if (pkg && !supportsDoctests(pkg)) {
				console.log(`Skipping doctests for ${packageName}: no doctest-capable library target.`);
				return 0;
			}
		}
	}
	const proc = Bun.spawn(argv, {
		cwd: repoRoot,
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return proc.exited;
}
