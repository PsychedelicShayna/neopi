import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as dirs from "@oh-my-pi/pi-utils/dirs";
import * as logger from "@oh-my-pi/pi-utils/logger";
import {
	compilePromptAsset,
	getPromptAssetProvenance,
	hashPromptAsset,
	inspectPromptAsset,
	renderPromptAsset,
	resolvePromptAsset,
} from "@oh-my-pi/pi-utils/prompt-assets";
import { TemplateSyntaxError } from "@oh-my-pi/pi-utils/template";

let root: string;
let cwd: string;
let agentDir: string;
const id = "system/system-prompt.md";
const bundled = "Bundled {{username}}\r\n";

beforeEach(async () => {
	const scratch = path.join(os.homedir(), ".cache", "npi-canary");
	await fs.mkdir(scratch, { recursive: true });
	root = await fs.mkdtemp(path.join(scratch, "prompt-assets-"));
	cwd = path.join(root, "project");
	agentDir = path.join(root, "profiles", "test", "agent");
	await fs.mkdir(cwd, { recursive: true });
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

function options() {
	return { cwd, agentDir };
}

function projectFile(assetId = id) {
	return path.join(cwd, ".omp", "builtin-prompts", assetId);
}

function userFile(assetId = id) {
	return path.join(agentDir, "builtin-prompts", assetId);
}

describe("whole-file prompt asset resolution", () => {
	it("returns the original bundled bytes without creating override directories", async () => {
		expect(resolvePromptAsset(id, bundled, options())).toEqual({
			text: bundled,
			source: "bundled",
			hash: hashPromptAsset(bundled),
			bundledHash: hashPromptAsset(bundled),
		});
		expect(await fs.readdir(cwd)).toEqual([]);
		expect(await Bun.file(path.join(agentDir, "builtin-prompts")).exists()).toBe(false);
		expect(hashPromptAsset("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	it("replaces whole files with project over user over bundled precedence", async () => {
		await Bun.write(userFile(), "User {{username}}");
		expect(resolvePromptAsset(id, bundled, options())).toMatchObject({
			text: "User {{username}}",
			source: "user",
			path: userFile(),
		});
		await Bun.write(projectFile(), "Project {{firstName}}");
		expect(resolvePromptAsset(id, bundled, options())).toMatchObject({
			text: "Project {{firstName}}",
			source: "project",
			path: projectFile(),
		});
		await fs.unlink(projectFile());
		expect(resolvePromptAsset(id, bundled, options()).source).toBe("user");
		await fs.unlink(userFile());
		expect(resolvePromptAsset(id, bundled, options()).source).toBe("bundled");
	});

	it("uses only the current project and profile-aware user directory", async () => {
		await Bun.write(path.join(root, ".omp", "builtin-prompts", id), "Ancestor");
		await Bun.write(path.join(root, "default-agent", "builtin-prompts", id), "Wrong profile");
		spyOn(dirs, "getProjectDir").mockReturnValue(cwd);
		spyOn(dirs, "getAgentDir").mockReturnValue(agentDir);
		expect(resolvePromptAsset(id, bundled).text).toBe(bundled);
		await Bun.write(userFile(), "Current profile");
		expect(resolvePromptAsset(id, bundled)).toMatchObject({
			text: "Current profile",
			path: userFile(),
			source: "user",
		});
	});

	it("honors explicit directories rather than ambient defaults", async () => {
		spyOn(dirs, "getProjectDir").mockImplementation(() => {
			throw new Error("ambient project");
		});
		spyOn(dirs, "getAgentDir").mockImplementation(() => {
			throw new Error("ambient profile");
		});
		await Bun.write(userFile(), "Explicit profile");
		expect(resolvePromptAsset(id, bundled, options()).text).toBe("Explicit profile");
	});

	it("inspects an exact selected root without runtime precedence", async () => {
		await Bun.write(projectFile(), "Project");
		await Bun.write(userFile(), "User");
		expect(
			inspectPromptAsset(id, bundled, {
				root: path.join(agentDir, "builtin-prompts"),
				source: "user",
			}),
		).toMatchObject({ text: "User", source: "user", path: userFile() });
		expect(inspectPromptAsset(id, bundled, { root: path.join(root, "empty") }).text).toBe(bundled);
	});

	it("picks up mtime changes and deletion at the next resolve", async () => {
		await Bun.write(projectFile(), "Old {{username}}");
		const first = resolvePromptAsset(id, bundled, options());
		await Bun.write(projectFile(), "New {{username}}");
		const changed = new Date(Date.now() + 2000);
		await fs.utimes(projectFile(), changed, changed);
		const second = resolvePromptAsset(id, bundled, options());
		expect(second.text).toBe("New {{username}}");
		expect(second.hash).not.toBe(first.hash);
		await fs.unlink(projectFile());
		expect(resolvePromptAsset(id, bundled, options()).text).toBe(bundled);
	});

	it("accepts an unchanged bundled override without reparsing the embedded source", async () => {
		const text = "A literal {{ not closed";
		await Bun.write(projectFile(), text);
		expect(resolvePromptAsset(id, text, options())).toMatchObject({
			text,
			source: "project",
			hash: hashPromptAsset(text),
		});
	});

	it("does not freeze an empty override or merge it with the bundled prompt", async () => {
		await Bun.write(projectFile(), "");
		expect(resolvePromptAsset(id, bundled, options()).text).toBe("");
	});

	it.each([
		"",
		"/absolute.md",
		"../escape.md",
		"system/../../escape.md",
		"system/./a.md",
		"system//a.md",
		"C:/a.md",
		"system\\a.md",
		"system/a\u0000.md",
	])("rejects unsafe id %s before reading overrides", unsafe => {
		expect(() => resolvePromptAsset(unsafe, bundled, options())).toThrow(TypeError);
	});
});

describe("invalid override policy and provenance", () => {
	it("fails closed for core assets with original error spans and file provenance", async () => {
		await Bun.write(projectFile(), "Header\n  {{#if ready}}\ntext\n");
		try {
			resolvePromptAsset(id, bundled, options());
			throw new Error("Expected core template failure");
		} catch (error) {
			expect(error).toBeInstanceOf(TemplateSyntaxError);
			if (!(error instanceof TemplateSyntaxError)) throw error;
			expect(error.message).toContain(projectFile());
			expect(error).toMatchObject({ line: 2, column: 3, expression: "{{#if ready}}" });
		}
		expect(inspectPromptAsset(id, bundled, options()).text).toBe("Header\n  {{#if ready}}\ntext\n");
		expect(getPromptAssetProvenance(options())).toEqual([]);
	});

	it("warns once for a broken notice and falls back until it is repaired", async () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		await Bun.write(projectFile(), "{{#if broken}}");
		const noticeOptions = { ...options(), kind: "notice" as const };
		expect(resolvePromptAsset(id, bundled, noticeOptions)).toMatchObject({ text: bundled, source: "bundled" });
		expect(resolvePromptAsset(id, bundled, noticeOptions).source).toBe("bundled");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ id, path: projectFile() }));
		await Bun.write(projectFile(), "Repaired {{username}}");
		expect(resolvePromptAsset(id, bundled, noticeOptions).text).toBe("Repaired {{username}}");
	});

	it("reports only observed effective assets for the selected project and profile", async () => {
		await Bun.write(userFile(), "User");
		inspectPromptAsset("tools/bash.md", "Inspection only", options());
		resolvePromptAsset(id, bundled, options());
		resolvePromptAsset("tools/read.md", "Read", options());
		expect(getPromptAssetProvenance(options())).toEqual([
			{ id, source: "user", path: userFile(), hash: hashPromptAsset("User"), bundledHash: hashPromptAsset(bundled) },
			{
				id: "tools/read.md",
				source: "bundled",
				hash: hashPromptAsset("Read"),
				bundledHash: hashPromptAsset("Read"),
			},
		]);
		expect(getPromptAssetProvenance({ cwd, agentDir: path.join(root, "other-profile") })).toEqual([]);
		await fs.unlink(userFile());
		resolvePromptAsset(id, bundled, options());
		expect(getPromptAssetProvenance(options())[0].source).toBe("bundled");
	});

	it("falls back for unknown notice helpers and records the effective bundled asset", async () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		await Bun.write(projectFile(), "{{missingPromptHelper username}}");
		expect(
			renderPromptAsset(
				id,
				"Hello {{username}}",
				{ username: "Ada" },
				{
					...options(),
					kind: "notice",
				},
			),
		).toBe("Hello Ada");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(getPromptAssetProvenance(options())[0].source).toBe("bundled");
	});

	it("includes override provenance when a core helper fails during rendering", async () => {
		await Bun.write(projectFile(), "{{missingPromptHelper username}}");
		expect(() => renderPromptAsset(id, bundled, { username: "Ada" }, options())).toThrow(projectFile());
	});

	it("preserves unformatted compilation and catches delayed notice helper failures", async () => {
		spyOn(logger, "warn").mockImplementation(() => {});
		const baseline = "\n  {{username}}  \n";
		await Bun.write(projectFile(), "{{jsonStringify value}}");
		const compiled = compilePromptAsset(id, baseline, { ...options(), kind: "notice" });
		const value: { self?: unknown } = {};
		value.self = value;
		expect(compiled({ username: "Ada", value })).toBe("\n  Ada  \n");
		expect(getPromptAssetProvenance(options())[0].source).toBe("bundled");
		expect(compiled({ value: "fine" })).toBe('"fine"');
		expect(getPromptAssetProvenance(options())[0].source).toBe("project");
	});
});
