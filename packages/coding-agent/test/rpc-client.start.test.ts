import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcCommand, RpcExtensionUIResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

function loginPeer(): {
	client: RpcClient;
	written: Array<RpcCommand | RpcExtensionUIResponse>;
	emit(frame: object): void;
} {
	const exited = Promise.withResolvers<number>();
	const encoder = new TextEncoder();
	let stdout!: ReadableStreamDefaultController<Uint8Array>;
	const written: Array<RpcCommand | RpcExtensionUIResponse> = [];
	const process: RpcAgentProcess = {
		stdin: {
			write: data => {
				written.push(
					JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as
						| RpcCommand
						| RpcExtensionUIResponse,
				);
			},
		},
		stdout: new ReadableStream({
			start(controller) {
				stdout = controller;
				controller.enqueue(encoder.encode(`${JSON.stringify({ type: "ready" })}\n`));
			},
		}),
		peekStderr: () => "",
		kill: () => exited.resolve(0),
		exited: exited.promise,
	};
	return {
		client: new RpcClient({ spawn: () => process }),
		written,
		emit: frame => stdout.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`)),
	};
}

async function nextTurn(): Promise<void> {
	const turn = Promise.withResolvers<void>();
	setImmediate(turn.resolve);
	await turn.promise;
}

describe("RpcClient native private login", () => {
	test("concurrent login callbacks see only their own URLs, confirmations and masked inputs", async () => {
		const peer = loginPeer();
		using client = peer.client;
		await client.start();
		const prompts: Array<{ owner: string; title: string; secret: boolean }> = [];
		const confirmations: string[] = [];
		const urls: string[] = [];
		const login = (owner: string) =>
			client.login("neoproxy", {
				allowSecretInput: true,
				allowTrustConfirmation: true,
				onOpenUrl: url => urls.push(`${owner}:${url}`),
				onManualCodeInput: () => {
					throw new Error("Secret input must not use a plaintext code callback");
				},
				onInput: prompt => {
					prompts.push({ owner, title: prompt.title, secret: prompt.secret });
					return `${owner}-assigned-key`;
				},
				onConfirm: prompt => {
					confirmations.push(`${owner}:${prompt.message}`);
					return true;
				},
			});
		const first = login("first");
		const second = login("second");
		const firstRequest = peer.written[0] as Extract<RpcCommand, { type: "login" }>;
		const secondRequest = peer.written[1] as Extract<RpcCommand, { type: "login" }>;
		expect(firstRequest).toMatchObject({ allowSecretInput: true, allowTrustConfirmation: true });
		expect(firstRequest.id).not.toBe(secondRequest.id);
		for (const loginId of [undefined, "old-login"]) {
			peer.emit({
				type: "extension_ui_request",
				id: `old-url-${loginId}`,
				loginId,
				method: "open_url",
				url: "https://unrelated.example",
			});
			peer.emit({
				type: "extension_ui_request",
				id: `old-confirm-${loginId}`,
				loginId,
				method: "confirm",
				title: "Unrelated",
				message: "Do not capture",
			});
			peer.emit({
				type: "extension_ui_request",
				id: `old-input-${loginId}`,
				loginId,
				method: "input",
				title: "Unrelated",
				secret: true,
			});
			peer.emit({
				type: "extension_ui_request",
				id: `old-code-${loginId}`,
				loginId,
				method: "input",
				title: "Unrelated code",
			});
		}
		for (const [owner, request] of [
			["second", secondRequest],
			["first", firstRequest],
		] as const) {
			peer.emit({
				type: "extension_ui_request",
				id: `${owner}-url`,
				loginId: request.id,
				method: "open_url",
				url: `https://${owner}.example`,
			});
			peer.emit({
				type: "extension_ui_request",
				id: `${owner}-confirm`,
				loginId: request.id,
				method: "confirm",
				title: "Trust server?",
				message: `${owner} fingerprint`,
			});
			peer.emit({
				type: "extension_ui_request",
				id: `${owner}-input`,
				loginId: request.id,
				method: "input",
				title: "Member key",
				secret: true,
			});
		}
		await nextTurn();
		expect(urls).toEqual(["second:https://second.example", "first:https://first.example"]);
		expect(confirmations).toEqual(["second:second fingerprint", "first:first fingerprint"]);
		expect(prompts).toEqual([
			{ owner: "second", title: "Member key", secret: true },
			{ owner: "first", title: "Member key", secret: true },
		]);
		expect(peer.written.filter(frame => frame.type === "extension_ui_response")).toEqual([
			{ type: "extension_ui_response", id: "second-confirm", confirmed: true },
			{ type: "extension_ui_response", id: "second-input", value: "second-assigned-key" },
			{ type: "extension_ui_response", id: "first-confirm", confirmed: true },
			{ type: "extension_ui_response", id: "first-input", value: "first-assigned-key" },
		]);
		for (const request of [firstRequest, secondRequest]) {
			peer.emit({
				id: request.id,
				type: "response",
				command: "login",
				success: true,
				data: { providerId: "neoproxy" },
			});
		}
		await expect(first).resolves.toEqual({ providerId: "neoproxy" });
		await expect(second).resolves.toEqual({ providerId: "neoproxy" });
		peer.emit({
			type: "extension_ui_request",
			id: "late-key",
			loginId: firstRequest.id,
			method: "input",
			title: "Late key",
			secret: true,
		});
		await nextTurn();
		expect(prompts).toHaveLength(2);
	});

	test("abort cancels its generated login id and drops an in-flight secret answer", async () => {
		const peer = loginPeer();
		using client = peer.client;
		await client.start();
		const controller = new AbortController();
		const answer = Promise.withResolvers<string>();
		const prompted = Promise.withResolvers<AbortSignal>();
		const login = client.login("neoproxy", {
			allowSecretInput: true,
			signal: controller.signal,
			onInput: prompt => {
				prompted.resolve(prompt.signal);
				return answer.promise;
			},
		});
		const request = peer.written[0] as Extract<RpcCommand, { type: "login" }>;
		peer.emit({
			type: "extension_ui_request",
			id: "pending-key",
			loginId: request.id,
			method: "input",
			title: "Member key",
			secret: true,
		});
		const promptSignal = await prompted.promise;
		controller.abort();
		const cancel = peer.written.find(frame => frame.type === "cancel_login");
		expect(cancel).toMatchObject({ type: "cancel_login", loginId: request.id });
		if (!cancel) throw new Error("Missing native cancellation request");
		peer.emit({ id: cancel.id, type: "response", command: "cancel_login", success: true });
		peer.emit({
			id: request.id,
			type: "response",
			command: "login",
			success: false,
			code: "login_cancelled",
			error: "Login cancelled",
		});
		await expect(login).rejects.toMatchObject({ code: "login_cancelled" });
		expect(promptSignal.aborted).toBe(true);
		answer.resolve("late-secret-key");
		await nextTurn();
		expect(peer.written.some(frame => frame.type === "extension_ui_response")).toBe(false);
		expect(JSON.stringify(peer.written)).not.toContain("late-secret-key");
	});

	test("a secret callback rejection cancels its dialog without forwarding the exception's value", async () => {
		const peer = loginPeer();
		using client = peer.client;
		await client.start();
		const login = client.login("neoproxy", {
			allowSecretInput: true,
			onInput: () => {
				throw new Error("secret-entered-value");
			},
		});
		const request = peer.written[0] as Extract<RpcCommand, { type: "login" }>;
		peer.emit({
			type: "extension_ui_request",
			id: "key",
			loginId: request.id,
			method: "input",
			title: "Member key",
			secret: true,
		});
		await nextTurn();
		expect(peer.written.at(-1)).toEqual({ type: "extension_ui_response", id: "key", cancelled: true });
		expect(JSON.stringify(peer.written)).not.toContain("secret-entered-value");
		peer.emit({
			id: request.id,
			type: "response",
			command: "login",
			success: false,
			code: "login_cancelled",
			error: "Login cancelled",
		});
		await expect(login).rejects.toMatchObject({ code: "login_cancelled" });
	});

	test("disconnect aborts a masked prompt and drops its late answer", async () => {
		const peer = loginPeer();
		using client = peer.client;
		await client.start();
		const answer = Promise.withResolvers<string>();
		const prompted = Promise.withResolvers<AbortSignal>();
		const login = client.login("neoproxy", {
			allowSecretInput: true,
			onInput: prompt => {
				prompted.resolve(prompt.signal);
				return answer.promise;
			},
		});
		const request = peer.written[0] as Extract<RpcCommand, { type: "login" }>;
		peer.emit({
			type: "extension_ui_request",
			id: "disconnected-key",
			loginId: request.id,
			method: "input",
			title: "Member key",
			secret: true,
		});
		const signal = await prompted.promise;
		await client.stop();
		await expect(login).rejects.toThrow("Client stopped");
		expect(signal.aborted).toBe(true);
		answer.resolve("secret-after-disconnect");
		await nextTurn();
		expect(peer.written.some(frame => frame.type === "extension_ui_response")).toBe(false);
	});
});

describe("RpcClient.start", () => {
	test("rejects when RPC process exits immediately", async () => {
		using client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "src", "cli.ts"),
			cwd: path.join(import.meta.dir, ".."),
			provider: "__missing_provider__",
			model: "claude-sonnet-4-5",
			env: { PI_NO_TITLE: "1" },
		});

		await expect(client.start()).rejects.toThrow(/Unknown provider.*__missing_provider__/);
	});
	test("launcher builder receives the complete agent argv", async () => {
		let received: string[] | undefined;
		using client = new RpcClient({
			command: args => {
				received = args;
				return [process.execPath, "--eval", "process.exit(1)"];
			},
			provider: "openrouter",
			model: "example/model",
			args: ["--no-session"],
		});

		await expect(client.start()).rejects.toThrow(/exited with code 1/);
		expect(received).toEqual([
			"--mode",
			"rpc",
			"--provider",
			"openrouter",
			"--model",
			"example/model",
			"--no-session",
		]);
	});
});

describe("RpcClient stdin failures", () => {
	test("fails the request and stops the client when write rejects and flush throws", async () => {
		const exited = Promise.withResolvers<number>();
		const proc: RpcAgentProcess & { stdin: { flush(): never } } = {
			stdin: {
				// A pending pipe write rejects with EPIPE once the agent is gone; flush() can throw synchronously.
				write: () => Promise.reject(new Error("EPIPE: broken pipe, write")),
				flush: () => {
					throw new Error("flush failed");
				},
			},
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "ready" })}\n`));
				},
			}),
			peekStderr: () => "",
			kill: () => exited.resolve(0),
			exited: exited.promise,
		};
		using client = new RpcClient({ spawn: () => proc });
		await client.start();

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(client.getState()).rejects.toThrow("flush failed");
			// Unhandled rejections are reported once the microtask queue drains; one macrotask turn suffices.
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			expect(unhandled).toEqual([]);
			// The broken pipe is terminal: the agent is killed and the client no longer accepts commands.
			expect(await exited.promise).toBe(0);
			await expect(client.getState()).rejects.toThrow("Client not started");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("rejects a non-serializable command without stopping a healthy client", async () => {
		const exited = Promise.withResolvers<number>();
		let killed = false;
		const proc: RpcAgentProcess = {
			stdin: { write: () => 0 },
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "ready" })}\n`));
				},
			}),
			peekStderr: () => "",
			kill: () => {
				killed = true;
				exited.resolve(0);
			},
			exited: exited.promise,
		};
		using client = new RpcClient({ spawn: () => proc });
		await client.start();

		// A serialization error is not a pipe failure: only this request fails.
		await expect(client.goal("create", { tokenBudget: 1n as unknown as number })).rejects.toThrow(TypeError);
		expect(killed).toBe(false);
	});

	test("still stops the client when killing the agent throws during pipe-failure cleanup", async () => {
		const proc: RpcAgentProcess = {
			stdin: { write: () => Promise.reject(new Error("EPIPE: broken pipe, write")) },
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "ready" })}\n`));
				},
			}),
			peekStderr: () => "",
			kill: () => {
				throw new Error("kill failed");
			},
			exited: Promise.withResolvers<number>().promise,
		};
		using client = new RpcClient({ spawn: () => proc });
		await client.start();

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(client.getState()).rejects.toThrow("EPIPE");
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			expect(unhandled).toEqual([]);
			await expect(client.getState()).rejects.toThrow("Client not started");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("drops a manual login code that arrives after the client stopped", async () => {
		const exited = Promise.withResolvers<number>();
		const encoder = new TextEncoder();
		let stdout!: ReadableStreamDefaultController<Uint8Array>;
		const written: string[] = [];
		const proc: RpcAgentProcess = {
			stdin: { write: (data: string) => written.push(data) },
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					stdout = controller;
					controller.enqueue(encoder.encode(`${JSON.stringify({ type: "ready" })}\n`));
				},
			}),
			peekStderr: () => "",
			kill: () => exited.resolve(0),
			exited: exited.promise,
		};
		using client = new RpcClient({ spawn: () => proc });
		await client.start();

		const code = Promise.withResolvers<string>();
		const prompted = Promise.withResolvers<void>();
		const login = client.login("test-provider", {
			onManualCodeInput: () => {
				prompted.resolve();
				return code.promise;
			},
		});
		const loginId = (JSON.parse(written[0]!) as { id: string }).id;
		stdout.enqueue(
			encoder.encode(
				`${JSON.stringify({ type: "extension_ui_request", id: "ui_1", loginId, method: "input", title: "Paste code" })}\n`,
			),
		);
		await prompted.promise;

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			// The client stops (as it does on a broken stdin pipe) while the user is still typing the code.
			await client.stop();
			await expect(login).rejects.toThrow("Client stopped");
			const writesBefore = written.length;
			code.resolve("pasted-code");
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			expect(unhandled).toEqual([]);
			expect(written.length).toBe(writesBefore);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("does not route concurrent secret extension input requests to login onManualCodeInput", async () => {
		const exited = Promise.withResolvers<number>();
		const encoder = new TextEncoder();
		let stdout!: ReadableStreamDefaultController<Uint8Array>;
		const written: string[] = [];
		const proc: RpcAgentProcess = {
			stdin: { write: (data: string) => written.push(data) },
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					stdout = controller;
					controller.enqueue(encoder.encode(`${JSON.stringify({ type: "ready" })}\n`));
				},
			}),
			peekStderr: () => "",
			kill: () => exited.resolve(0),
			exited: exited.promise,
		};
		using client = new RpcClient({ spawn: () => proc });
		await client.start();

		const manualPrompts: string[] = [];
		const login = client.login("test-provider", {
			onManualCodeInput: ({ title }) => {
				manualPrompts.push(title);
				return "oauth-code";
			},
		});
		const loginId = (JSON.parse(written[0]!) as { id: string }).id;

		// Concurrent extension secret input request arrives while login is waiting:
		stdout.enqueue(
			encoder.encode(
				`${JSON.stringify({
					type: "extension_ui_request",
					id: "ui_secret",
					method: "input",
					title: "Enter API key",
					secret: true,
				})}\n`,
			),
		);
		// Followed by the actual non-secret OAuth code input request:
		stdout.enqueue(
			encoder.encode(
				`${JSON.stringify({
					type: "extension_ui_request",
					id: "ui_oauth",
					method: "input",
					title: "Paste authorization code",
					loginId,
				})}\n`,
			),
		);

		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;

		expect(manualPrompts).toEqual(["Paste authorization code"]);
		const responses = written
			.map(line => JSON.parse(line.trim()) as { type: string; id?: string; value?: string })
			.filter(frame => frame.type === "extension_ui_response");
		expect(responses).toEqual([
			{
				type: "extension_ui_response",
				id: "ui_oauth",
				value: "oauth-code",
			},
		]);

		await client.stop();
		await expect(login).rejects.toThrow("Client stopped");
	});
});
