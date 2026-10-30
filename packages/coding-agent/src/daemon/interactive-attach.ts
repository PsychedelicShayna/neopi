import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { postmortem } from "@oh-my-pi/pi-utils";
import { InteractiveMode } from "../modes/interactive-mode";
import type { RpcExtensionUIRequest, RpcPlanProposalRequest, RpcToolApprovalRequest } from "../modes/rpc/rpc-types";
import type { SessionDaemonClient } from "./client";
import { RemoteAgentSession } from "./remote-session";
import type { HostedSessionInfo } from "./server";

export type AttachExit = "detach" | "closed";
type Frame = Record<string, unknown>;

/** Native rpc-ui dialogs stay viewer-local; only their answers go to the hosted runtime. */
class AttachedInteractions {
	readonly #pending = new Map<string, AbortController>();

	constructor(readonly mode: InteractiveMode, readonly session: RemoteAgentSession) {}

	apply(frame: Frame): void {
		if (frame.type === "tool_approval_cancel" || frame.type === "plan_proposal_cancel" ||
			(frame.type === "extension_ui_request" && frame.method === "cancel")) {
			this.#pending.get(String(frame.targetId ?? frame.id))?.abort();
			return;
		}
		if (frame.type !== "extension_ui_request" && frame.type !== "tool_approval_request" && frame.type !== "plan_proposal_request") return;
		const request = frame as unknown as RpcExtensionUIRequest | RpcToolApprovalRequest | RpcPlanProposalRequest;
		const lifetime = new AbortController();
		this.#pending.set(request.id, lifetime);
		void this.#answer(request, lifetime.signal).then(answer => {
			if (answer && !lifetime.signal.aborted) this.session.respond(answer);
		}).catch(error => {
			this.mode.showError(error instanceof Error ? error.message : String(error));
		}).finally(() => this.#pending.delete(request.id));
	}

	dispose(): void {
		for (const lifetime of this.#pending.values()) lifetime.abort();
		this.#pending.clear();
	}

	async #answer(request: RpcExtensionUIRequest | RpcToolApprovalRequest | RpcPlanProposalRequest, signal: AbortSignal): Promise<Frame | undefined> {
		if (request.type === "tool_approval_request") {
			const choice = await this.mode.showHookSelector(
				`Allow ${request.toolName}?\n${JSON.stringify(request.args)}\n${request.details.join("\n")}${request.safetyChecks ? `\nSafety checks: ${JSON.stringify(request.safetyChecks)}` : ""}`,
				["Approve", "Deny"], { signal },
			);
			return { type: "tool_approval_response", id: request.id, decision: choice === "Approve" ? "approve" : "deny" };
		}
		if (request.type === "plan_proposal_request") {
			const choice = await this.mode.showHookSelector(`${request.title}\n${request.planMarkdown}`, ["Approve", "Refine"], { signal });
			return { type: "plan_proposal_response", id: request.id, decision: choice === "Approve" ? "approve" : "refine" };
		}
		switch (request.method) {
			case "confirm": {
				const confirmed = await this.mode.showHookConfirm(request.title, request.message, { signal });
				return { type: "extension_ui_response", id: request.id, confirmed };
			}
			case "select": {
				const value = await this.mode.showHookSelector(request.title, request.options, { signal });
				return value === undefined ? { type: "extension_ui_response", id: request.id, cancelled: true }
					: { type: "extension_ui_response", id: request.id, value };
			}
			case "input": {
				const value = await this.mode.showHookInput(request.title, request.placeholder, { signal, secret: request.secret });
				return value === undefined ? { type: "extension_ui_response", id: request.id, cancelled: true }
					: { type: "extension_ui_response", id: request.id, value };
			}
			case "editor": {
				const value = await this.mode.showHookEditor(request.title, request.prefill, { signal }, { promptStyle: request.promptStyle });
				return value === undefined ? { type: "extension_ui_response", id: request.id, cancelled: true }
					: { type: "extension_ui_response", id: request.id, value };
			}
			case "notify":
				this.mode.showStatus(request.message);
				return;
			case "set_editor_text":
				this.mode.editor.setText(request.text);
				return;
			case "cancel":
				return;
			default:
				this.mode.showWarning(`${request.method} is not available in attached view yet.`);
				return;
		}
	}
}

/** Attach a separately rendered InteractiveMode without acquiring the daemon's runtime lifetime. */
export async function runInteractiveAttach(client: SessionDaemonClient, hosted: HostedSessionInfo): Promise<AttachExit> {
	const done = Promise.withResolvers<AttachExit>();
	const buffered: Frame[] = [];
	let interactions: AttachedInteractions | undefined;
	const unsubscribe = client.onFrame(frame => {
		if (interactions) interactions.apply(frame);
		else buffered.push(frame);
	});
	let remote: RemoteAgentSession | undefined;
	let mode: InteractiveMode | undefined;
	let unregisterCleanup: (() => void) | undefined;
	try {
		remote = await RemoteAgentSession.attach(client, hosted.id, hosted.cwd);
		mode = new InteractiveMode(remote, VERSION, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
			onDetach: () => done.resolve("detach"),
		});
		await mode.init({ suppressWelcomeIntro: true });
		await mode.renderInitialMessages();
		interactions = new AttachedInteractions(mode, remote);
		for (const frame of buffered.splice(0)) interactions.apply(frame);
		const viewer = mode;
		const session = remote;
		unregisterCleanup = postmortem.register("attached-viewer", async () => {
			interactions?.dispose();
			viewer.stop();
			await session.dispose();
		});
		void client.closed.then(() => done.resolve("closed"));
		return await done.promise;
	} finally {
		unregisterCleanup?.();
		unsubscribe();
		interactions?.dispose();
		mode?.stop();
		await remote?.dispose();
	}
}
