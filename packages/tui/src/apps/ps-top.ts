/**
 * Interactive alt-screen monitor for `npi ps` (btop idiom): a live process
 * table over the daemon's units, grouped by scope, with in-place actions.
 *
 * Keys — table: j/k select, Enter/i info, o logs, s stop,
 * `x` kill, `r` restart, `a` toggle all scopes, `q`/`esc`/`ctrl+c` quit.
 * Sub-views (info, logs): `esc`/`q` back.
 */
import { getLocale, t } from "@oh-my-pi/pi-utils/i18n";
import { KeyValueList, type KeyValueRow } from "../components/key-value-list";
import { ScrollView } from "../components/scroll-view";
import { MenuKeyReader, MenuSearchField, menuScrollBy } from "../components/menu-navigation";
import { MenuHelp, menuHintLines } from "../components/menu-hints";
import { compileMenuRegex } from "../menu-search";
import { renderTableRow, type TableColumn } from "../components/table";
import { fuzzyFilter } from "../fuzzy";
import { matchesKey } from "../keys";
import { ProcessTerminal } from "../terminal";
import { type Component, TUI } from "../tui";
import type { TspSpan, TspText, TspTone } from "@oh-my-pi/pi-wire";
import { col, compact, elapsed, keyed, node, row, span, stableKey, text } from "../native/describe";
import type { DescribeContext, NativeNode, NativeScroll, NativeUiEvent } from "../native/node";
import { actionBar, actionButton, iconButton, segmentedTabs } from "../native/overlay";
import { Memo } from "../native/memo";
import { truncateToWidth } from "../utils";
import { APP_NAME, formatDuration } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { ProcSpec, UnitScope, UnitSnapshot } from "../tools/daemon";
import {
	collapseCommand,
	daemonHeader,
	flagsCell,
	formatCommand,
	idleCell,
	type PsBoard,
	type PsScopeReport,
	type PsTarget,
	pidsCell,
	scopeHeader,
	scopeId,
	scopeTitle,
	tableHeader,
	TERMINAL_STATES,
	tableCells,
	unitLabel,
	unitName,
} from "./ps-data";

/** Fallback poll; unit events from the daemon refresh sooner. */
const REFRESH_MS = 2_000;
/** Coalesces bursts of unit events into one refresh. */
const EVENT_REFRESH_MS = 100;
const LOGS_POLL_MS = 1_000;
const STATUS_TTL_MS = 5_000;

interface FlatRow {
	scope: UnitScope;
	unit: UnitSnapshot;
}

type PsTopView = "table" | "info" | "logs";

type PsStatusTone = "success" | "warning" | "error" | "muted";

const STATUS_PAINT: Record<PsStatusTone, (text: string) => string> = {
	success: chalk.green,
	warning: chalk.yellow,
	error: chalk.red,
	muted: chalk.dim,
};

const ACTION_MESSAGES = {
	stop: {
		pending: "cli.commands.ps.action.stop.pending",
		success: "cli.commands.ps.action.stop.success",
		failed: "cli.commands.ps.action.stop.failed",
	},
	kill: {
		pending: "cli.commands.ps.action.kill.pending",
		success: "cli.commands.ps.action.kill.success",
		failed: "cli.commands.ps.action.kill.failed",
	},
	restart: {
		pending: "cli.commands.ps.action.restart.pending",
		success: "cli.commands.ps.action.restart.success",
		failed: "cli.commands.ps.action.restart.failed",
	},
} as const;

/** Options accepted by the interactive monitor: scope selection from the list flags. */
export interface PsTopOptions extends PsTarget {
	all: boolean;
}

/** Unit detail shown by the info view. */
export interface PsUnitInfo {
	unit: UnitSnapshot;
	proc?: ProcSpec;
}

/** Unit log window shown by the logs view. */
export interface PsUnitLogs {
	text: string;
	/** PTY output replayed into terminal rows; empty for non-PTY units. */
	terminalOutput: string;
	state: string;
}

/** Daemon capabilities supplied by the process command. */
export interface PsTopHost {
	/** The board for the selection; never starts the daemon. */
	collectBoard(all: boolean, target: PsTarget): Promise<PsBoard>;
	/** Calls `onChange` on every unit transition while a daemon answers; returns the unsubscribe. */
	watch(onChange: () => void): () => void;
	act(unit: UnitSnapshot, verb: "stop" | "kill" | "restart"): Promise<UnitSnapshot>;
	describe(unit: UnitSnapshot): Promise<PsUnitInfo>;
	logs(unit: UnitSnapshot, lines: number): Promise<PsUnitLogs>;
	close(): void;
}

/** Interactive process table and detail views. */
export class PsTopComponent implements Component {
	readonly #ui: TUI;
	readonly #target: PsTarget;
	readonly #done = Promise.withResolvers<void>();
	readonly #host: PsTopHost;
	#all: boolean;
	#board: PsBoard | undefined;
	#reports: PsScopeReport[] = [];
	#sourceReports: PsScopeReport[] = [];
	#flat: FlatRow[] = [];
	#selected = 0;
	/** Unit id of the selection, kept stable across refreshes. */
	#selectedKey: string | undefined;
	readonly #tableView = new ScrollView([], { height: 1 });
	readonly #infoView = new ScrollView([], { height: 1 });
	readonly #logsView = new ScrollView([], { height: 1, followTail: true, anchor: "end" });
	readonly #infoList = new KeyValueList([], { indent: "   ", labelWidth: 9, gap: " " });
	#view: PsTopView = "table";
	#info: PsUnitInfo | undefined;
	#logsLines: string[] = [];
	#logsState = "";
	#logsTimer: NodeJS.Timeout | undefined;
	#refreshTimer: NodeJS.Timeout | undefined;
	#eventTimer: NodeJS.Timeout | undefined;
	#unwatch: (() => void) | undefined;
	#refreshing = false;
	#lastRefresh = 0;
	#status = "";
	#statusText = "";
	readonly #keys = new MenuKeyReader();
	readonly #search = new MenuSearchField();
	readonly #help = new MenuHelp(undefined, () => t("cli.commands.ps.help.views"));
	#filteredQuery = "";
	#nativeScroll: NativeScroll | undefined;
	#viewRequest = 0;
	#statusTone: PsStatusTone = "muted";
	#statusAt = 0;
	#logsError: string | undefined;
	/** Process key a pointer `Kill` waits on for confirmation. */
	#killConfirm: string | undefined;
	#disposed = false;
	readonly #native = new Memo();

	constructor(ui: TUI, options: PsTopOptions, host: PsTopHost) {
		this.#ui = ui;
		this.#host = host;
		this.#all = options.all;
		this.#target = { dir: options.dir };
	}

	run(): Promise<void> {
		void this.#refresh();
		this.#refreshTimer = setInterval(() => void this.#refresh(), REFRESH_MS);
		this.#unwatch = this.#host.watch(() => {
			if (this.#eventTimer) return;
			this.#eventTimer = setTimeout(() => {
				this.#eventTimer = undefined;
				void this.#refresh();
			}, EVENT_REFRESH_MS);
		});
		return this.#done.promise;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearInterval(this.#refreshTimer);
		clearTimeout(this.#eventTimer);
		this.#unwatch?.();
		this.#stopLogsPoll();
		this.#tableView.dispose();
		this.#infoView.dispose();
		this.#logsView.dispose();
		this.#host.close();
	}

	// -- data ----------------------------------------------------------------

	async #refresh(): Promise<void> {
		if (this.#refreshing || this.#disposed) return;
		this.#refreshing = true;
		try {
			const board = await this.#host.collectBoard(this.#all, this.#target);
			if (this.#disposed) return;
			this.#board = board;
			this.#sourceReports = board.reports;
			this.#applyFilter();
			this.#lastRefresh = Date.now();
			this.#ui.requestRender();
		} catch (error) {
			this.#setStatus("error", error instanceof Error ? error.message : String(error));
		} finally {
			this.#refreshing = false;
		}
	}

	#restoreSelection(): void {
		if (this.#selectedKey !== undefined) {
			const index = this.#flat.findIndex(entry => flatKey(entry) === this.#selectedKey);
			if (index >= 0) {
				this.#selected = index;
				return;
			}
		}
		this.#selected = Math.max(0, Math.min(this.#selected, this.#flat.length - 1));
		this.#selectedKey = this.#flat[this.#selected] ? flatKey(this.#flat[this.#selected]) : undefined;
	}

	#applyFilter(): void {
		this.#filteredQuery = this.#search.query;
		this.#reports = this.#search.query.trim()
			? this.#sourceReports.map(report => ({
					...report,
					units: fuzzyFilter(report.units, this.#search.query, unit => tableCells(unit).join(" ")),
				}))
			: this.#sourceReports;
		this.#flat = this.#reports.flatMap(report => report.units.map(unit => ({ scope: report.scope, unit })));
		this.#restoreSelection();
	}

	#setStatus(tone: PsStatusTone, text: string): void {
		this.#status = STATUS_PAINT[tone](text);
		this.#statusText = text;
		this.#statusTone = tone;
		this.#statusAt = Date.now();
		this.#ui.requestRender();
	}

	// -- actions ---------------------------------------------------------------

	async #act(verb: "stop" | "kill" | "restart"): Promise<void> {
		const entry = this.#flat[this.#selected];
		if (!entry) return;
		const name = unitName(entry.unit);
		const messages = ACTION_MESSAGES[verb];
		this.#setStatus("warning", t(messages.pending, { name }));
		try {
			const unit = await this.#host.act(entry.unit, verb);
			this.#setStatus("success", t(messages.success, { unit: unitLabel(unit) }));
			void this.#refresh();
		} catch (error) {
			this.#setStatus(
				"error",
				t(messages.failed, { name, error: error instanceof Error ? error.message : String(error) }),
			);
		}
	}

	async #openInfo(): Promise<void> {
		const entry = this.#flat[this.#selected];
		if (!entry) return;
		this.#search.focused = false;
		this.#keys.reset();
		this.#stopLogsPoll();
		this.#view = "info";
		this.#nativeScroll = undefined;
		this.#info = undefined;
		const request = ++this.#viewRequest;
		try {
			const info = await this.#host.describe(entry.unit);
			if (this.#disposed || request !== this.#viewRequest || this.#view !== "info") return;
			this.#info = info;
			this.#ui.requestRender();
		} catch (error) {
			this.#setStatus("error", error instanceof Error ? error.message : String(error));
		}
	}

	#openLogs(): void {
		const entry = this.#flat[this.#selected];
		if (!entry) return;
		this.#search.focused = false;
		this.#keys.reset();
		this.#view = "logs";
		this.#viewRequest++;
		this.#nativeScroll = undefined;
		this.#logsLines = [];
		this.#logsState = "";
		this.#logsError = undefined;
		const poll = async (): Promise<void> => {
			const current = this.#flat[this.#selected];
			if (this.#disposed || this.#view !== "logs" || !current) return;
			try {
				const result = await this.#host.logs(current.unit, Math.max(10, this.#ui.terminal.rows - 4));
				this.#logsLines = (result.terminalOutput || result.text).replace(/\n$/, "").split("\n");
				this.#logsState = result.state;
				this.#logsError = undefined;
				this.#ui.requestRender();
			} catch (error) {
				this.#logsError = error instanceof Error ? error.message : String(error);
				this.#logsLines = [chalk.red(this.#logsError)];
				this.#ui.requestRender();
			}
		};
		void poll();
		this.#logsTimer = setInterval(() => void poll(), LOGS_POLL_MS);
	}

	#stopLogsPoll(): void {
		clearInterval(this.#logsTimer);
		this.#logsTimer = undefined;
	}

	#closeView(): void {
		this.#stopLogsPoll();
		this.#view = "table";
		this.#viewRequest++;
		this.#nativeScroll = undefined;
		this.#info = undefined;
		this.#ui.requestRender();
	}

	// -- input -----------------------------------------------------------------

	handleInput(data: string): void {
		if (!this.#search.focused && this.#help.handleInput(data)) {
			this.#keys.reset();
			this.#ui.requestRender();
			return;
		}
		const before = this.#search.query;
		if (this.#search.handleInput(data) !== "pass") {
			if (this.#search.query !== before) this.#applyFilter();
			this.#ui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.#done.resolve();
			return;
		}
		const action = this.#keys.read(data);
		if (action === "pending") return;
		const by = action && menuScrollBy(action);
		if (by) this.#nativeScroll = { by, n: (this.#nativeScroll?.n ?? 0) + 1 };
		if (action?.kind === "search") {
			if (this.#view !== "table") this.#closeView();
			this.#search.focused = true;
			this.#ui.requestRender();
			return;
		}
		if (action?.kind === "cancel" || data === "q") {
			if (this.#view !== "table") this.#closeView();
			else this.#done.resolve();
			return;
		}
		if (action?.kind === "context" || action?.kind === "horizontal") {
			this.#search.focused = false;
			const views: PsTopView[] = ["table", "info", "logs"];
			const next = views[(views.indexOf(this.#view) + action.delta + views.length) % views.length];
			this.#stopLogsPoll();
			if (next === "info") void this.#openInfo();
			else if (next === "logs") this.#openLogs();
			else this.#closeView();
			return;
		}
		if (this.#view !== "table") {
			const view = this.#view === "info" ? this.#infoView : this.#logsView;
			if (action && view.handleMenuAction(action)) this.#ui.requestRender();
			return;
		}
		if (action?.kind === "move") this.#moveSelection(action.delta);
		else if (action?.kind === "halfPage" || action?.kind === "page") {
			const page = Math.max(1, this.#ui.terminal.rows - 5);
			this.#moveSelection(action.delta * Math.max(1, Math.floor(page / (action.kind === "halfPage" ? 2 : 1))));
		} else if (action?.kind === "boundary") {
			this.#moveSelection((action.edge === "first" ? -1 : 1) * this.#flat.length);
		} else if (action?.kind === "scroll") {
			this.#tableView.scroll(action.delta);
			this.#ui.requestRender();
		} else if (action?.kind === "confirm" || action?.kind === "toggle" || data === "i") void this.#openInfo();
		else if (data === "a") this.#toggleAll();
		else if (data === "o") this.#openLogs();
		else if (data === "s") void this.#act("stop");
		else if (data === "x") void this.#act("kill");
		else if (data === "r") void this.#act("restart");
	}

	#toggleAll(): void {
		this.#all = !this.#all;
		this.#setStatus("muted", this.#all ? t("cli.commands.ps.scope.showAll") : t("cli.commands.ps.scope.showCurrent"));
		void this.#refresh();
	}

	#moveSelection(delta: number): void {
		if (this.#flat.length === 0) return;
		this.#selected = Math.max(0, Math.min(this.#flat.length - 1, this.#selected + delta));
		this.#selectedKey = flatKey(this.#flat[this.#selected]);
		this.#ui.requestRender();
	}

	// -- native --------------------------------------------------------------

	/**
	 * Pointer actions: a click selects a process, a double click opens its info
	 * (Enter); the scope control switches between the current and all scopes;
	 * the action bar runs the same code as the keys, except that a pointer
	 * `Kill` asks first (the `x` key stays immediate).
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action") {
			this.#nativeAction(event.act);
			return;
		}
		if (event.type !== "select" && event.type !== "activate") return;
		if (event.item === "current" || event.item === "all") {
			if ((event.item === "all") !== this.#all) this.#toggleAll();
			return;
		}
		if (this.#view !== "table") return;
		const index = this.#flat.findIndex(entry => stableKey(flatKey(entry)) === event.item);
		if (index < 0) return;
		this.#selected = index;
		this.#selectedKey = flatKey(this.#flat[index]);
		this.#killConfirm = undefined;
		this.#search.focused = false;
		this.#keys.reset();
		if (event.type === "activate") void this.#openInfo();
		else this.#ui.requestRender();
	}

	#nativeAction(act: string): void {
		switch (act) {
			case "info":
				void this.#openInfo();
				return;
			case "logs":
				this.#openLogs();
				return;
			case "stop":
			case "restart":
				void this.#act(act);
				return;
			case "kill":
				this.#killConfirm = this.#selectedKey;
				this.#ui.requestRender();
				return;
			case "kill-confirm":
				this.#killConfirm = undefined;
				void this.#act("kill");
				return;
			case "kill-cancel":
				this.#killConfirm = undefined;
				this.#ui.requestRender();
				return;
			case "back":
				if (this.#search.focused || this.#search.value) this.handleInput("\x1b");
				else this.#closeView();
				return;
			case "quit":
				if (this.#search.focused || this.#search.value) this.handleInput("\x1b");
				else this.#done.resolve();
				return;
		}
	}

	/**
	 * The process monitor as a native page: a head (title, counts, the scope
	 * control, freshness, close), one section per unit scope with a
	 * selectable process list, the transient status, and an action bar that
	 * mirrors the keys. Info and logs replace the list.
	 */
	describe(cx?: DescribeContext): NativeNode {
		if (this.#help.open) return this.#help.describe();
		if (this.#filteredQuery !== this.#search.query) this.#applyFilter();
		const statusVisible = Date.now() - this.#statusAt < STATUS_TTL_MS;
		const search = cx ? this.#search.input.describe(cx) : text(this.#search.value);
		const queryError = compileMenuRegex(this.#search.value)?.error;
		return this.#native.get(
			[
				getLocale(),
				this.#view,
				this.#board,
				this.#selected,
				this.#all,
				this.#lastRefresh,
				this.#info,
				this.#logsLines,
				this.#logsState,
				this.#logsError,
				statusVisible,
				this.#statusText,
				this.#statusTone,
				this.#killConfirm,
				search,
				queryError,
				this.#nativeScroll,
			],
			() => {
				const body =
					this.#view === "info"
						? this.#describeInfo()
						: this.#view === "logs"
							? this.#describeLogs()
							: this.#describeTable();
				return col(
					compact([
						this.#describeHead(),
						this.#view === "table" && search,
						this.#view === "table" && queryError !== undefined && text([span(queryError, "error")]),
						{ ...body, scroll: this.#nativeScroll },
						statusVisible &&
							this.#statusText !== "" &&
							keyed(
								text([span(this.#statusText, this.#statusTone)], { wrap: "word", role: "omp.app.status" }),
								"status",
							),
						this.#describeActions(),
					]),
					{ role: "omp.app.ps", gap: "md" },
				);
			},
		);
	}

	#describeHead(): NativeNode {
		const entry = this.#flat[this.#selected];
		const left: NativeNode[] = [];
		if (this.#view === "table") {
			const running = this.#flat.filter(flat => !TERMINAL_STATES[flat.unit.state]).length;
			const stopped = this.#flat.length - running;
			left.push(
				text(t("cli.commands.ps.header.processes"), { role: "omp.app.title" }),
				text(
					[
						span(t("cli.commands.ps.header.running", { count: running }), running > 0 ? "success" : "muted"),
						...(stopped > 0 ? [span(t("cli.commands.ps.header.stopped", { count: stopped }), "muted")] : []),
						span(
							` · ${this.#reports.length === 1 ? t("cli.commands.ps.board.scopeCount", { count: this.#reports.length }) : t("cli.commands.ps.board.scopeCountPlural", { count: this.#reports.length })}`,
							"muted",
						),
						this.#board?.daemon
							? span(` · ${t("cli.commands.ps.board.daemonPid", { pid: this.#board.daemon.pid })}`, "muted")
							: span(t("cli.commands.ps.header.daemonOffline"), "dim"),
					],
					{ truncate: "end" },
				),
			);
		} else {
			left.push(
				iconButton("back", "back", t("cli.commands.ps.header.backHint"), { aria: t("cli.commands.ps.back") }),
				text(
					this.#view === "logs"
						? t("cli.commands.ps.logs.title", { unit: entry ? unitName(entry.unit) : "?" })
						: entry
							? unitName(entry.unit)
							: "?",
					{
						role: "omp.app.title",
						truncate: "end",
					},
				),
			);
			const unit = this.#view === "info" ? this.#info?.unit : entry?.unit;
			if (unit) left.push(node("badge", { text: stateLabel(unit), tone: unitTone(unit) }));
			if (this.#view === "logs" && this.#logsState) left.push(text([span(this.#logsState, "muted")]));
		}
		const right: NativeNode[] = [];
		if (this.#view === "table") {
			right.push(
				segmentedTabs(
					{
						items: [
							{
								id: "current",
								label:
									this.#target.dir !== undefined
										? t("cli.commands.ps.scope.target")
										: t("cli.commands.ps.scope.projectTab"),
							},
							{ id: "all", label: t("cli.commands.ps.scope.allTab") },
						],
						active: this.#all ? "all" : "current",
						role: "omp.app.seg",
					},
					"scope",
				),
			);
		}
		// Keep the native elapsed timer between the translated parts of the message.
		const [updatedPrefix, updatedSuffix] = t("cli.commands.ps.header.updated")
			.split("{duration}")
			.map(part => part.trim());
		right.push(
			this.#lastRefresh
				? row(
						compact([
							updatedPrefix ? text([span(updatedPrefix, "dim")]) : undefined,
							elapsed(Date.now() - this.#lastRefresh),
							updatedSuffix ? text([span(updatedSuffix, "dim")]) : undefined,
						]),
						{
							gap: "xs",
							align: "center",
							role: "omp.app.fresh",
						},
					)
				: row([node("spinner", { style: "dots" }), text([span(t("cli.commands.ps.header.updating"), "dim")])], {
						gap: "xs",
						align: "center",
						role: "omp.app.fresh",
					}),
			iconButton("x", "quit", t("cli.commands.ps.header.quitHint"), { aria: t("cli.commands.ps.quit") }),
		);
		return keyed(
			row(
				[
					row(left, { gap: "sm", align: "center", role: "omp.app.where" }),
					row(right, { gap: "md", align: "center", role: "omp.app.tools" }),
				],
				{ justify: "between", align: "center", role: "omp.app.head" },
			),
			"head",
		);
	}

	/** The action bar for the view, or the kill confirmation that replaces it. */
	#describeActions(): NativeNode {
		const entry = this.#flat[this.#selected];
		if (
			this.#view === "table" &&
			entry &&
			this.#killConfirm === this.#selectedKey &&
			this.#killConfirm !== undefined
		) {
			const pids = pidsCell(entry.unit);
			return keyed(
				row(
					[
						text(
							[
								span(
									t("cli.commands.ps.confirm.kill", {
										unit: unitName(entry.unit),
										pid: pids === "-" ? "" : t("cli.commands.ps.confirm.pid", { pid: pids }),
									}),
									"strong",
								),
								span(t("cli.commands.ps.confirm.killWarning"), "muted"),
							],
							{ truncate: "end", grow: 1 },
						),
						actionButton(t("cli.commands.ps.cancel"), "kill-cancel"),
						actionButton(t("cli.commands.ps.actions.kill"), "kill-confirm", { tone: "error" }),
					],
					{ gap: "sm", align: "center", role: "omp.app.confirm", tone: "error" },
				),
				"actions",
			);
		}
		if (this.#view !== "table") {
			return actionBar([
				actionButton(t("cli.commands.ps.back"), "back", { keys: "escape", tone: "accent" }),
				...(this.#view === "info" ? [actionButton(t("cli.commands.ps.actions.logs"), "logs")] : []),
			]);
		}
		if (!entry) return actionBar([null, actionButton(t("cli.commands.ps.quit"), "quit", { keys: "q" })]);
		return actionBar([
			actionButton(t("cli.commands.ps.actions.info"), "info", { keys: "enter", tone: "accent" }),
			actionButton(t("cli.commands.ps.actions.logs"), "logs", { keys: "o" }),
			actionButton(t("cli.commands.ps.actions.restart"), "restart", { keys: "r" }),
			actionButton(t("cli.commands.ps.actions.stop"), "stop", { keys: "s" }),
			actionButton(t("cli.commands.ps.actions.kill"), "kill", {
				keys: "x",
				tone: "error",
				title: t("cli.commands.ps.actions.killHint"),
			}),
			null,
			actionButton(t("cli.commands.ps.quit"), "quit", { keys: "q" }),
		]);
	}

	#describeTable(): NativeNode {
		if (this.#reports.length === 0) {
			return keyed(
				col(
					[
						text(t("cli.commands.ps.board.noUnits"), { role: "omp.app.empty-title" }),
						text([
							span(
								this.#board?.daemon
									? t("cli.commands.ps.board.daemonEmpty")
									: t("cli.commands.ps.board.daemonDown"),
								"muted",
							),
							span(
								this.#all ? t("cli.commands.ps.board.allEmpty") : t("cli.commands.ps.board.showAllWith"),
								"muted",
							),
							...(this.#all ? [] : [span("a", "key"), span(".", "muted")]),
						]),
					],
					{ gap: "xs", align: "center", role: "omp.app.empty" },
				),
				"empty",
			);
		}
		const selected = this.#flat[this.#selected];
		const sections = this.#reports.map(report =>
			node(
				"section",
				{ head: scopeSpans(report.scope), role: "omp.app.ps.scope" },
				[
					node(
						"list",
						{
							selected:
								selected && scopeId(selected.scope) === scopeId(report.scope)
									? stableKey(flatKey(selected))
									: null,
							empty: t("cli.commands.ps.board.noUnits"),
							role: "omp.ps.processes",
						},
						report.units.map(unit => describeUnit(report.scope, unit)),
					),
				],
				stableKey(scopeId(report.scope)),
			),
		);
		return keyed(col(sections, { gap: "lg", grow: 1, role: "omp.app.ps.scopes" }), "scopes");
	}

	#describeInfo(): NativeNode {
		const info = this.#info;
		if (!info) {
			return keyed(
				row([node("spinner", { style: "dots" }), text([span(t("cli.commands.ps.info.loading"), "muted")])], {
					gap: "sm",
				}),
				"info",
			);
		}
		const { unit, proc } = info;
		const command = collapseCommand(formatCommand(proc) ?? unit.command);
		const cwd = proc?.cwd ?? unit.cwd;
		const items: { k: string; v: TspText }[] = [
			{ k: t("cli.commands.ps.info.kind"), v: unit.kind },
			{ k: t("cli.commands.ps.info.key"), v: [span(unit.key, "mono")] },
			{ k: t("cli.commands.ps.info.id"), v: [span(unit.id, "mono")] },
		];
		if (command) items.push({ k: t("cli.commands.ps.info.command"), v: [span(command, "mono")] });
		if (cwd) items.push({ k: t("cli.commands.ps.info.directory"), v: [span(cwd, "path")] });
		const pids = pidsCell(unit);
		if (pids !== "-") items.push({ k: "PID", v: [span(pids, "num")] });
		if (unit.exitReason) items.push({ k: t("cli.commands.ps.info.exit"), v: [span(unit.exitReason, "error")] });
		items.push({
			k: t("cli.commands.ps.info.restarts"),
			v: t("cli.commands.ps.info.restartPolicy", { count: unit.restartCount, policy: unit.policy.restart }),
		});
		items.push({ k: t("cli.commands.ps.info.leases"), v: String(unit.leases) });
		items.push({ k: t("cli.commands.ps.info.idle"), v: idleCell(unit) });
		items.push({ k: t("cli.commands.ps.info.owner"), v: unit.owner ?? "—" });
		const flags = [
			proc?.pty && "pty",
			t("cli.commands.ps.info.hold", { policy: unit.policy.hold }),
			t("cli.commands.ps.info.survive", { policy: unit.policy.survive }),
		].filter(Boolean);
		items.push({ k: t("cli.commands.ps.info.flags"), v: flags.join(" · ") });
		const body: NativeNode[] = [];
		if (!TERMINAL_STATES[unit.state]) {
			body.push(
				row([text([span(t("cli.commands.ps.info.upFor"), "muted")]), elapsed(Date.now() - unit.startedAt)], {
					gap: "xs",
					role: "omp.app.fresh",
				}),
			);
		}
		body.push(node("kv", { items, layout: "grid" }));
		return keyed(col(body, { role: "omp.ps.info", gap: "md" }), "info");
	}

	#describeLogs(): NativeNode {
		if (this.#logsError) {
			return keyed(text([span(this.#logsError, "error mono")], { wrap: "word", role: "omp.ps.logs" }), "logs");
		}
		return node(
			"ansi",
			{ text: this.#logsLines.join("\n"), follow: true, role: "omp.ps.logs", grow: 1 },
			undefined,
			"logs",
		);
	}

	// -- render ------------------------------------------------------------

	render(width: number): readonly string[] {
		const height = Math.max(6, this.#ui.terminal.rows);
		const lines =
			this.#view === "info"
				? this.#renderInfo(width, height)
				: this.#view === "logs"
					? this.#renderLogs(width, height)
					: this.#renderTable(width, height);
		return this.#help.render(lines, width);
	}

	#header(width: number, title: string): string {
		const age = this.#lastRefresh
			? t("cli.commands.ps.header.updated", { duration: formatDuration(Date.now() - this.#lastRefresh) })
			: t("cli.commands.ps.header.updatingAnsi");
		const left = ` ${chalk.bold(`${APP_NAME} ps`)} ${chalk.dim("·")} ${title}`;
		const right = chalk.dim(age);
		const pad = Math.max(1, width - Bun.stringWidth(left) - Bun.stringWidth(right) - 1);
		return truncateToWidth(`${left}${" ".repeat(pad)}${right}`, width);
	}

	#footer(width: number, hints: string): string[] {
		const status = Date.now() - this.#statusAt < STATUS_TTL_MS ? this.#status : "";
		return [truncateToWidth(` ${status}`, width), ...menuHintLines(` ${hints}`, width).map(line => chalk.dim(line))];
	}

	#renderTable(width: number, height: number): string[] {
		const scopeKind = this.#all
			? t("cli.commands.ps.scope.allAnsi")
			: this.#target.dir !== undefined
				? t("cli.commands.ps.scope.targetAnsi")
				: t("cli.commands.ps.scope.currentAnsi");
		const units =
			this.#flat.length === 1
				? t("cli.commands.ps.board.unitCount", { count: this.#flat.length })
				: t("cli.commands.ps.board.unitCountPlural", { count: this.#flat.length });
		const scopes =
			this.#reports.length === 1
				? t("cli.commands.ps.board.scopeCount", { count: this.#reports.length })
				: t("cli.commands.ps.board.scopeCountPlural", { count: this.#reports.length });
		const scopesLabel = t("cli.commands.ps.board.summary", { units, scopes, scopeKind: chalk.dim(scopeKind) });
		const header = this.#header(width, scopesLabel);
		const footer = this.#footer(width, t("cli.commands.ps.footer.table"));
		footer.unshift(this.#search.render(width, { muted: chalk.dim }));
		const bodyHeight = height - 1 - footer.length;

		const cells = this.#flat.map(entry => tableCells(entry.unit));
		const headings = tableHeader();
		const widths = headings.map((title, column) =>
			Math.max(title.length, ...cells.map(row => Bun.stringWidth(row[column]))),
		);
		const columns: TableColumn[] = widths.map((columnWidth): TableColumn => ({
			width: columnWidth,
			align: "left",
			overflow: "truncate",
		}));
		const renderRow = (row: string[]): string =>
			renderTableRow(
				row.map(cell => ({ text: cell })),
				columns,
				undefined,
				{ indent: "   ", gap: "  ", fit: false },
			).trimEnd();

		// Body lines with the flat index carried for selection highlighting.
		const body: { text: string; flat?: number }[] = [{ text: ` ${daemonHeader(this.#board?.daemon)}` }, { text: "" }];
		let flatIndex = 0;
		for (const report of this.#reports) {
			body.push({ text: ` ${scopeHeader(report.scope)}` });
			if (report.units.length === 0) {
				body.push({ text: chalk.dim(t("cli.commands.ps.board.noUnitsScopeAnsi")) });
			} else {
				body.push({ text: chalk.dim(renderRow(headings)) });
				for (const unit of report.units) {
					const line = renderRow(tableCells(unit));
					body.push({
						text: TERMINAL_STATES[unit.state] ? chalk.dim(line) : line,
						flat: flatIndex,
					});
					flatIndex++;
				}
			}
			body.push({ text: "" });
		}
		if (this.#reports.length === 0) body.push({ text: chalk.dim(t("cli.commands.ps.board.noUnitsAnsi")) });

		// Keep the selected logical row visible through refreshes and resizes.
		const selectedLine = body.findIndex(line => line.flat === this.#selected);
		const display = body.map(entry => {
			if (entry.flat === this.#selected) {
				const plain = ` ❯${Bun.stripANSI(entry.text).slice(2)}`;
				return truncateToWidth(chalk.inverse(plain.padEnd(width)), width);
			}
			return truncateToWidth(entry.text, width);
		});
		this.#tableView.setLines(display);
		this.#tableView.setHeight(bodyHeight);
		this.#tableView.revealRange(
			selectedLine >= 0 ? { id: this.#selectedKey ?? "", start: selectedLine, end: selectedLine + 1 } : undefined,
			width,
		);

		const lines = [header, ...this.#tableView.render(width)];
		while (lines.length < height - footer.length) lines.push("");
		lines.push(...footer);
		return lines;
	}

	#renderInfo(width: number, height: number): string[] {
		const info = this.#info;
		const header = this.#header(width, t("cli.commands.ps.info.titleAnsi"));
		const footer = this.#footer(width, t("cli.commands.ps.footer.info"));
		const body = [""];
		if (info) {
			const { unit, proc } = info;
			body.push(` ${chalk.bold(unitLabel(unit))}`);
			body.push("");
			const rows: KeyValueRow[] = [
				{ label: t("cli.commands.ps.info.idAnsi"), value: unit.id },
				{ label: t("cli.commands.ps.info.scopeAnsi"), value: scopeHeader(unit.scope) },
			];
			const command = formatCommand(proc) ?? unit.command;
			if (command) rows.push({ label: t("cli.commands.ps.info.commandAnsi"), value: collapseCommand(command) });
			const cwd = proc?.cwd ?? unit.cwd;
			if (cwd) rows.push({ label: t("cli.commands.ps.info.cwdAnsi"), value: cwd });
			if (!TERMINAL_STATES[unit.state])
				rows.push({
					label: t("cli.commands.ps.info.uptimeAnsi"),
					value: formatDuration(Date.now() - unit.startedAt),
				});
			if (unit.exitReason) rows.push({ label: t("cli.commands.ps.info.exitAnsi"), value: unit.exitReason });
			rows.push({
				label: t("cli.commands.ps.info.restartsAnsi"),
				value: t("cli.commands.ps.info.restartPolicyAnsi", {
					count: unit.restartCount,
					policy: unit.policy.restart,
				}),
			});
			rows.push({
				label: t("cli.commands.ps.info.leasesAnsi"),
				value: t("cli.commands.ps.info.leasesIdle", { count: unit.leases, idle: idleCell(unit) }),
			});
			rows.push({ label: t("cli.commands.ps.info.ownerAnsi"), value: unit.owner ?? "-" });
			this.#infoList.setRows(rows);
			body.push(...this.#infoList.render(width));
			body.push(
				t("cli.commands.ps.info.flagsAnsi", {
					pty: String(proc?.pty ?? false),
					hold: unit.policy.hold,
					survive: unit.policy.survive,
				}),
			);
		} else {
			body.push(chalk.dim(t("cli.commands.ps.info.loadingAnsi")));
		}
		this.#infoView.setLines(body);
		this.#infoView.setHeight(height - 1 - footer.length);
		return [header, ...this.#infoView.render(width), ...footer];
	}

	#renderLogs(width: number, height: number): string[] {
		const entry = this.#flat[this.#selected];
		const name = entry ? unitName(entry.unit) : "?";
		const header = this.#header(
			width,
			`${t("cli.commands.ps.logs.titleAnsi", { unit: chalk.bold(name) })}${this.#logsState ? chalk.dim(` · ${this.#logsState}`) : ""}`,
		);
		const footer = this.#footer(width, t("cli.commands.ps.footer.logs"));
		const bodyHeight = height - 1 - footer.length;
		this.#logsView.setLines(this.#logsLines.map(line => ` ${line}`));
		this.#logsView.setHeight(bodyHeight);
		const lines = [header, ...this.#logsView.render(width)];
		while (lines.length < height - footer.length) lines.push("");
		lines.push(...footer);
		return lines;
	}
}

function flatKey(entry: FlatRow): string {
	return entry.unit.id;
}

/** Semantic tone of a unit state (the ANSI STATE cell's colour). */
function unitTone(snapshot: UnitSnapshot): TspTone {
	if (snapshot.state === "ready" || snapshot.state === "running") return "success";
	if (snapshot.state === "failed") return "error";
	return TERMINAL_STATES[snapshot.state] ? "muted" : "warning";
}

/** Scope heading spans, e.g. `project /work/pi`. */
function scopeSpans(scope: UnitScope): TspSpan[] {
	const { kind, name } = scopeTitle(scope);
	if (!name) return [span(kind, "strong")];
	return [span(`${kind} `), span(name, scope.kind === "project" ? "strong path" : "strong mono")];
}

/** A state as the table shows it: `ready`, `exited(143)`. */
function stateLabel(snapshot: UnitSnapshot): string {
	return TERMINAL_STATES[snapshot.state] && snapshot.exitCode !== undefined
		? `${snapshot.state}(${snapshot.exitCode})`
		: snapshot.state;
}

/** Status icon of a unit state (tinted by {@link unitTone}). */
const STATE_ICON: Record<TspTone, string> = {
	success: "check",
	error: "x",
	muted: "stop",
	warning: "clock",
	neutral: "activity",
	accent: "activity",
	info: "activity",
	pending: "clock",
	user: "user",
};

/** One selectable unit row: kind and name, state/pids/uptime/leases/idle/flags, and the launch command. */
function describeUnit(scope: UnitScope, unit: UnitSnapshot): NativeNode {
	const terminal = TERMINAL_STATES[unit.state] === true;
	const state = stateLabel(unit);
	const pids = pidsCell(unit);
	const idle = idleCell(unit);
	const meta = [
		unit.kind,
		pids === "-" ? undefined : t("cli.commands.ps.unit.rowPid", { pid: pids }),
		terminal ? undefined : formatDuration(Date.now() - unit.startedAt),
		unit.leases > 0
			? unit.leases === 1
				? t("cli.commands.ps.unit.leaseCount", { count: unit.leases })
				: t("cli.commands.ps.unit.leaseCountPlural", { count: unit.leases })
			: undefined,
		idle === "-" ? undefined : t("cli.commands.ps.unit.rowIdle", { idle: idle }),
		unit.restartCount > 0
			? unit.restartCount === 1
				? t("cli.commands.ps.unit.restartCount", { count: unit.restartCount })
				: t("cli.commands.ps.unit.restartCountPlural", { count: unit.restartCount })
			: undefined,
		flagsCell(unit) || undefined,
	].filter(part => part !== undefined);
	const command = collapseCommand(unit.command);
	const tone = unitTone(unit);
	return node(
		"item",
		{
			label: [span(unitName(unit), terminal ? "dim" : "strong")],
			detail: command ? [span(command, "mono muted")] : undefined,
			value: [span(state, tone === "muted" ? "dim" : tone), span(` · ${meta.join(" · ")}`, "muted")],
			icon: STATE_ICON[tone],
			tone,
			title: unitLabel(unit),
		},
		undefined,
		stableKey(flatKey({ scope, unit })),
	);
}

/** Run the fullscreen interactive process monitor until the user quits. */
export async function runPsTop(options: PsTopOptions, host: PsTopHost): Promise<void> {
	const ui = new TUI(new ProcessTerminal());
	const component = new PsTopComponent(ui, options, host);
	const overlay = ui.showOverlay(component, {
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
		fullscreen: true,
		mouseTracking: false,
	});
	ui.setFocus(component);
	ui.start();
	try {
		await component.run();
	} finally {
		component.dispose();
		overlay.hide();
		ui.stop();
	}
}
