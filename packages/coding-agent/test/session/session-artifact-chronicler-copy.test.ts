import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { artifactsDirectoryFor, copySessionArtifacts } from "../../src/session/session-manager";

const EPHEMERAL = [
	"chronicler.lock",
	"chronicler.lock.claim",
	"chronicler.lock.01900000-0000-7000-8000-000000000000.tmp",
	"chronicler/.__chronicler.jsonl.lease",
	"chronicler/.__chronicler.jsonl.lease.os",
	"chronicler/.__chronicler.jsonl.lock",
	"chronicler/.__chronicler.jsonl.lock.os",
];
const DURABLE = [
	"chronicler/beats/batch/COMMIT.json",
	"chronicler/beats/batch/beat.md",
	"chronicler/__chronicler.jsonl",
	"chronicler/index.md",
	"nested/chronicler.lock",
	"user.lock",
	"1.read.log",
];

async function writeArtifacts(root: string): Promise<void> {
	for (const name of [...EPHEMERAL, ...DURABLE]) await Bun.write(path.join(root, name), `history:${name}`);
}

async function verifyCopy(root: string): Promise<void> {
	for (const name of EPHEMERAL) expect(await Bun.file(path.join(root, name)).exists()).toBe(false);
	for (const name of DURABLE) expect(await Bun.file(path.join(root, name)).text()).toBe(`history:${name}`);
}

describe("session copies preserve Chronicle history without writer ownership", () => {
	it("fork artifact copies omit only Chronicler ownership and keep destination history authoritative", async () => {
		using temporary = TempDir.createSync("@pi-chronicler-artifact-copy-");
		const source = path.join(temporary.path(), "source.jsonl");
		const destination = path.join(temporary.path(), "destination.jsonl");
		const sourceRoot = artifactsDirectoryFor(source)!;
		const destinationRoot = artifactsDirectoryFor(destination)!;
		await writeArtifacts(sourceRoot);
		await Bun.write(path.join(destinationRoot, "existing.txt"), "destination data");
		await copySessionArtifacts(source, destination);
		await verifyCopy(destinationRoot);
		expect(await Bun.file(path.join(destinationRoot, "existing.txt")).text()).toBe("destination data");
		// Existing durable files must not be overwritten by a later copy.
		await Bun.write(path.join(sourceRoot, "chronicler/index.md"), "different source data");
		await copySessionArtifacts(source, destination);
		expect(await Bun.file(path.join(destinationRoot, "chronicler/index.md")).text()).toBe(
			"history:chronicler/index.md",
		);
	});
});
