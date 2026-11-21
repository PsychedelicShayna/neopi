import { expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ControlClient } from "@oh-my-pi/pi-coding-agent/control/client";
import { ControlHost } from "@oh-my-pi/pi-coding-agent/control/host";
import type { ControlSnapshot } from "@oh-my-pi/pi-coding-agent/control/types";
import { submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

test.skipIf(process.platform === "win32")(
	"Enter and a control steer each reach the model after a TUI turn yields with bash still running",
	async () => {
		await using temp = await TempDir.create("@yield-input-");
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: temp.path() });
		initTheme();
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("anthropic", "test-key");
		const settings = Settings.isolated({
			"async.enabled": true,
			"bashInterceptor.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
		});
		const manager = new AsyncJobManager({});
		const sessionManager = SessionManager.inMemory(temp.path());
		const agentId = "yield-input";
		const bash = new BashTool({
			cwd: temp.path(),
			hasUI: true,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getAgentId: () => agentId,
			allocateOutputArtifact: () => sessionManager.allocateArtifactPath(),
			asyncJobManager: manager,
			settings,
		});
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "bash",
							arguments: {
								command: "until test -f release; do sleep 0.05; done; echo bash-finished",
								async: true,
								timeout: 30,
							},
						},
					],
				},
				{ content: ["Initial turn yielded"] },
				{ content: ["Keyboard turn yielded"] },
				{ content: ["Control turn yielded"] },
				{ content: ["Background result received"] },
			],
		});
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, tools: [bash] },
				streamFn: mock.stream,
				convertToLlm,
			}),
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
			agentId,
			asyncJobManager: manager,
		});
		const term = new VirtualTerminal(120, 36);
		const mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: term }),
		);
		const host = new ControlHost({ session, role: "tui", dir: temp.join("ctl"), tmuxPane: null });
		let client: ControlClient | undefined;
		try {
			await host.start();
			await mode.init({ suppressWelcomeIntro: true });
			const publication = host.publication;
			if (!publication) throw new Error("Control host did not publish");
			client = new ControlClient({ metadata: publication.metadata(), label: "other session", kind: "cli" });
			expect((await client.connect()).ready).toBe(true);
			const control = client;
			const visible = (text: string) => term.getViewport().some(row => Bun.stripANSI(row).includes(text));
			const expectPaused = async (answer: string) => {
				const waiting = "Waiting for background job bg_";
				await term.waitForRender(() => visible(answer) && visible(waiting));
				expect(visible(answer)).toBe(true);
				expect(visible(waiting)).toBe(true);
				const status = await control.request({ type: "get_status" }, 2_000);
				expect(status.success).toBe(true);
				expect((status.data as ControlSnapshot).busy).toMatchObject({
					streaming: false,
					pendingAsyncWork: true,
					pendingSteerAndFollowUp: 0,
				});
			};
			const submitFromTerminal = (text: string) => {
				// Drive one iteration of the real CLI input loop through terminal input.
				const input = mode.getUserInput().then(input => submitInteractiveInput(mode, session, input));
				term.sendInput(text);
				term.sendInput("\r");
				return withTimeout(input, 3_000, `Enter did not submit: ${text}`);
			};

			await submitFromTerminal("Start a background job");
			await expectPaused("Initial turn yielded");
			const steeringUpdates: string[] = [];
			const unsubscribe = session.subscribe(event => {
				if (event.type === "queue_update") steeringUpdates.push(...event.steering);
			});
			await submitFromTerminal("Keyboard after yield");
			await expectPaused("Keyboard turn yielded");
			unsubscribe();
			expect(steeringUpdates).toEqual([]);
			const steer = await control.request({ type: "steer", message: "Control after yield" }, 2_000);
			expect(steer.success).toBe(true);
			await expectPaused("Control turn yielded");
			expect(mock.calls[2]?.context.messages.at(-1)).toMatchObject({
				role: "user",
				content: [{ type: "text", text: "Keyboard after yield" }],
			});
			expect(mock.calls[3]?.context.messages.at(-1)).toMatchObject({
				role: "user",
				content: [{ type: "text", text: "Control after yield" }],
			});

			// Nothing except the test can release the bash process. Both inputs must
			// be answered without Esc and before the job can possibly resume the run.
			await Bun.write(temp.join("release"), "");
			await term.waitForRender(
				() => visible("Background result received") && !visible("Waiting for background job"),
			);
			expect(visible("Background result received")).toBe(true);
			expect(visible("Waiting for background job")).toBe(false);
		} finally {
			client?.close();
			mode.stop();
			await host.close();
			await session.dispose();
			await manager.dispose();
			auth.close();
			resetSettingsForTest();
		}
	},
	15_000,
);
