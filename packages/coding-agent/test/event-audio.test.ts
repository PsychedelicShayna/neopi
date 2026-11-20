import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../src/async/job-manager";
import { sessionAudioEvents } from "../src/event-audio/events";
import { eventAudioPlaying, ownEventAudio, preemptEventAudio } from "../src/event-audio/activity";
import { EventSoundPlayer } from "../src/event-audio/player";

const directories: string[] = [];
const players: EventSoundPlayer[] = [];
afterEach(async () => {
	for (const player of players.splice(0)) player.dispose();
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function mappingFile(clips: Record<string, unknown>): Promise<string> {
	const scratch = path.join(os.homedir(), ".cache", "npi-canary");
	await fs.mkdir(scratch, { recursive: true });
	const directory = await fs.mkdtemp(path.join(scratch, "event-audio-test-"));
	directories.push(directory);
	const filename = path.join(directory, "curation.json");
	await Bun.write(filename, JSON.stringify({ version: 1, clips }));
	return filename;
}

function player(warnings: string[]): EventSoundPlayer {
	const result = new EventSoundPlayer({
		warning: text => warnings.push(text),
		blocked: () => false,
		gain: () => 0.35,
		interval: () => 250,
		streamInterval: () => 1200,
	});
	players.push(result);
	return result;
}

describe("event audio classification", () => {
	test("distinguishes async pause from final completion", () => {
		expect(sessionAudioEvents({ type: "agent_pause", messages: [], yielded: true, awaiting: false })).toEqual([
			"agent.pause",
		]);
		expect(sessionAudioEvents({ type: "agent_pause", messages: [], yielded: true, awaiting: true })).toEqual([
			"agent.pause",
		]);
		expect(sessionAudioEvents({ type: "agent_end", messages: [] })).toEqual(["agent.complete"]);
	});

	test("does not call a partially failed multi-file edit a tool success", () => {
		const ids = sessionAudioEvents({
			type: "tool_execution_end",
			toolCallId: "edit-1",
			toolName: "edit",
			result: { details: { perFileResults: [{ path: "a.ts" }, { path: "b.ts", isError: true }] } },
		});
		expect(ids).toContain("error.tool");
		expect(ids).toContain("edit.complete");
		expect(ids).not.toContain("tool.success");
	});

	test("does not invent mid-apply edit progress", () => {
		expect(
			sessionAudioEvents({
				type: "tool_execution_update",
				toolCallId: "edit-1",
				toolName: "edit",
				args: {},
				partialResult: {},
			}),
		).toEqual(["tool.progress"]);
	});

	test("normalizes the real py input token without guessing the language of a generic failure", () => {
		expect(
			sessionAudioEvents({
				type: "tool_execution_start",
				toolCallId: "eval-1",
				toolName: "eval",
				args: { language: "py" },
			}),
		).toEqual(["eval.python.start", "eval.start", "tool.start"]);
		const generic = sessionAudioEvents({
			type: "tool_execution_end",
			toolCallId: "eval-1",
			toolName: "eval",
			isError: true,
			result: {},
		});
		expect(generic).toContain("error.tool");
		expect(generic).not.toContain("eval.python.error");
	});

	test("language-tagged cell failures cannot fall back to generic success", () => {
		const ids = sessionAudioEvents({
			type: "tool_execution_end",
			toolCallId: "eval-1",
			toolName: "eval",
			result: { details: { cells: [{ language: "js", status: "error" }] } },
		});
		expect(ids[0]).toBe("eval.js.error");
		expect(ids).toContain("error.tool");
		expect(ids).not.toContain("eval.python.error");
		expect(ids).not.toContain("tool.success");
	});
});

describe("curated mapping contract", () => {
	test("does not resolve duplicate assignments by first or last clip", async () => {
		const warnings: string[] = [];
		const filename = await mappingFile({
			"audio/computer/one.mp3": { status: "assigned", events: ["tool.start"] },
			"audio/computer/two.mp3": { status: "assigned", events: ["tool.start"] },
		});
		const sounds = player(warnings);
		await sounds.reload(filename);
		expect(sounds.status()).toContain("0 assigned events");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("multiple clips assigned to tool.start");
	});

	test("unassigned clips and instrumentation gaps remain silent", async () => {
		const warnings: string[] = [];
		const filename = await mappingFile({
			"audio/unselected.mp3": { status: "unassigned", events: ["tool.start"] },
			"audio/gap.mp3": { status: "assigned", events: ["edit.apply_progress"] },
		});
		const sounds = player(warnings);
		await sounds.reload(filename);
		sounds.setEnabled(true);
		sounds.play(["tool.start", "edit.apply_progress"]);
		expect(sounds.status()).toContain("0 decoded clips");
		expect(sounds.status()).toContain("0 played");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("unsupported event edit.apply_progress");
	});

	test("rejects outside-archive paths before trying to decode them", async () => {
		const warnings: string[] = [];
		const filename = await mappingFile({
			"/etc/passwd": { status: "assigned", events: ["tool.start"] },
			"audio/../../outside.mp3": { status: "assigned", events: ["tool.progress"] },
		});
		const sounds = player(warnings);
		await sounds.reload(filename);
		expect(sounds.status()).toContain("0 assigned events");
		expect(warnings).toHaveLength(2);
		expect(warnings.every(warning => warning.includes("clip path must stay under"))).toBe(true);
	});

	test("reports missing mappings without throwing into the harness", async () => {
		const warnings: string[] = [];
		const filename = await mappingFile({});
		await fs.rm(filename);
		const sounds = player(warnings);
		await expect(sounds.reload(filename)).resolves.toBeUndefined();
		expect(warnings).toHaveLength(1);
		expect(sounds.status()).toContain("0 assigned events");
	});
});

test("capture preemption releases notification activity immediately", () => {
	let stopped = 0;
	const release = ownEventAudio(() => {
		stopped++;
		release();
	});
	try {
		expect(eventAudioPlaying()).toBe(true);
		preemptEventAudio();
		expect(stopped).toBe(1);
		expect(eventAudioPlaying()).toBe(false);
	} finally {
		release();
	}
});

test("manager observers distinguish registration, promotion, progress and settlement", async () => {
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	const gate = Promise.withResolvers<void>();
	const events: Array<{ type: string; foreground: boolean }> = [];
	const unsubscribe = manager.subscribe(event =>
		events.push({ type: event.type, foreground: event.job.foreground === true }),
	);
	try {
		const id = manager.register(
			"bash",
			"work",
			async ({ reportProgress }) => {
				await gate.promise;
				await reportProgress("real output");
				return "done";
			},
			{ foreground: true },
		);
		expect(events).toEqual([{ type: "register", foreground: true }]);
		manager.backgroundJob(id);
		gate.resolve();
		await manager.getJob(id)!.promise;
		expect(events.map(event => event.type)).toEqual(["register", "background", "progress", "complete"]);
	} finally {
		unsubscribe();
		gate.resolve();
		await manager.dispose();
	}
});
