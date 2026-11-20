import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commitAll, fakeAddon, fakeNeoPiTree, FAKE_PLATFORM, FAKE_VERSION, tempDir, type FakeTreeOptions } from "./fixtures/native-tree.ts";
import { spawnOwnedSync } from "../owned-process.ts";
import { GENERATED_BINDINGS, NATIVE_INPUTS, NATIVE_RECORD, nativeInputsFingerprint, readNativeRecord, sha256, writeNativeRecord } from "./native-addon.ts";
import { preflight } from "./probe.ts";

const MODERN = `packages/natives/native/pi_natives.${FAKE_PLATFORM}-modern.node`;
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fake tree with an addon in place and a matching provenance record. */
function recordedTree(options?: FakeTreeOptions): string {
	const root = tempDir("npi-deck-probe-tree-");
	roots.push(root);
	const tree = fakeNeoPiTree(path.join(root, "tree"), options);
	writeFileSync(path.join(tree, MODERN), fakeAddon("probe", options?.nativeVersionFormat));
	writeNativeRecord(tree, {
		inputs: nativeInputsFingerprint(tree)!,
		platform: FAKE_PLATFORM,
		variant: "modern",
		sha256: sha256(readFileSync(path.join(tree, MODERN))),
		packageVersion: FAKE_VERSION,
		provenance: "built",
		source: path.join(tree, MODERN),
	});
	if (!readNativeRecord(tree)) {
		const commands = [
			["rev-parse", "--show-toplevel"],
			["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...NATIVE_INPUTS, ...GENERATED_BINDINGS.map(file => `:(exclude)${file}`)],
		];
		const git = commands.map(args => {
			const result = spawnOwnedSync(["git", "-C", tree, ...args], { stdout: "pipe", stderr: "pipe" });
			return { args, exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
		});
		const top = git[0]!.stdout.trim();
		console.error("rejected native record fixture", JSON.stringify({
			tree,
			realTree: realpathSync(tree),
			realTop: top ? realpathSync(top) : null,
			record: JSON.parse(readFileSync(path.join(tree, NATIVE_RECORD), "utf8")),
			packageJson: readFileSync(path.join(tree, "package.json"), "utf8"),
			git,
		}));
	}
	expect(readNativeRecord(tree)?.inputs).toBeString();
	return tree;
}

async function refusal(tree: string): Promise<string> {
	const result = await preflight(tree);
	if (result.ok) throw new Error("backend unexpectedly passed preflight");
	return result.reason;
}

test("refuses unprepared candidate before importing SDK modules", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "npi-deck-unprepared-"));
	try {
		mkdirSync(path.join(root, "packages/coding-agent"), { recursive: true });
		writeFileSync(path.join(root, "packages/coding-agent/package.json"), "{}\n");
		const result = await preflight(root);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unprepared backend unexpectedly passed preflight");
		expect(result.reason).toContain("tree not prepared: node_modules missing");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

for (const format of ["legacy", "stamp"] as const) {
	test(`accepts the ${format} native record before checking the fake tree's missing SDK exports`, async () => {
		expect(await refusal(recordedTree({ nativeVersionFormat: format }))).toContain("missing required SDK surface");
	});
}

// quarantined: flaky on Windows, tracked by NeoPi #751 (was neodeck#198)
test.skipIf(process.platform === "win32")("refuses a Bun older than the tree's engines.bun", async () => {
	const tree = recordedTree({ bunEngine: ">=99.0.0" });
	expect(await refusal(tree)).toContain(`Bun ${Bun.version} does not satisfy NeoPi's engines.bun ">=99.0.0"`);
});

test("refuses an addon without a fingerprint record", async () => {
	const tree = recordedTree();
	rmSync(path.join(tree, NATIVE_RECORD));
	expect(await refusal(tree)).toContain("no fingerprint record");
});

for (const format of ["legacy", "stamp"] as const) {
	test(`refuses a ${format} addon once native inputs change, though its release still matches`, async () => {
		const tree = recordedTree({ nativeVersionFormat: format });
		writeFileSync(path.join(tree, "Cargo.lock"), "version = 4\n# bumped\n");
		commitAll(tree, "bump lock");
		expect(await refusal(tree)).toContain("native inputs changed");
	});

	test(`refuses a ${format} addon replaced after it was recorded`, async () => {
		const tree = recordedTree({ nativeVersionFormat: format });
		writeFileSync(path.join(tree, MODERN), fakeAddon("swapped", format));
		expect(await refusal(tree)).toContain("the recorded addon is sha256");
	});
}
