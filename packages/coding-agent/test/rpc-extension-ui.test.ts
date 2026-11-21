import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import {
	dispatchRpcControlFrame,
	type PendingExtensionRequest,
	type RpcInputFrameDeps,
	type RpcExtensionUIResponse,
	requestRpcAskDialog,
	requestRpcDialog,
	requestRpcFormDialog,
	requestRpcInput,
	requestRpcSelect,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

function requireRequest(frame: object | undefined): { id: string } {
	if (!frame || !("id" in frame)) {
		throw new Error("Expected the RPC dialog request to carry an id");
	}
	const id = frame.id;
	if (typeof id !== "string") throw new Error("Expected the RPC dialog request id to be a string");
	return { id };
}

function respond(pendingRequests: Map<string, PendingExtensionRequest>, id: string, payload: object): void {
	const request = pendingRequests.get(id);
	if (!request) throw new Error(`Expected pending RPC dialog request ${id}`);
	request.resolve({ type: "extension_ui_response", id, ...payload } as RpcExtensionUIResponse);
}

const dbQuestion: ExtensionAskDialogQuestion = {
	id: "db",
	question: "Which database?",
	options: [{ label: "Postgres" }, { label: "SQLite", description: "Embedded" }],
	recommended: 1,
};
const featuresQuestion: ExtensionAskDialogQuestion = {
	id: "features",
	question: "Which features?",
	options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }],
	multi: true,
};

/**
 * Scripted model: a user message ending in ask arguments as JSON becomes an ask call (omp may prepend
 * context to the first user message); a tool result ends the turn.
 */
const scriptedAskProvider = `
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";

export default function (pi) {
	pi.registerProvider("scripted", {
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "scripted-key",
		api: "scripted-ask",
		models: [{
			id: "ask",
			name: "Scripted ask",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 1024,
		}],
		streamSimple: (model, context) => {
			const stream = createAssistantMessageEventStream();
			const last = context.messages.findLast(entry => entry.role === "user" || entry.role === "toolResult");
			const text = last?.role === "user" ? last.content.map(part => part.text ?? "").join("") : "";
			const argsAt = text.indexOf('{"questions"');
			const message = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				timestamp: Date.now(),
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
			};
			stream.push({ type: "start", partial: message });
			if (argsAt >= 0) {
				const toolCall = { type: "toolCall", id: "ask-" + context.messages.length, name: "ask", arguments: JSON.parse(text.slice(argsAt)) };
				message.content = [toolCall];
				message.stopReason = "toolUse";
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
			}
			stream.push({ type: "done", reason: message.stopReason, message });
			return stream;
		},
	});
}
`;

describe("RPC extension UI", () => {
	it("keeps extension dialogs headless while tool selections round-trip", async () => {
		await using temp = await TempDir.create("@rpc-headless-tool-ui-");
		const fixturePath = temp.join("runtime.ts");
		const sourceDir = path.resolve(import.meta.dir, "../src");
		await Bun.write(
			fixturePath,
			`
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};
globalThis.fetch = async () => { throw new Error("Offline UI fixture refuses network"); };
let extensionState;
const { session } = await createAgentSession({
  cwd: process.cwd(),
  toolNames: [],
  enableMCP: false,
  enableLsp: false,
  disableExtensionDiscovery: true,
  settings: Settings.isolated({ "compaction.enabled": false }),
  extensions: [pi => {
    pi.on("session_start", async (_event, ctx) => {
      const confirmed = await ctx.ui.confirm("Extension confirm", "Must not reach the host");
      ctx.ui.notify("Extension notification");
      extensionState = { hasUI: ctx.hasUI, confirmed };
    });
  }],
});
await runRpcMode(session, {
  headless: true,
  setToolUIContext(ui, hasUI) {
    void ui.select("Tool choice", ["Keep", "Deploy"]).then(selected => {
      ui.notify(JSON.stringify({ toolHasUI: hasUI, selected, extension: extensionState }));
    });
  },
});
`,
		);
		const child = Bun.spawn([process.execPath, fixturePath], {
			cwd: temp.path(),
			env: {
				PATH: Bun.env.PATH,
				BUN_BE_BUN: "1",
				HOME: temp.join("home"),
				PI_CODING_AGENT_DIR: temp.join("agent"),
				XDG_CONFIG_HOME: temp.join("config"),
				XDG_DATA_HOME: temp.join("data"),
				XDG_CACHE_HOME: temp.join("cache"),
				CI: "true",
				PI_NO_TITLE: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 20_000,
		});
		const stderr = new Response(child.stderr).text();
		const requests: Record<string, unknown>[] = [];
		let result: unknown;
		try {
			for await (const frame of readJsonl<unknown>(child.stdout)) {
				if (!isRecord(frame) || frame.type !== "extension_ui_request") continue;
				requests.push(frame);
				if (frame.method === "select") {
					child.stdin.write(
						`${JSON.stringify({ type: "extension_ui_response", id: frame.id, value: "Deploy" })}\n`,
					);
					await child.stdin.flush();
				} else if (frame.method === "notify") {
					if (typeof frame.message === "string") result = JSON.parse(frame.message);
					break;
				} else {
					throw new Error(`Unexpected extension UI: ${JSON.stringify(frame)}`);
				}
			}
		} finally {
			child.stdin.end();
			await child.exited;
		}
		expect(result, await stderr).toEqual({
			toolHasUI: true,
			selected: "Deploy",
			extension: { hasUI: false, confirmed: false },
		});
		expect(requests.map(frame => frame.method)).toEqual(["select", "notify"]);
		expect(requests[0]).toMatchObject({ title: "Tool choice", options: ["Keep", "Deploy"] });
	}, 30_000);

	/** Spawns an RPC runtime whose extension awaits a `confirm` in `session_start` and has a `/probe` command. */
	async function spawnStartupDialogRuntime(temp: TempDir, extraExtensionSetup = "") {
		const fixturePath = temp.join("runtime.ts");
		const sourceDir = path.resolve(import.meta.dir, "../src");
		await Bun.write(
			fixturePath,
			`
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};
globalThis.fetch = async () => { throw new Error("Offline UI fixture refuses network"); };
const { session } = await createAgentSession({
  cwd: process.cwd(),
  toolNames: [],
  enableMCP: false,
  enableLsp: false,
  disableExtensionDiscovery: true,
  settings: Settings.isolated({ "compaction.enabled": false }),
  extensions: [pi => {
    pi.registerCommand("probe", {
      // A command's context is built per call, so it sees whether set_ask_dialog took effect.
      handler: async (_args, ctx) => ctx.ui.notify("askDialog:" + typeof ctx.ui.askDialog),
    });
    ${extraExtensionSetup}
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(String(await ctx.ui.confirm("Trust?", "startup")));
    });
  }],
});
await runRpcMode(session);
`,
		);
		return Bun.spawn([process.execPath, fixturePath], {
			cwd: temp.path(),
			env: {
				PATH: Bun.env.PATH,
				BUN_BE_BUN: "1",
				HOME: temp.join("home"),
				PI_CODING_AGENT_DIR: temp.join("agent"),
				XDG_CONFIG_HOME: temp.join("config"),
				XDG_DATA_HOME: temp.join("data"),
				XDG_CACHE_HOME: temp.join("cache"),
				CI: "true",
				PI_NO_TITLE: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 20_000,
		});
	}

	it("negotiates extension Form independently and keeps legacy select and editor after opting out", async () => {
		await using temp = await TempDir.create("@rpc-startup-form-");
		const child = await spawnStartupDialogRuntime(
			temp,
			`
    pi.registerCommand("form-probe", {
      handler: async (_args, ctx) => {
        const html = '<form><fieldset><legend>Database</legend><select name="db" required><option value="pg" selected>Postgres</option><option value="mysql" disabled>MySQL</option></select><input type="number" name="size" value="2" min="1" max="8"><input type="hidden" name="context" value="server"></fieldset></form>';
        if (ctx.ui.formDialog) {
          ctx.ui.notify(JSON.stringify(await ctx.ui.formDialog(html)));
        } else if (await ctx.ui.select("Database", ["Postgres"]) === "Postgres") {
          const size = await ctx.ui.editor("Size", "2");
          ctx.ui.notify(JSON.stringify({ data: { db: "pg", size: Number(size), context: "server" } }));
        }
      },
    });
`,
		);
		const stderr = new Response(child.stderr).text();
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};
		const methods: unknown[] = [];
		const results: unknown[] = [];
		const negotiation: unknown[] = [];
		try {
			for await (const frame of readJsonl<unknown>(child.stdout)) {
				if (!isRecord(frame)) continue;
				if (frame.type === "response" && frame.command === "set_form_dialog") {
					negotiation.push(frame.data);
					continue;
				}
				if (frame.type !== "extension_ui_request") continue;
				switch (frame.method) {
					case "confirm":
						// Negotiate before the extension releases its startup prompt.
						await send({ type: "set_form_dialog", id: "on", enabled: true });
						await send({ type: "extension_ui_response", id: frame.id, confirmed: true });
						await send({ type: "prompt", id: "rich", message: "/form-probe" });
						break;
					case "form":
						methods.push(frame.method);
						expect(frame).toMatchObject({
							sections: [
								{
									title: [{ text: "Database" }],
									blocks: [
										{
											kind: "field",
											field: {
												kind: "choice",
												name: "db",
												required: true,
												options: [
													{ value: "pg", checked: true },
													{ value: "mysql", disabled: true },
												],
											},
										},
										{ kind: "field", field: { kind: "text", name: "size", min: 1, max: 8 } },
									],
								},
							],
							hidden: [{ name: "context", value: "server" }],
						});
						await send({ type: "extension_ui_response", id: frame.id, data: { db: "pg", size: 4 } });
						break;
					case "select":
						methods.push(frame.method);
						expect(frame).toMatchObject({ title: "Database", options: ["Postgres"] });
						await send({ type: "extension_ui_response", id: frame.id, value: "Postgres" });
						break;
					case "editor":
						methods.push(frame.method);
						expect(frame).toMatchObject({ title: "Size", prefill: "2" });
						await send({ type: "extension_ui_response", id: frame.id, value: "5" });
						break;
					case "notify":
						if (typeof frame.message !== "string" || !frame.message.startsWith("{")) break;
						results.push(JSON.parse(frame.message));
						if (results.length === 1) {
							await send({ type: "set_form_dialog", id: "off", enabled: false });
							await send({ type: "prompt", id: "legacy", message: "/form-probe" });
						} else {
							child.stdin.end();
						}
						break;
				}
			}
		} finally {
			child.stdin.end();
			await child.exited;
		}
		expect(negotiation, await stderr).toEqual([{ enabled: true }, { enabled: false }]);
		expect(methods).toEqual(["form", "select", "editor"]);
		expect(results).toEqual([
			{ data: { db: "pg", size: 4, context: "server" } },
			{ data: { db: "pg", size: 5, context: "server" } },
		]);
	}, 30_000);

	it("answers a dialog session_start awaits, running commands sent meanwhile only after startup, in order", async () => {
		await using temp = await TempDir.create("@rpc-startup-dialog-");
		const child = await spawnStartupDialogRuntime(temp);
		const stderr = new Response(child.stderr).text();
		const seen: string[] = [];
		let confirmId: unknown;
		for await (const frame of readJsonl<unknown>(child.stdout)) {
			if (!isRecord(frame)) continue;
			if (frame.type === "extension_ui_request" && frame.method === "confirm") {
				confirmId = frame.id;
				// Held until startup finishes (had one run at once, its response would precede the confirm's
				// notify) and then run in arrival order. set_ask_dialog is served during startup and takes effect.
				for (const id of ["s1", "s2"]) child.stdin.write(`${JSON.stringify({ id, type: "get_state" })}\n`);
				child.stdin.write(`${JSON.stringify({ id: "p", type: "prompt", message: "/probe" })}\n`);
				child.stdin.write(`${JSON.stringify({ id: "s3", type: "get_state" })}\n`);
				child.stdin.write(`${JSON.stringify({ id: "ask", type: "set_ask_dialog", enabled: true })}\n`);
				await child.stdin.flush();
			} else if (frame.type === "response" && frame.id === "ask") {
				seen.push("ask");
				child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: confirmId, confirmed: true })}\n`);
				await child.stdin.flush();
			} else if (frame.type === "extension_ui_request" && frame.method === "notify") {
				seen.push(String(frame.message));
			} else if (frame.type === "response" && typeof frame.id === "string" && /^(s\d|p)$/.test(frame.id)) {
				seen.push(`${frame.id}:${frame.success}`);
				// Drain stdout to its end: closing the reader early would break the child's output pipe.
				if (frame.id === "s3") child.stdin.end();
			}
		}
		await child.exited;
		// The probe's own frames race the later state responses; every other frame's order is fixed.
		expect(
			seen.filter(entry => entry !== "p:true" && entry !== "askDialog:function"),
			await stderr,
		).toEqual(["ask", "true", "s1:true", "s2:true", "s3:true"]);
		expect(seen).toContain("askDialog:function");
	}, 30_000);

	it("rejects a dialog session_start awaits when stdin closes, so the process still exits", async () => {
		await using temp = await TempDir.create("@rpc-startup-dialog-eof-");
		const child = await spawnStartupDialogRuntime(temp);
		const stderr = new Response(child.stderr).text();
		// Read to the end of stdout: closing it early would fail the child's output, not exercise the EOF.
		for await (const frame of readJsonl<unknown>(child.stdout)) {
			if (isRecord(frame) && frame.type === "extension_ui_request" && frame.method === "confirm") child.stdin.end();
		}
		const exitCode = await child.exited;
		expect({ exitCode, signal: child.signalCode }, await stderr).toEqual({ exitCode: 0, signal: null });
	}, 30_000);

	it("keeps the label-only wire shape for bare options", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcSelect(pendingRequests, output, "Action", ["Keep", "Deploy"]);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: request.id,
			method: "select",
			title: "Action",
			options: ["Keep", "Deploy"],
			timeout: undefined,
		});

		respond(pendingRequests, request.id, { value: "Keep" });
		expect(await result).toBe("Keep");
	});

	it("emits aligned descriptions and resolves with the selected label", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcSelect(pendingRequests, output, "Action", [
			"Keep",
			{ label: "Deploy", description: " Push to production " },
			{ label: "Preview", description: "   " },
		]);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: request.id,
			method: "select",
			title: "Action",
			options: ["Keep", "Deploy", "Preview"],
			optionDetails: [{}, { description: "Push to production" }, {}],
			timeout: undefined,
		});

		respond(pendingRequests, request.id, { value: "Deploy" });
		expect(await result).toBe("Deploy");
	});

	it("carries checkbox state so hosts can show which options are already checked", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const checkedIndices = [0, 1];
		const result = requestRpcSelect(
			pendingRequests,
			output,
			"(2 selected) Choose enabled jobs",
			["pytest", "go-quality", "lint", "Other (type your own)", "Done selecting"],
			{ initialIndex: 2, selectionMarker: "checkbox", checkedIndices, markableCount: 4 },
		);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		expect(JSON.parse(JSON.stringify(output.mock.calls[0]?.[0]))).toEqual({
			type: "extension_ui_request",
			id: request.id,
			method: "select",
			title: "(2 selected) Choose enabled jobs",
			options: ["pytest", "go-quality", "lint", "Other (type your own)", "Done selecting"],
			initialIndex: 2,
			selectionMarker: "checkbox",
			checkedIndices: [0, 1],
			markableCount: 4,
		});

		respond(pendingRequests, request.id, { value: "lint" });
		expect(await result).toBe("lint");
	});

	it("cancels the remote dialog when its signal aborts", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const controller = new AbortController();
		const result = requestRpcDialog(
			pendingRequests,
			output,
			{ signal: controller.signal },
			false,
			{ method: "confirm", title: "High-risk command", message: "Allow this command?" },
			response => ("confirmed" in response ? response.confirmed : false),
		);
		const request = output.mock.calls[0]?.[0];
		if (!request || !("id" in request) || typeof request.id !== "string") {
			throw new Error("Expected the RPC dialog request to carry an id");
		}

		controller.abort();

		expect(await result).toBe(false);
		expect(output).toHaveBeenNthCalledWith(1, {
			type: "extension_ui_request",
			id: request.id,
			method: "confirm",
			title: "High-risk command",
			message: "Allow this command?",
		});
		expect(output).toHaveBeenNthCalledWith(2, {
			type: "extension_ui_request",
			id: expect.any(String),
			method: "cancel",
			targetId: request.id,
		});
		expect(pendingRequests.size).toBe(0);
	});

	it("emits secret in extension_ui_request when dialogOptions.secret is provided", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();

		// 1. undefined secret: omitted from wire payload
		const unmaskedResult = requestRpcInput(pendingRequests, output, "Username", "e.g. alice");
		const unmaskedRequest = output.mock.calls[0]?.[0];
		expect(unmaskedRequest).toMatchObject({
			type: "extension_ui_request",
			method: "input",
			title: "Username",
			placeholder: "e.g. alice",
		});
		expect(unmaskedRequest).not.toHaveProperty("secret");
		respond(pendingRequests, requireRequest(unmaskedRequest).id, { value: "alice" });
		await unmaskedResult;

		// 2. secret: true: included in wire payload as secret: true
		const maskedResult = requestRpcInput(pendingRequests, output, "API Key", undefined, { secret: true });
		const maskedRequest = output.mock.calls[1]?.[0];
		expect(maskedRequest).toMatchObject({
			type: "extension_ui_request",
			method: "input",
			title: "API Key",
			secret: true,
		});
		respond(pendingRequests, requireRequest(maskedRequest).id, { value: "secret-token" });
		await maskedResult;

		// 3. secret: false: explicitly passed as secret: false
		const explicitUnmaskedResult = requestRpcInput(pendingRequests, output, "Public Note", undefined, {
			secret: false,
		});
		const explicitUnmaskedRequest = output.mock.calls[2]?.[0];
		expect(explicitUnmaskedRequest).toMatchObject({
			type: "extension_ui_request",
			method: "input",
			title: "Public Note",
			secret: false,
		});
		respond(pendingRequests, requireRequest(explicitUnmaskedRequest).id, { value: "hello" });
		await explicitUnmaskedResult;
	});

	it("preserves secret OAuth prompt metadata and logs out only the requested account", async () => {
		await using temp = await TempDir.create("@rpc-login-");
		const extensionPath = temp.join("login.mjs");
		await Bun.write(
			extensionPath,
			`
export default function(pi) {
  globalThis.fetch = async () => { throw new Error("Offline login fixture refuses network"); };
  // rpc-alias is a second login for rpc-ordinary's credentials, like openai-codex-device.
  for (const [id, secret, storeCredentialsAs] of [["rpc-secret", true], ["rpc-ordinary", false], ["rpc-alias", false, "rpc-ordinary"]]) {
    pi.registerProvider(id, {
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-completions",
      models: [{
        id: "fixture",
        name: "Offline fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 4096,
        maxTokens: 512,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }],
      oauth: {
        name: id,
        storeCredentialsAs,
        login: async callbacks => {
          callbacks.onAuth({ url: "https://example.invalid/authorize" });
          return callbacks.onPrompt({ message: id, ...(secret ? { secret: true } : {}) });
        }
      }
    });
  }
}
`,
		);
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "..", "src", "cli.ts"),
				"--trusted-extension",
				extensionPath,
				"--mode",
				"rpc",
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet-4-5",
			],
			{
				cwd: temp.path(),
				env: {
					PATH: Bun.env.PATH,
					BUN_BE_BUN: "1",
					HOME: temp.join("home"),
					PI_CODING_AGENT_DIR: temp.join("agent"),
					XDG_CONFIG_HOME: temp.join("config"),
					XDG_DATA_HOME: temp.join("data"),
					XDG_CACHE_HOME: temp.join("cache"),
					CI: "true",
					PI_NO_TITLE: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 20_000,
			},
		);
		const stdout = new Response(child.stdout).body;
		if (!stdout) throw new Error("RPC login fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();
		const inputs: { title: string; secret: boolean; loginId: unknown }[] = [];
		let secretResponse: unknown;
		let ordinaryResponse: unknown;
		let loggedInProvidersResponse: unknown;
		let noProviderResponse: unknown;
		let accountsResponse: unknown;
		let logoutResponse: unknown;
		let staleLogoutResponse: unknown;
		let providersResponse: unknown;
		let loggedOutCredentialId: unknown;
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};

		try {
			await send({ type: "login", providerId: "rpc-secret", id: "secret", allowSecretInput: true });
			for await (const frame of readJsonl<unknown>(stdout)) {
				if (!isRecord(frame)) continue;
				if (frame.type === "extension_ui_request" && frame.method === "input") {
					if (typeof frame.id !== "string" || typeof frame.title !== "string") {
						throw new Error("RPC input request did not carry string id and title");
					}
					inputs.push({ title: frame.title, secret: frame.secret === true, loginId: frame.loginId });
					await send({ type: "extension_ui_response", id: frame.id, value: crypto.randomUUID() });
				} else if (frame.type === "response" && frame.id === "secret") {
					secretResponse = frame;
					await send({ type: "login", providerId: "rpc-ordinary", id: "ordinary" });
				} else if (frame.type === "response" && frame.id === "ordinary") {
					ordinaryResponse = frame;
					await send({ type: "get_login_providers", id: "loggedIn" });
				} else if (frame.type === "response" && frame.id === "loggedIn") {
					loggedInProvidersResponse = frame;
					await send({ type: "get_logout_accounts", providerId: "rpc-alias", id: "accounts" });
				} else if (frame.type === "response" && frame.id === "accounts") {
					accountsResponse = frame;
					const accounts = isRecord(frame.data) && Array.isArray(frame.data.accounts) ? frame.data.accounts : [];
					loggedOutCredentialId = isRecord(accounts[0]) ? accounts[0].credentialId : undefined;
					await send({
						type: "logout",
						providerId: "rpc-alias",
						credentialId: loggedOutCredentialId,
						id: "logout",
					});
				} else if (frame.type === "response" && frame.id === "logout") {
					logoutResponse = frame;
					await send({
						type: "logout",
						providerId: "rpc-ordinary",
						credentialId: loggedOutCredentialId,
						id: "stale",
					});
				} else if (frame.type === "response" && frame.id === "stale") {
					staleLogoutResponse = frame;
					// Without a provider the credential store would list every provider's accounts.
					await send({ type: "get_logout_accounts", id: "noProvider" });
				} else if (frame.type === "response" && frame.id === "noProvider") {
					noProviderResponse = frame;
					await send({ type: "get_login_providers", id: "providers" });
				} else if (frame.type === "response" && frame.id === "providers") {
					providersResponse = frame;
					break;
				}
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
		}

		if (!providersResponse) throw new Error(`RPC login fixture did not finish: ${await stderr}`);
		await stderr;
		expect(secretResponse).toMatchObject({
			type: "response",
			command: "login",
			success: true,
		});
		expect(inputs).toEqual([
			{ title: "rpc-secret", secret: true, loginId: "secret" },
			{ title: "rpc-ordinary", secret: false, loginId: "ordinary" },
		]);
		expect(ordinaryResponse).toMatchObject({ type: "response", command: "login", success: true });
		expect(loggedInProvidersResponse).toMatchObject({
			data: {
				providers: expect.arrayContaining([
					expect.objectContaining({ id: "rpc-secret", authenticated: true }),
					expect.objectContaining({ id: "rpc-ordinary", authenticated: true }),
					// The alias stores under rpc-ordinary, so it is authenticated by the same credential.
					expect.objectContaining({ id: "rpc-alias", authenticated: true }),
				]),
			},
		});
		expect(accountsResponse).toMatchObject({
			success: true,
			data: { accounts: [expect.objectContaining({ provider: "rpc-ordinary", active: true })] },
		});
		expect(logoutResponse).toEqual({ id: "logout", type: "response", command: "logout", success: true, data: {} });
		expect(staleLogoutResponse).toMatchObject({
			command: "logout",
			success: false,
			code: "invalid_value",
		});
		expect(noProviderResponse).toMatchObject({ command: "get_logout_accounts", success: false });
		expect(providersResponse).toMatchObject({
			success: true,
			data: {
				providers: expect.arrayContaining([
					expect.objectContaining({ id: "rpc-secret", authenticated: true }),
					expect.objectContaining({ id: "rpc-ordinary", authenticated: false }),
					expect.objectContaining({ id: "rpc-alias", authenticated: false }),
				]),
			},
		});
	}, 30_000);

	it("routes a provider's login-warning acceptance to the host before any auth URL (#19523)", async () => {
		await using temp = await TempDir.create("@rpc-login-warning-");
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "..", "src", "cli.ts"),
				"--mode",
				"rpc",
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet-4-5",
			],
			{
				cwd: temp.path(),
				env: {
					PATH: Bun.env.PATH,
					HOME: temp.join("home"),
					PI_CODING_AGENT_DIR: temp.join("agent"),
					XDG_CONFIG_HOME: temp.join("config"),
					XDG_DATA_HOME: temp.join("data"),
					XDG_CACHE_HOME: temp.join("cache"),
					CI: "true",
					PI_NO_TITLE: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 20_000,
			},
		);
		const stdout = new Response(child.stdout).body;
		if (!stdout) throw new Error("RPC login fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};
		const inputTitles: string[] = [];
		let loginResponse: unknown;
		try {
			// antigravity-cli declares `login-warning`; declining it must cancel before any login work starts.
			await send({ type: "login", providerId: "antigravity-cli", id: "login" });
			for await (const frame of readJsonl<unknown>(stdout)) {
				if (!isRecord(frame)) continue;
				if (frame.type === "extension_ui_request" && frame.method === "input") {
					if (typeof frame.id !== "string" || typeof frame.title !== "string") {
						throw new Error("RPC input request did not carry string id and title");
					}
					inputTitles.push(frame.title);
					await send({ type: "extension_ui_response", id: frame.id, value: "no" });
				} else if (frame.type === "response" && frame.id === "login") {
					loginResponse = frame;
					break;
				}
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
		}

		if (!loginResponse) throw new Error(`RPC login fixture did not finish: ${await stderr}`);
		await stderr;
		expect(inputTitles).toEqual([expect.stringContaining("use at your own risk")]);
		expect(loginResponse).toMatchObject({
			type: "response",
			command: "login",
			success: false,
			error: "Login cancelled",
		});
	}, 30_000);
});

describe("RPC form dialog", () => {
	const html = `<form><input type="hidden" name="context" value="server">
		<fieldset><legend>Database</legend><p>Choose storage</p>
			<select name="db" required><option selected value="pg">Postgres</option>
			<option disabled value="mysql">MySQL</option></select>
		</fieldset>
		<fieldset><legend>Settings</legend>
			<input name="size" type="number" value="2" min="1" max="8" required>
			<textarea name="memo" maxlength="50">example</textarea>
			<label><input name="features" type="checkbox" value="auth">Auth</label>
			<label><input name="features" type="checkbox" value="search">Search</label>
		</fieldset></form>`;
	const form = parseHtmlForm(html);

	it("sends one parsed form and preserves typed submissions, notes, and server-side hidden values", async () => {
		const pending = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const onTimeout = vi.fn();
		const result = requestRpcFormDialog(pending, output, form, { onTimeout, acceptImages: true });
		const request = requireRequest(output.mock.calls[0]?.[0]);
		const db = {
			kind: "field",
			field: {
				kind: "choice",
				name: "db",
				required: true,
				options: [
					{ value: "pg", checked: true, disabled: false },
					{ value: "mysql", checked: false, disabled: true },
				],
			},
		};
		expect(output).toHaveBeenCalledTimes(1);
		expect(output.mock.calls[0]?.[0]).not.toHaveProperty("html");
		expect(output.mock.calls[0]?.[0]).toMatchObject({
			type: "extension_ui_request",
			method: "form",
			id: request.id,
			acceptImages: true,
			hidden: [{ name: "context", value: "server" }],
			sections: [
				{ title: [{ text: "Database" }], blocks: [{ kind: "text", spans: [{ text: "Choose storage" }] }, db] },
				{
					title: [{ text: "Settings" }],
					blocks: [
						{ kind: "field", field: { kind: "text", name: "size", value: "2", min: 1, max: 8, required: true } },
						{ kind: "field", field: { kind: "text", name: "memo", multiline: true, maxLength: 50 } },
						{ kind: "field", field: { kind: "choice", name: "features", multi: true } },
					],
				},
			],
		});

		const notes = [
			{
				name: "db",
				question: "Choose storage",
				option: "Postgres",
				value: "pg",
				text: "Existing instance [Image #1, 1x1]",
				images: [{ type: "image" as const, data: "AA==", mimeType: "image/png" }],
			},
		];
		respond(pending, request.id, {
			data: { db: "pg", size: 4, memo: "done", features: ["auth", "search"], context: "overwritten" },
			notes,
			timedOut: true,
		});
		expect(await result).toEqual({
			data: { db: "pg", size: 4, memo: "done", features: ["auth", "search"], context: "server" },
			notes,
			timedOut: true,
		});
		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(pending.size).toBe(0);
	});

	it.each(["dismiss", "abort", "expire"] as const)("settles only the matching form on %s", async outcome => {
		const pending = new Map<string, PendingExtensionRequest>();
		const frames: object[] = [];
		const controller = new AbortController();
		const onTimeout = vi.fn(() => controller.abort());
		const output = (frame: object) => void frames.push(frame);
		const frameDeps: RpcInputFrameDeps = {
			pendingExtensionRequests: pending,
			output,
			handleCommand: vi.fn(),
			errorResponse: vi.fn(),
			onHostToolResult: vi.fn(),
			onHostToolUpdate: vi.fn(),
			onHostUriResult: vi.fn(),
			onToolApprovalResponse: vi.fn(),
			onPlanProposalResponse: vi.fn(),
		};
		const result = requestRpcFormDialog(pending, output, form, {
			signal: controller.signal,
			timeout: outcome === "expire" ? 5 : 1000,
			onTimeout,
		});
		const { id } = requireRequest(frames[0]);
		const next = requestRpcFormDialog(pending, output, parseHtmlForm(`<input name="other">`));
		const nextId = requireRequest(frames[1]).id;
		if (outcome === "dismiss") {
			dispatchRpcControlFrame({ type: "extension_ui_response", id, cancelled: true }, frameDeps);
		} else if (outcome === "abort") {
			controller.abort();
		}
		expect(await result).toEqual(
			outcome === "expire"
				? { data: { db: "pg", memo: "example", size: 2, features: [], context: "server" }, timedOut: true }
				: undefined,
		);
		controller.abort();
		expect(onTimeout).toHaveBeenCalledTimes(outcome === "expire" ? 1 : 0);
		expect(frames.slice(2)).toEqual(
			outcome === "dismiss"
				? []
				: [expect.objectContaining({ type: "extension_ui_request", method: "cancel", targetId: id })],
		);

		// An answer to the closed request is ignored even while another form is waiting.
		expect(dispatchRpcControlFrame({ type: "extension_ui_response", id, data: { other: "stale" } }, frameDeps)).toBe(
			true,
		);
		expect(pending.size).toBe(1);
		dispatchRpcControlFrame({ type: "extension_ui_response", id: nextId, data: { other: "new" } }, frameDeps);
		expect(await next).toEqual({ data: { other: "new" } });
		expect(pending.size).toBe(0);
	});
});

describe("RPC ask dialog", () => {
	it("sends every question in one ask frame and returns the validated answers", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion, featuresQuestion]);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		expect(output).toHaveBeenCalledTimes(1);
		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: request.id,
			method: "ask",
			questions: [dbQuestion, featuresQuestion],
			timeout: undefined,
		});

		respond(pendingRequests, request.id, {
			answers: [
				{ id: "db", selectedOptions: ["Postgres"], customInput: "   " },
				{ id: "features", selectedOptions: ["Search", "Auth"], customInput: "  Export  " },
			],
		});
		expect(await result).toEqual({
			kind: "submit",
			results: [
				{
					id: "db",
					question: "Which database?",
					options: ["Postgres", "SQLite"],
					multi: false,
					selectedOptions: ["Postgres"],
					customInput: undefined,
				},
				{
					id: "features",
					question: "Which features?",
					options: ["Auth", "Billing", "Search"],
					multi: true,
					selectedOptions: ["Search", "Auth"],
					customInput: "Export",
				},
			],
		});
	});

	const validDb = { id: "db", selectedOptions: ["Postgres"] };
	const validFeatures = { id: "features", selectedOptions: ["Auth"] };
	it.each([
		["too few answers", [validDb]],
		["answers out of question order", [validFeatures, validDb]],
		["an unknown option label", [{ id: "db", selectedOptions: ["MySQL"] }, validFeatures]],
		["a duplicated option", [validDb, { id: "features", selectedOptions: ["Auth", "Auth"] }]],
		["two options on a single-select", [{ id: "db", selectedOptions: ["Postgres", "SQLite"] }, validFeatures]],
		[
			"an option plus custom input on a single-select",
			[{ id: "db", selectedOptions: ["Postgres"], customInput: "DuckDB" }, validFeatures],
		],
	])("rejects %s", async (_case, answers) => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion, featuresQuestion]);

		respond(pendingRequests, requireRequest(output.mock.calls[0]?.[0]).id, { answers });

		await expect(result).rejects.toThrow(Error);
		expect(pendingRequests.size).toBe(0);
	});

	it.each([
		["omp's timer fires", 5, undefined],
		["the host reports its own timeout", undefined, { cancelled: true, timedOut: true }],
	])("answers every question with its recommended option when %s", async (_case, timeout, response) => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const onTimeout = vi.fn();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion, featuresQuestion], {
			timeout,
			onTimeout,
		});
		if (response) respond(pendingRequests, requireRequest(output.mock.calls[0]?.[0]).id, response);

		expect(await result).toEqual({
			kind: "submit",
			results: [
				{
					id: "db",
					question: "Which database?",
					options: ["Postgres", "SQLite"],
					multi: false,
					selectedOptions: ["SQLite"],
					customInput: undefined,
					timedOut: true,
				},
				{
					id: "features",
					question: "Which features?",
					options: ["Auth", "Billing", "Search"],
					multi: true,
					selectedOptions: ["Auth"],
					customInput: undefined,
					timedOut: true,
				},
			],
		});
		expect(onTimeout).toHaveBeenCalledTimes(1);
		// omp settled the dialog; only its own timer must tell the host to close it.
		const request = requireRequest(output.mock.calls[0]?.[0]);
		const cancels = output.mock.calls
			.map(([frame]) => frame)
			.filter(frame => "method" in frame && frame.method === "cancel");
		expect(cancels).toEqual(
			timeout === undefined ? [] : [expect.objectContaining({ method: "cancel", targetId: request.id })],
		);
	});

	it("resolves a plain host cancel as a cancelled dialog", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const onTimeout = vi.fn();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion], { onTimeout });

		respond(pendingRequests, requireRequest(output.mock.calls[0]?.[0]).id, { cancelled: true });

		expect(await result).toBeUndefined();
		expect(onTimeout).not.toHaveBeenCalled();
	});

	it("answers questions through fallback select and the negotiated ask frame", async () => {
		await using temp = await TempDir.create("@rpc-ask-dialog-");
		const extensionPath = temp.join("scripted-ask.ts");
		await Bun.write(extensionPath, scriptedAskProvider);
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "..", "src", "cli.ts"),
				"--trusted-extension",
				extensionPath,
				"--mode",
				"rpc-ui",
				"--no-session",
			],
			{
				cwd: temp.path(),
				env: {
					PATH: Bun.env.PATH,
					BUN_BE_BUN: "1",
					HOME: temp.join("home"),
					PI_CODING_AGENT_DIR: temp.join("agent"),
					XDG_CONFIG_HOME: temp.join("config"),
					XDG_DATA_HOME: temp.join("data"),
					XDG_CACHE_HOME: temp.join("cache"),
					CI: "true",
					PI_NO_TITLE: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 30_000,
			},
		);
		const stdout = new Response(child.stdout).body;
		if (!stdout) throw new Error("RPC ask fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};
		const selectRequests: Record<string, unknown>[] = [];
		const askRequests: Record<string, unknown>[] = [];
		const toolResults: unknown[] = [];
		let optInResponse: unknown;
		let finished = false;
		const args = JSON.stringify({ questions: [dbQuestion] });

		try {
			// The provider exists only once the extension loads, so select it over RPC.
			await send({ type: "set_model", id: "model", provider: "scripted", modelId: "ask" });
			for await (const frame of readJsonl<unknown>(stdout)) {
				if (!isRecord(frame)) continue;
				if (frame.type === "response" && frame.id === "model") {
					if (frame.success !== true) throw new Error(`Scripted model unavailable: ${JSON.stringify(frame)}`);
					await send({ type: "prompt", id: "fallback", message: args });
				} else if (frame.type === "extension_ui_request" && frame.method === "select") {
					selectRequests.push(frame);
					await send({ type: "extension_ui_response", id: frame.id, value: "Postgres" });
				} else if (frame.type === "extension_ui_request" && frame.method === "ask") {
					askRequests.push(frame);
					await send({
						type: "extension_ui_response",
						id: frame.id,
						answers: [{ id: "db", selectedOptions: ["Postgres"] }],
					});
				} else if (frame.type === "tool_execution_end" && frame.toolName === "ask") {
					toolResults.push(frame.result);
				} else if (frame.type === "prompt_result" && frame.id === "fallback") {
					await send({ type: "set_ask_dialog", id: "opt-in", enabled: true });
				} else if (frame.type === "response" && frame.id === "opt-in") {
					optInResponse = frame;
					await send({ type: "prompt", id: "dialog", message: args });
				} else if (frame.type === "prompt_result" && frame.id === "dialog") {
					finished = true;
					break;
				}
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
		}

		if (!finished) throw new Error(`RPC ask fixture did not finish: ${await stderr}`);
		await stderr;
		expect(selectRequests).toHaveLength(1);
		expect(selectRequests[0]).toMatchObject({ method: "select", title: "Which database?" });
		expect(optInResponse).toEqual({
			id: "opt-in",
			type: "response",
			command: "set_ask_dialog",
			success: true,
			data: { enabled: true },
		});
		expect(askRequests).toMatchObject([{ method: "ask", questions: [dbQuestion] }]);
		const answered = expect.objectContaining({
			details: expect.objectContaining({ selectedOptions: ["Postgres"] }),
		});
		expect(toolResults).toEqual([answered, answered]);
	}, 60_000);
});
