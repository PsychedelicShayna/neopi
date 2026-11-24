/**
 * Terminal state collection for the debug menu.
 *
 * Surfaces the detected terminal, the established subprotocols the renderer
 * negotiated (graphics, desktop notifications, hyperlinks, true color), the
 * scrollback/erase strategy, and the live geometry — the details that decide
 * which escape sequences the renderer emits.
 */
import { t } from "@oh-my-pi/pi-utils/i18n";
import {
	getCellDimensions,
	ImageProtocol,
	isOsc99Supported,
	NotifyProtocol,
	TERMINAL,
	TERMINAL_ID,
} from "../../terminal-capabilities";
import { classifyTerminalMultiplexer } from "../../terminal-multiplexer";

/** Live values the debug view reads off the running TUI, not the static capability table. */
export interface TerminalRuntimeState {
	columns: number;
	rows: number;
	/** Whether DEC 2026 synchronized-output wrappers are currently emitted. */
	synchronizedOutput: boolean;
}

/** Terminal capabilities, geometry, and detection environment. */
export interface TerminalStateInfo {
	detectedId: string;
	columns: number;
	rows: number;
	cellWidthPx: number;
	cellHeightPx: number;
	trueColor: boolean;
	imageProtocol: string;
	notifyProtocol: string;
	osc99Confirmed: boolean;
	hyperlinks: boolean;
	deccara: boolean;
	screenToScrollback: boolean;
	synchronizedOutput: boolean;
	multiplexer: string | null;
	env: { TERM?: string; TERM_PROGRAM?: string; TERM_PROGRAM_VERSION?: string; COLORTERM?: string };
}

const IMAGE_PROTOCOL_NAMES: Record<ImageProtocol, string> = {
	[ImageProtocol.Kitty]: "Kitty graphics",
	[ImageProtocol.Iterm2]: "iTerm2 inline images",
	[ImageProtocol.Sixel]: "Sixel",
};

const NOTIFY_PROTOCOL_NAMES: Record<NotifyProtocol, string> = {
	[NotifyProtocol.Bell]: "BEL (\\a)",
	[NotifyProtocol.Osc99]: "OSC 99 (kitty desktop notifications)",
	[NotifyProtocol.Osc9]: "OSC 9 (iTerm2/WezTerm)",
};

/** Snapshot the active terminal capabilities and the live runtime geometry. */
export function collectTerminalState(runtime: TerminalRuntimeState): TerminalStateInfo {
	const env = Bun.env;
	const cell = getCellDimensions();
	return {
		detectedId: TERMINAL_ID,
		columns: runtime.columns,
		rows: runtime.rows,
		cellWidthPx: cell.widthPx,
		cellHeightPx: cell.heightPx,
		trueColor: TERMINAL.trueColor,
		imageProtocol: TERMINAL.imageProtocol === null ? "none" : IMAGE_PROTOCOL_NAMES[TERMINAL.imageProtocol],
		notifyProtocol: NOTIFY_PROTOCOL_NAMES[TERMINAL.notifyProtocol],
		osc99Confirmed: isOsc99Supported(),
		hyperlinks: TERMINAL.hyperlinks,
		deccara: TERMINAL.deccara,
		screenToScrollback: TERMINAL.supportsScreenToScrollback,
		synchronizedOutput: runtime.synchronizedOutput,
		multiplexer: classifyTerminalMultiplexer(env),
		env: {
			TERM: env.TERM,
			TERM_PROGRAM: env.TERM_PROGRAM,
			TERM_PROGRAM_VERSION: env.TERM_PROGRAM_VERSION,
			COLORTERM: env.COLORTERM,
		},
	};
}

const yesNo = (value: boolean): string =>
	value ? t("cli.commands.debug.terminal.yes") : t("cli.commands.debug.terminal.no");

/** Localize built-in descriptions without rewriting protocol or snapshot data. */
function displayProtocol(name: string): string {
	switch (name) {
		case "Kitty graphics":
			return t("cli.commands.debug.terminal.kitty_graphics");
		case "iTerm2 inline images":
			return t("cli.commands.debug.terminal.iterm2_images");
		case "OSC 99 (kitty desktop notifications)":
			return t("cli.commands.debug.terminal.osc99_notify");
		default:
			return name;
	}
}

/** Format terminal state for display in the debug menu. */
export function formatTerminalState(info: TerminalStateInfo): string {
	const lines = [
		t("cli.commands.debug.terminal.title"),
		"━━━━━━━━━━━━━━",
		t("cli.commands.debug.terminal.detected", { id: info.detectedId }),
		t("cli.commands.debug.terminal.geometry", {
			columns: info.columns,
			rows: info.rows,
			width: info.cellWidthPx,
			height: info.cellHeightPx,
		}),
		t("cli.commands.debug.terminal.multiplexer", { name: info.multiplexer || t("cli.commands.debug.terminal.none") }),
		"",
		t("cli.commands.debug.terminal.subprotocols"),
		t("cli.commands.debug.terminal.graphics", {
			protocol:
				info.imageProtocol === "none"
					? t("cli.commands.debug.terminal.no_graphics")
					: displayProtocol(info.imageProtocol),
		}),
		t("cli.commands.debug.terminal.notify", {
			protocol: displayProtocol(info.notifyProtocol),
			confirmation: info.osc99Confirmed ? t("cli.commands.debug.terminal.confirmed_da") : "",
		}),
		t("cli.commands.debug.terminal.hyperlinks", { enabled: yesNo(info.hyperlinks) }),
		t("cli.commands.debug.terminal.true_color", { enabled: yesNo(info.trueColor) }),
		t("cli.commands.debug.terminal.deccara", { enabled: yesNo(info.deccara) }),
		t("cli.commands.debug.terminal.sync_output", { enabled: yesNo(info.synchronizedOutput) }),
		"",
		t("cli.commands.debug.terminal.scrollback"),
		t("cli.commands.debug.terminal.screen_to_history", {
			strategy: info.screenToScrollback ? "CSI 22 J" : t("cli.commands.debug.terminal.redraw"),
		}),
		"",
		t("cli.commands.debug.terminal.detection_signals"),
		`  TERM:                 ${info.env.TERM ?? t("cli.commands.debug.terminal.unset")}`,
		`  TERM_PROGRAM:         ${info.env.TERM_PROGRAM ?? t("cli.commands.debug.terminal.unset")}`,
		`  TERM_PROGRAM_VERSION: ${info.env.TERM_PROGRAM_VERSION ?? t("cli.commands.debug.terminal.unset")}`,
		`  COLORTERM:            ${info.env.COLORTERM ?? t("cli.commands.debug.terminal.unset")}`,
	];
	return lines.join("\n");
}
