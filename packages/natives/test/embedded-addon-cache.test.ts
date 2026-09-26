import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type EmbeddedAddonFile, extractEmbeddedAddonArchive } from "../native/loader-state.js";

// A fork ships many builds under one upstream version, so the per-version
// cache can hold a same-size addon from a different build. Each build extracts
// to a path named by its content hash, so neither can load the other's bytes.
describe("embedded addon cache", () => {
	const filename = "pi_natives.linux-x64-modern.node";
	let testDir: string;
	let archivePath: string;
	let targetDir: string;
	let files: EmbeddedAddonFile[];

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-embedded-cache-"));
		archivePath = path.join(testDir, "embedded-addons.linux-x64.tar.gz");
		targetDir = path.join(testDir, "cache");
		await fs.mkdir(targetDir);
		const bytes = Buffer.from("new!");
		await Bun.write(archivePath, await new Bun.Archive({ [filename]: bytes }, { compress: "gzip" }).bytes());
		files = [
			{
				variant: "modern",
				filename,
				size: bytes.length,
				sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
			},
		];
	});

	afterEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("extracts to a content-addressed path, never loading another build's same-size addon", async () => {
		const canonical = path.join(targetDir, filename);
		await Bun.write(canonical, "old!");

		const [extracted] = extractEmbeddedAddonArchive({ archivePath, files, targetDir });
		expect(extracted).not.toBe(canonical);
		expect(await fs.readFile(extracted!, "utf8")).toBe("new!");
		expect(await fs.readFile(canonical, "utf8")).toBe("old!");
		expect(extractEmbeddedAddonArchive({ archivePath, files, targetDir })).toEqual([]);
	});

	it("keeps two builds of one version in separate files", async () => {
		const otherArchive = path.join(testDir, "other.tar.gz");
		const otherBytes = Buffer.from("odd!");
		await Bun.write(otherArchive, await new Bun.Archive({ [filename]: otherBytes }, { compress: "gzip" }).bytes());
		const otherFiles = [{ ...files[0]!, sha256: new Bun.CryptoHasher("sha256").update(otherBytes).digest("hex") }];

		const [ours] = extractEmbeddedAddonArchive({ archivePath, files, targetDir });
		const [theirs] = extractEmbeddedAddonArchive({ archivePath: otherArchive, files: otherFiles, targetDir });
		expect(theirs).not.toBe(ours);
		expect(await fs.readFile(ours!, "utf8")).toBe("new!");
		expect(await fs.readFile(theirs!, "utf8")).toBe("odd!");
	});
});
