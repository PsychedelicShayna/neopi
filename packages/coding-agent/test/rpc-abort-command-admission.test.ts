import { expect, test } from "bun:test";
import * as path from "node:path";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { ControlClient } from "../src/control/client";
import type { ControlMetadata } from "../src/control/registry";
import { RpcChild, type RpcFrame } from "./helpers/rpc-child";

type Channel = {
	child: RpcChild;
	frames: RpcFrame[];
	request: (frame: RpcFrame) => Promise<RpcFrame>;
	waitFor: (predicate: (frame: RpcFrame) => boolean) => Promise<RpcFrame>;
};

async function withChannel(
	transport: "stdio" | "control",
	overrides: boolean,
	run: (channel: Channel) => Promise<void>,
) {
	const child = await RpcChild.spawn({
		entrypoint: path.join(import.meta.dir, "fixtures/command-admission-rpc-agent.ts"),
		env: { RPC_ADMISSION_OVERRIDES: overrides ? "1" : "0" },
	});
	let client: ControlClient | undefined;
	try {
		await child.waitFor(frame => frame.type === "ready");
		await child.request({ type: "get_state" });
		let channel: Channel = {
			child,
			frames: child.frames,
			request: frame => child.request(frame),
			waitFor: predicate => child.waitFor(predicate),
		};
		if (transport === "control") {
			const metadata = (await child.waitFor(frame => frame.type === "fixture_control")).metadata as ControlMetadata;
			const frames: RpcFrame[] = [];
			const listeners = new Set<(frame: RpcFrame) => void>();
			client = new ControlClient({
				metadata,
				label: "admission regression",
				onFrame: frame => {
					frames.push(frame);
					for (const listener of listeners) listener(frame);
				},
			});
			await client.connect();
			const connection = client;
			channel = {
				child,
				frames,
				request: async frame => (await connection.request(frame)) as unknown as RpcFrame,
				waitFor: predicate => {
					const found = frames.find(predicate);
					if (found) return Promise.resolve(found);
					const pending = Promise.withResolvers<RpcFrame>();
					const listener = (frame: RpcFrame) => {
						if (predicate(frame)) pending.resolve(frame);
					};
					listeners.add(listener);
					return withTimeout(pending.promise, 20_000, "Control prompt result did not arrive").finally(() =>
						listeners.delete(listener),
					);
				},
			};
		}
		await withTimeout(run(channel), 45_000, "Command admission fixture timed out");
	} finally {
		client?.close();
		child.process.kill("SIGKILL");
		await child.dispose(0);
	}
}

async function abortAndWait(channel: Channel, id: string, message: string): Promise<RpcFrame> {
	const ack = await channel.request({ type: "abort_and_prompt", id, message });
	expect(ack).toMatchObject({ type: "response", command: "abort_and_prompt", success: true });
	const result = await channel.waitFor(frame => frame.type === "prompt_result" && frame.id === id);
	expect(channel.frames.indexOf(ack)).toBeLessThan(channel.frames.indexOf(result));
	await channel.request({ type: "get_state", id: `${id}-barrier` });
	expect(channel.frames.filter(frame => frame.type === "prompt_result" && frame.id === id)).toHaveLength(1);
	return result;
}

for (const transport of ["stdio", "control"] as const) {
	test(`${transport}: abort-and-prompt aborts old work then refuses a terminal command without invoking the agent`, async () => {
		await withChannel(transport, false, async channel => {
			await channel.request({ type: "prompt", id: "old", message: "hold-model" });
			await channel.child.waitFor(frame => frame.type === "fixture_model" && frame.held === true);
			const result = await abortAndWait(channel, "settings", "/settings");
			expect(result).toMatchObject({
				status: "error",
				agentInvoked: false,
				error: { message: "/settings needs the terminal UI" },
			});
			expect(await channel.waitFor(frame => frame.type === "prompt_result" && frame.id === "old")).toMatchObject({
				status: "aborted",
			});
			expect(channel.child.frames.filter(frame => frame.type === "fixture_prompt").map(frame => frame.text)).toEqual(
				["hold-model"],
			);
		});
	}, 60_000);

	test(`${transport}: abort-and-prompt handles personality locally and transforms an operator notice`, async () => {
		await withChannel(transport, false, async channel => {
			expect(await abortAndWait(channel, "list", "/personality")).toMatchObject({
				status: "completed",
				agentInvoked: false,
			});
			expect(
				await channel.waitFor(
					frame => frame.type === "command_output" && String(frame.text).includes("Available:"),
				),
			).toBeDefined();
			expect(await abortAndWait(channel, "select", "/personality Warm")).toMatchObject({
				status: "completed",
				agentInvoked: false,
			});
			await channel.waitFor(
				frame => frame.type === "command_output" && String(frame.text).includes("Personality: Warm (session)"),
			);
			// The new builtin must finish its own run, not inherit the old turn's abort result.
			await channel.request({ type: "prompt", id: "before-notice", message: "hold-model" });
			await channel.child.waitFor(frame => frame.type === "fixture_model" && frame.held === true);
			expect(await abortAndWait(channel, "notice", "/notice Keep the literal wording.")).toMatchObject({
				status: "completed",
				agentInvoked: true,
			});
			const submitted = channel.child.frames.filter(frame => frame.type === "fixture_prompt");
			expect(submitted).toHaveLength(2);
			expect(submitted[0]!.text).toBe("hold-model");
			expect(submitted[1]).toMatchObject({
				options: {
					synthetic: true,
					userInitiated: true,
					attribution: "user",
					rawText: "/notice Keep the literal wording.",
					expandPromptTemplates: false,
					streamingBehavior: "steer",
				},
			});
			expect(submitted[1]!.text).toContain("Keep the literal wording.");
			expect(submitted[1]!.text).not.toStartWith("/notice");
		});
	}, 60_000);

	test(`${transport}: abort-and-prompt applies input hooks before command admission and retains unknown slash chat`, async () => {
		await withChannel(transport, false, async channel => {
			expect(await abortAndWait(channel, "transformed", "to-settings")).toMatchObject({
				status: "error",
				agentInvoked: false,
			});
			expect(await abortAndWait(channel, "handled", "consume")).toMatchObject({
				status: "completed",
				agentInvoked: false,
			});
			expect(await abortAndWait(channel, "unknown", "/tmp/not-a-command")).toMatchObject({
				status: "completed",
				agentInvoked: true,
			});
			expect(channel.child.frames.filter(frame => frame.type === "fixture_prompt").map(frame => frame.text)).toEqual(
				["/tmp/not-a-command"],
			);
		});
	}, 60_000);

	test.each(["abort", "new_session"] as const)(
		`${transport}: %s cancels pending command admission before stale local work`,
		async transition => {
			await withChannel(transport, false, async channel => {
				await channel.request({ type: "abort_and_prompt", id: "stale", message: "wait-for-ui" });
				const dialog = await channel.child.waitFor(
					frame => frame.type === "extension_ui_request" && frame.method === "confirm",
				);
				await channel.request({ type: transition, id: "transition" });
				channel.child.send({ type: "extension_ui_response", id: dialog.id, confirmed: true });
				expect(
					await channel.waitFor(frame => frame.type === "prompt_result" && frame.id === "stale"),
				).toMatchObject({ status: "aborted" });
				await channel.request({ type: "get_state", id: "settled" });
				expect(
					channel.frames.some(
						frame => frame.type === "command_output" && String(frame.text).includes("Warm (session)"),
					),
				).toBe(false);
				expect(channel.child.frames.some(frame => frame.type === "fixture_prompt")).toBe(false);
			});
		},
		60_000,
	);

	test(`${transport}: terminal-name extension and custom overrides still run after abort`, async () => {
		await withChannel(transport, true, async channel => {
			for (const name of ["settings", "hotkeys"]) {
				expect(await abortAndWait(channel, name, `/${name}`)).toMatchObject({
					status: "completed",
					agentInvoked: false,
				});
				await channel.child.waitFor(frame => frame.type === "fixture_override" && frame.name === name);
			}
			expect(channel.child.frames.some(frame => frame.type === "fixture_model")).toBe(false);
		});
	}, 60_000);
}
