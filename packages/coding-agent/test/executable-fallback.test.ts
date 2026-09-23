import * as path from "node:path";
import * as utils from "@oh-my-pi/pi-utils";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { resolveCliEntryCmd, resolveExecutablePath, resolveWorkerSpawnCmd } from "../src/subprocess/worker-client";

describe("executable fallback on unlinked binary", () => {
	const originalExecPathDesc = Object.getOwnPropertyDescriptor(process, "execPath");
	const originalArgv0Desc = Object.getOwnPropertyDescriptor(process, "argv0");

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalExecPathDesc) {
			Object.defineProperty(process, "execPath", originalExecPathDesc);
		}
		if (originalArgv0Desc) {
			Object.defineProperty(process, "argv0", originalArgv0Desc);
		}
	});

	function setProcessProp(prop: "execPath" | "argv0", value: string): void {
		Object.defineProperty(process, prop, {
			value,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}

	it("launches the healthy compiled binary without invoking fallback lookups", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		vi.spyOn(utils, "isExecutable").mockReturnValue(true);
		const whichSpy = vi.spyOn(utils, "$which");

		expect(resolveCliEntryCmd()).toEqual([process.execPath]);
		expect(resolveWorkerSpawnCmd("__omp_worker_test")).toEqual({
			cmd: [process.execPath, "__omp_worker_test"],
		});
		expect(whichSpy).not.toHaveBeenCalled();
	});

	it("prefers original absolute launcher path over generic PATH match when executable", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		const originalLauncher = "/opt/homebrew/bin/omp";
		const otherOmpInPath = "/usr/local/bin/npi";

		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", originalLauncher);

		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			if (cmd === utils.APP_NAME) return otherOmpInPath;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			return p === originalLauncher || p === otherOmpInPath;
		});

		expect(resolveCliEntryCmd()).toEqual([originalLauncher]);
		expect(resolveWorkerSpawnCmd("__omp_worker_test")).toEqual({
			cmd: [originalLauncher, "__omp_worker_test"],
		});
	});

	it("falls back to PATH when original absolute launcher exists but is not executable", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		const originalLauncher = "/opt/homebrew/bin/omp";
		const otherOmpInPath = "/usr/local/bin/npi";

		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", originalLauncher);

		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			if (cmd === utils.APP_NAME) return otherOmpInPath;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			// Launcher is not executable (e.g. root-owned, mode 0644, or directory)
			return p === otherOmpInPath;
		});

		expect(resolveCliEntryCmd()).toEqual([otherOmpInPath]);
		expect(resolveWorkerSpawnCmd("__omp_worker_test")).toEqual({
			cmd: [otherOmpInPath, "__omp_worker_test"],
		});
	});

	it("does not resolve relative argv0 against the working tree", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "./omp");

		const cwdRogueBinary = path.resolve("./omp");
		vi.spyOn(utils, "$which").mockReturnValue(null);
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			return p === cwdRogueBinary;
		});

		// Relative argv0 must never resolve against cwd; falls back to missingPath gracefully
		expect(resolveExecutablePath()).toBe(missingPath);
	});

	it("does not treat Windows drive-relative paths (e.g. C:omp) as bare commands", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "C:\\Tools\\omp.exe";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "C:omp");

		let whichCalledWith: string | undefined;
		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			whichCalledWith = cmd;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockReturnValue(false);

		resolveExecutablePath();

		// A drive-relative path must not be queried as a bare command.
		expect(whichCalledWith).toBe(utils.APP_NAME);
	});

	it("uses npi after the old executable name is removed, never the upstream omp", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/old/install/bin/omomp";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "omomp");

		const mockUpgradedPath = "/usr/local/bin/npi";
		const upstreamPath = "/usr/local/bin/omp";
		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			if (cmd === "npi") return mockUpgradedPath;
			if (cmd === "omp") return upstreamPath;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			return p === mockUpgradedPath || p === upstreamPath;
		});

		expect(resolveCliEntryCmd()).toEqual([mockUpgradedPath]);
		expect(resolveWorkerSpawnCmd("__omp_worker_test")).toEqual({
			cmd: [mockUpgradedPath, "__omp_worker_test"],
		});
	});

	it("falls back to process.argv0 when the product command is unavailable", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/custom/install/bin/omp";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "my-omp");

		const mockCustomPath = "/usr/local/bin/my-omp";
		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			if (cmd === "my-omp") return mockCustomPath;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			return p === mockCustomPath;
		});

		expect(resolveExecutablePath()).toBe(mockCustomPath);
	});

	it("does not perform fallback lookup when isCompiledBinary is false", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(false);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		setProcessProp("execPath", missingPath);

		const whichSpy = vi.spyOn(utils, "$which");
		vi.spyOn(utils, "isExecutable").mockReturnValue(false);

		const resolved = resolveExecutablePath();
		expect(whichSpy).not.toHaveBeenCalled();
		expect(resolved).toBe(missingPath);
	});

	it("returns original execPath gracefully if no fallback candidate exists", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/nonexistent/omp";
		setProcessProp("execPath", missingPath);
		vi.spyOn(utils, "$which").mockReturnValue(null);
		vi.spyOn(utils, "isExecutable").mockReturnValue(false);

		expect(resolveExecutablePath()).toBe(missingPath);
	});
});
