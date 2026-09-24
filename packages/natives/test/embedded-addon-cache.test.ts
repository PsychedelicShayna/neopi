import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type EmbeddedAddonFile, extractEmbeddedAddonArchive } from "../native/loader-state.js";

// A fork ships many builds under one upstream version, so the per-version
// cache can hold a same-size addon from a different build. Size alone must not
// make it current.
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

	it("replaces a same-size addon left by another build of the same version", async () => {
		await Bun.write(path.join(targetDir, filename), "old!");

		expect(extractEmbeddedAddonArchive({ archivePath, files, targetDir })).toEqual([path.join(targetDir, filename)]);
		expect(await fs.readFile(path.join(targetDir, filename), "utf8")).toBe("new!");
		expect(extractEmbeddedAddonArchive({ archivePath, files, targetDir })).toEqual([]);
	});

	it("re-extracts after another binary rewrites the cached addon", async () => {
		extractEmbeddedAddonArchive({ archivePath, files, targetDir });
		const cached = path.join(targetDir, filename);
		await Bun.write(`${cached}.other`, "odd!");
		await fs.rename(`${cached}.other`, cached);

		expect(extractEmbeddedAddonArchive({ archivePath, files, targetDir })).toEqual([cached]);
		expect(await fs.readFile(cached, "utf8")).toBe("new!");
	});
});
