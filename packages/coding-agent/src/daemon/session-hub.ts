/**
 * The session hub: lists the daemon's hosted sessions and picks one.
 *
 * Arrows / j k move, Enter attaches, n creates a session in the current
 * directory, r refreshes, q / Esc quits. The hub only chooses; attaching is
 * the caller's job, so this module stays independent of the renderer.
 */
import { type Component, matchesKey, ProcessTerminal, truncateToWidth, TUI } from "@oh-my-pi/pi-tui";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { SessionDaemonClient } from "./client";
import type { HostedSessionInfo } from "./server";

export type HubChoice = { kind: "attach"; sessionId: string } | { kind: "new" } | { kind: "quit" };

const STATUS_LABEL: Record<HostedSessionInfo["status"], string> = {
	starting: "starting",
	running: "running",
	needs_input: "needs input",
	idle: "idle",
	exited: "exited",
};

function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	return `${Math.round(s / 3600)}h ago`;
}

/** Pure list model; rendering and key handling are separate so tests can drive it. */
export class SessionHubList implements Component {
	sessions: HostedSessionInfo[] = [];
	selected = 0;
	readonly #choose: (choice: HubChoice) => void;
	readonly #refresh: () => void;

	constructor(choose: (choice: HubChoice) => void, refresh: () => void) {
		this.#choose = choose;
		this.#refresh = refresh;
	}

	setSessions(sessions: HostedSessionInfo[]): void {
		const current = this.sessions[this.selected]?.id;
		this.sessions = sessions;
		const keep = current === undefined ? -1 : sessions.findIndex(s => s.id === current);
		this.selected = keep >= 0 ? keep : Math.min(this.selected, Math.max(0, sessions.length - 1));
	}

	render(width: number): readonly string[] {
		const lines = [theme.bold(" NeoPi session hub"), ""];
		if (this.sessions.length === 0) lines.push(theme.fg("muted", "  No sessions yet. Press n to start one."));
		const now = Date.now();
		this.sessions.forEach((s, i) => {
			const marker = i === this.selected ? theme.fg("accent", "› ") : "  ";
			const title = s.title ?? `session ${s.id}`;
			const status = STATUS_LABEL[s.status];
			const statusText = s.status === "needs_input" ? theme.fg("warning", status) : theme.fg("muted", status);
			const viewers = s.viewers > 0 ? theme.fg("muted", ` · ${s.viewers} attached`) : "";
			lines.push(truncateToWidth(`${marker}${theme.bold(title)}  ${statusText}  ${theme.fg("muted", ago(now - s.lastActivity))}${viewers}`, width));
			lines.push(truncateToWidth(`    ${theme.fg("muted", `${s.cwd}  ${s.model ?? ""}`)}`, width));
		});
		lines.push("", theme.fg("muted", truncateToWidth("  ↑↓/jk move · enter attach · n new · r refresh · q/esc quit", width)));
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "up") || data === "k") this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down") || data === "j")
			this.selected = Math.min(Math.max(0, this.sessions.length - 1), this.selected + 1);
		else if (matchesKey(data, "enter")) {
			const session = this.sessions[this.selected];
			if (session && session.status !== "exited") this.#choose({ kind: "attach", sessionId: session.id });
		} else if (data === "n") this.#choose({ kind: "new" });
		else if (data === "r") this.#refresh();
		else if (data === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.#choose({ kind: "quit" });
	}

	invalidate(): void {}
}

/** Show the hub until the user picks something; polls the daemon for live status. */
export async function runSessionHub(client: SessionDaemonClient): Promise<HubChoice> {
	const done = Promise.withResolvers<HubChoice>();
	const ui = new TUI(new ProcessTerminal());
	const refresh = (): void => {
		void client.list().then(
			sessions => {
				list.setSessions(sessions);
				ui.requestRender();
			},
			error => done.reject(error instanceof Error ? error : new Error(String(error))),
		);
	};
	const list = new SessionHubList(choice => done.resolve(choice), refresh);
	const overlay = ui.showOverlay(list, { fullscreen: true, width: "100%", margin: 0 });
	ui.setFocus(list);
	ui.start();
	// A daemon that dies under an idle hub must surface as an error, not as a quit.
	void client.closed.then(reason => done.reject(new Error(`session daemon closed${reason ? `: ${reason}` : ""}`)));
	refresh();
	const timer = setInterval(refresh, 1_000);
	try {
		return await done.promise;
	} finally {
		clearInterval(timer);
		overlay.hide();
		ui.stop();
	}
}
