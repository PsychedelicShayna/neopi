/**
 * Interim proof renderer for one daemon-hosted session, drawn purely from its
 * rpc-ui frame stream (no byte bridge). It shows that a client can render a
 * shared session itself: history from `get_messages`, live deltas, a composer
 * that prompts or steers, and the interactions a viewer must answer.
 *
 * It is NOT the normal TUI: no tool rendering, subagents, IRC, context notes,
 * slash commands or scrollback navigation (only the newest rows fit). The
 * requested end state is InteractiveMode over a RemoteAgentSession; this file
 * is removed when that lands. See the PR's gap list.
 */
import { type Component, Input, matchesKey, ProcessTerminal, truncateToWidth, TUI, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { SessionDaemonClient } from "./client";

export type AttachExit = "detach" | "closed";

type Frame = Record<string, unknown>;

interface Entry {
	role: "user" | "assistant" | "notice";
	text: string;
}

interface OpenInteraction {
	id: string;
	type: string;
	title: string;
	options: string[];
	method?: string;
}

function messageText(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
		.join("");
}

function messageRole(message: unknown): Entry["role"] | undefined {
	const role = typeof message === "object" && message !== null ? (message as { role?: unknown }).role : undefined;
	return role === "user" || role === "assistant" ? role : undefined;
}

/** Transcript + interaction state built purely from frames; rendering reads it. */
export class FrameSessionModel {
	entries: Entry[] = [];
	live: Entry | undefined;
	streaming = false;
	interactions: OpenInteraction[] = [];
	status = "";

	loadHistory(messages: unknown[]): void {
		this.entries = [];
		for (const message of messages) {
			const role = messageRole(message);
			const text = messageText(message);
			if (role && text) this.entries.push({ role, text });
		}
	}

	apply(frame: Frame): void {
		switch (frame.type) {
			case "agent_start":
				this.streaming = true;
				return;
			case "agent_end":
				if (frame.willContinue !== true) this.streaming = false;
				return;
			case "message_start": {
				const role = messageRole(frame.message);
				if (role === "user") {
					const text = messageText(frame.message);
					if (text) this.entries.push({ role, text });
				} else if (role === "assistant" || frame.snapshot === true) {
					this.live = { role: "assistant", text: messageText(frame.message) };
				}
				return;
			}
			case "message_update": {
				const text = messageText(frame.message);
				if (messageRole(frame.message) === "assistant") this.live = { role: "assistant", text };
				return;
			}
			case "message_end": {
				const role = messageRole(frame.message);
				if (role === "assistant") {
					const text = messageText(frame.message);
					if (text) this.entries.push({ role, text });
					this.live = undefined;
				}
				return;
			}
			case "extension_ui_request":
				this.#uiRequest(frame);
				return;
			case "tool_approval_request":
				this.interactions.push({
					id: String(frame.id),
					type: "tool_approval_request",
					title: `Allow ${String(frame.toolName)}?`,
					options: ["approve", "deny"],
				});
				return;
			case "tool_approval_cancel":
				this.#close(String(frame.targetId));
				return;
			case "plan_proposal_cancel":
				this.#close(String(frame.id));
		}
	}

	#uiRequest(frame: Frame): void {
		const method = String(frame.method);
		if (method === "cancel") {
			this.#close(String(frame.targetId));
			return;
		}
		if (method === "notify") {
			this.entries.push({ role: "notice", text: String(frame.message ?? "") });
			return;
		}
		if (method === "setStatus") {
			this.status = String(frame.statusText ?? frame.text ?? "");
			return;
		}
		if (method === "confirm" || method === "select" || method === "input" || method === "editor") {
			const options = method === "confirm" ? ["yes", "no"] : Array.isArray(frame.options) ? frame.options.map(String) : [];
			this.interactions.push({ id: String(frame.id), type: "extension_ui_request", method, title: String(frame.title ?? frame.message ?? method), options });
		}
	}

	#close(id: string): void {
		this.interactions = this.interactions.filter(interaction => interaction.id !== id);
	}

	/** The answer frame for `choice` (an option index, or free text for input dialogs). */
	answer(interaction: OpenInteraction, choice: number | string): Frame {
		this.#close(interaction.id);
		if (interaction.type === "tool_approval_request")
			return { type: "tool_approval_response", id: interaction.id, decision: choice === 0 ? "approve" : "deny" };
		if (interaction.method === "confirm") return { type: "extension_ui_response", id: interaction.id, confirmed: choice === 0 };
		const value = typeof choice === "number" ? (interaction.options[choice] ?? "") : choice;
		return { type: "extension_ui_response", id: interaction.id, value };
	}
}

class AttachView implements Component {
	readonly model = new FrameSessionModel();
	readonly input = new Input();
	optionIndex = 0;
	title: string;
	constructor(
		title: string,
		readonly onDetach: () => void,
		readonly send: (frame: Frame) => void,
		readonly rows: () => number,
	) {
		this.title = title;
		this.input.onSubmit = text => this.#submit(text);
	}

	#submit(text: string): void {
		const value = text.trim();
		const interaction = this.model.interactions[0];
		if (interaction && interaction.options.length === 0) {
			this.send(this.model.answer(interaction, value));
		} else if (value) {
			this.send({ type: this.model.streaming ? "steer" : "prompt", message: value, id: crypto.randomUUID() });
		}
		this.input.setValue("");
	}

	render(width: number): readonly string[] {
		const body: string[] = [];
		for (const entry of [...this.model.entries, ...(this.model.live ? [this.model.live] : [])]) {
			const label = entry.role === "user" ? theme.fg("accent", "you") : entry.role === "assistant" ? theme.fg("success", "agent") : theme.fg("muted", "note");
			body.push(label);
			for (const line of entry.text.split("\n")) body.push(...wrapTextWithAnsi(line, Math.max(10, width - 2)).map(l => `  ${l}`));
			body.push("");
		}
		const footer: string[] = [];
		const interaction = this.model.interactions[0];
		if (interaction) {
			footer.push(theme.fg("warning", truncateToWidth(` ? ${interaction.title}`, width)));
			interaction.options.forEach((option, i) =>
				footer.push(truncateToWidth(`${i === this.optionIndex ? theme.fg("accent", "  › ") : "    "}${option}`, width)),
			);
		}
		const state = this.model.streaming ? "running" : "idle";
		footer.push(theme.fg("muted", truncateToWidth(` ${this.title} · ${state}${this.model.status ? ` · ${this.model.status}` : ""} · ctrl+x d detach`, width)));
		footer.push(...this.input.render(width));
		const room = Math.max(1, this.rows() - footer.length - 1);
		return [theme.bold(truncateToWidth(` ${this.title}`, width)), ...body.slice(-room), ...footer];
	}

	handleInput(data: string): void {
		const interaction = this.model.interactions[0];
		if (interaction && interaction.options.length > 0) {
			if (matchesKey(data, "up")) this.optionIndex = Math.max(0, this.optionIndex - 1);
			else if (matchesKey(data, "down")) this.optionIndex = Math.min(interaction.options.length - 1, this.optionIndex + 1);
			else if (matchesKey(data, "enter")) {
				this.send(this.model.answer(interaction, this.optionIndex));
				this.optionIndex = 0;
			}
			return;
		}
		if (matchesKey(data, "escape") && this.model.streaming) {
			this.send({ type: "abort", id: crypto.randomUUID() });
			return;
		}
		this.input.handleInput(data);
	}

	invalidate(): void {}
}


/** Attach `client` to `sessionId` and render it until the user detaches or the connection closes. */
export async function runAttachView(client: SessionDaemonClient, sessionId: string, title: string): Promise<AttachExit> {
	const done = Promise.withResolvers<AttachExit>();
	const ui = new TUI(new ProcessTerminal());
	const view = new AttachView(
		title,
		() => done.resolve("detach"),
		frame => client.send(frame),
		() => ui.terminal.rows,
	);
	const buffered: Frame[] = [];
	let historyLoaded = false;
	const unsubscribe = client.onFrame(frame => {
		if (!historyLoaded) buffered.push(frame);
		else view.model.apply(frame);
		ui.requestRender();
	});
	// `app.daemon.detach` (default Ctrl+X) is a prefix: it, then d, detaches. Ctrl+] (jumpForward),
	// Ctrl+S (agent hub) and F6 were taken. Ctrl+X also toggles the autoresearch dashboard: pressing
	// it twice delivers one Ctrl+X to the session, as tmux does with its prefix.
	const detachKeys = KeybindingsManager.create().getKeys("app.daemon.detach");
	let prefix = false;
	const removeListener = ui.addInputListener(data => {
		const isPrefix = detachKeys.some(key => matchesKey(data, key));
		if (prefix) {
			prefix = false;
			if (data === "d") {
				done.resolve("detach");
				return { consume: true };
			}
			// tmux convention: the prefix twice sends one prefix through; any other key passes as usual.
			if (isPrefix) return undefined;
		} else if (isPrefix) {
			prefix = true;
			return { consume: true };
		}
		return undefined;
	});
	const overlay = ui.showOverlay(view, { fullscreen: true, width: "100%", margin: 0 });
	ui.setFocus(view);
	ui.start();
	void client.closed.then(() => done.resolve("closed"));
	try {
		await client.attach(sessionId);
		// History after the cut: completed messages come from the session, the in-flight one from the snapshot frame.
		const history = (await client.request({ type: "get_messages" })) as { messages?: unknown[] };
		view.model.loadHistory(history.messages ?? []);
		historyLoaded = true;
		for (const frame of buffered.splice(0)) view.model.apply(frame);
		ui.requestRender();
		return await done.promise;
	} finally {
		unsubscribe();
		removeListener();
		overlay.hide();
		ui.stop();
	}
}
