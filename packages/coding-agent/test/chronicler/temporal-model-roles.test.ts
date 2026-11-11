import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as ai from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { resolveRanker } from "../../src/chronicler/temporal/config";
import { resolveChronicleModelClient } from "../../src/chronicler/temporal/model";
import { getKnownRoleIds, getRoleInfo } from "../../src/config/model-roles";
import {
	resolveChronicleRecallRoleSelection,
	resolveChronicleSummaryRoleSelection,
} from "../../src/config/model-resolver";

const summary = getBundledModel("openai", "gpt-5")!;
const recall = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const available = [summary, recall];
const registry = {
	getAvailable: () => available,
	resolver: () => async () => "test-key",
} as unknown as ModelRegistry;

afterEach(() => vi.restoreAllMocks());

test.each([
	{ "chronicler-summary": `${summary.provider}/${summary.id}:max` },
	{ chronicler: `${summary.provider}/${summary.id}:high` },
	{},
])("unset recall follows the complete effective summary role", modelRoles => {
	const settings = Settings.isolated({ modelRoles });
	expect(resolveChronicleRecallRoleSelection(settings, available)).toEqual(
		resolveChronicleSummaryRoleSelection(settings, available),
	);
	expect(resolveChronicleModelClient(settings, registry, "chronicler-recall")?.identity).toBe(
		resolveChronicleModelClient(settings, registry)?.identity,
	);
	expect(getKnownRoleIds(settings)).toContain("chronicler-recall");
	expect(getRoleInfo("chronicler-recall", settings)).toMatchObject({
		tag: "CHRONREC",
		description: "Ranks Chronicler recall results while you wait.",
	});
});

test("recall uses its assigned model and effort while summaries keep their own model", async () => {
	const settings = Settings.isolated({
		modelRoles: {
			"chronicler-summary": `${summary.provider}/${summary.id}:high`,
			"chronicler-recall": `${recall.provider}/${recall.id}:low`,
		},
	});
	const complete = vi.spyOn(ai, "completeSimple").mockResolvedValue({
		stopReason: "end_turn",
		content: [{ type: "text", text: '{"scores":[{"key":"a","score":8}]}' }],
	} as never);
	const ranker = await resolveRanker(settings, registry, "model");
	expect(await ranker.score("auth", [{ key: "a", label: "Auth", text: "Token changes" }])).toEqual({ scores: [0.8] });
	expect(complete.mock.calls[0]?.[0].id).toBe(recall.id);
	expect(complete.mock.calls[0]?.[2]?.reasoning).toBe(Effort.Low);
	await resolveChronicleModelClient(settings, registry)!.complete("Summarize", "History", 512);
	expect(complete.mock.calls[1]?.[0].id).toBe(summary.id);
	expect(complete.mock.calls[1]?.[2]?.reasoning).toBe(Effort.High);
});

test("recall help remains usable in a fresh CLI process", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-recall-cli-"));
	try {
		const child = Bun.spawn(
			[process.execPath, path.resolve(import.meta.dir, "../../src/cli.ts"), "chronicle", "recall", "--help"],
			{
				cwd: home,
				env: {
					PATH: process.env.PATH,
					HOME: home,
					USERPROFILE: home,
					TMPDIR: process.env.TMPDIR,
					NO_COLOR: "1",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(stdout).toContain("--ranker");
		expect(stdout).toContain("judge");
	} finally {
		await fs.rm(home, { recursive: true, force: true });
	}
}, 30_000);
