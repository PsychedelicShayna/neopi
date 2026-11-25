/** `debug` — DAP debugger sessions: launch/attach, breakpoints, stepping, evaluate. */
import type { ReactNode } from "react";
import { type Translation, useTranslation } from "../../lib/i18n";
import { Badge, CodeBlock, Kv, KvGrid, PathText, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, display, isRecord, normalizeWs, num, str, truncate } from "../util";

/** Session snapshot the TUI renders as its "Session" section (details.snapshot). */
interface SessionSnapshot {
	id: string | null;
	adapter: string | null;
	status: string | null;
	program: string | null;
	stopReason: string | null;
	frameName: string | null;
	sourcePath: string | null;
	line: number | null;
	column: number | null;
	exitCode: number | null;
	needsConfigurationDone: boolean;
}

function snapshotOf(result: ToolRenderProps["result"]): SessionSnapshot | null {
	const rec = detailsRecord(result);
	if (!rec || !isRecord(rec.snapshot)) return null;
	const snap = rec.snapshot;
	const source = isRecord(snap.source) ? snap.source : null;
	return {
		id: str(snap.id) ?? (num(snap.id) !== null ? String(snap.id) : null),
		adapter: str(snap.adapter),
		status: str(snap.status),
		program: str(snap.program),
		stopReason: str(snap.stopReason),
		frameName: str(snap.frameName),
		sourcePath: source ? str(source.path) : null,
		line: num(snap.line),
		column: num(snap.column),
		exitCode: num(snap.exitCode),
		needsConfigurationDone: snap.needsConfigurationDone === true,
	};
}

function actionOf(props: ToolRenderProps, t: Translation): string {
	const action = str(props.args.action) ?? str(detailsRecord(props.result)?.action);
	return action ? action.replace(/_/g, " ") : t("guesttools.label.request", "request");
}

/** Mirrors the TUI's summarizeDebugCall target priority. */
function targetTextOf(args: Record<string, unknown>): string | null {
	return (
		str(args.function) ??
		str(args.expression) ??
		str(args.command) ??
		str(args.memory_reference) ??
		str(args.instruction_reference) ??
		str(args.data_id) ??
		str(args.name)
	);
}

function Summary(props: ToolRenderProps): ReactNode {
	const t = useTranslation();
	const { args } = props;
	const program = str(args.program);
	const file = str(args.file);
	const line = num(args.line);
	const target = targetTextOf(args);
	return (
		<>
			<Badge tone="accent">{actionOf(props, t)}</Badge>
			{program !== null ? (
				<PathText path={program} />
			) : file !== null ? (
				<PathText path={file} from={line ?? undefined} />
			) : target !== null ? (
				<span>{truncate(normalizeWs(target), 80)}</span>
			) : null}
		</>
	);
}

/** Scalar args worth a KvGrid row, in display order (program/file/expression are special-cased). */
const SCALAR_ARGS: ReadonlyArray<readonly [key: string, messageKey: string, label: string]> = [
	["adapter", "guesttools.debug.adapter", "adapter"],
	["cwd", "guesttools.debug.cwd", "cwd"],
	["function", "guesttools.debug.function", "function"],
	["name", "guesttools.debug.name", "name"],
	["condition", "guesttools.debug.condition", "condition"],
	["hit_condition", "guesttools.debug.hit_condition", "hit condition"],
	["context", "guesttools.debug.context", "context"],
	["frame_id", "guesttools.debug.frame_id", "frame id"],
	["scope_id", "guesttools.debug.scope_id", "scope id"],
	["variable_ref", "guesttools.debug.variable_ref", "variable ref"],
	["pid", "guesttools.debug.pid", "pid"],
	["host", "guesttools.debug.host", "host"],
	["port", "guesttools.debug.port", "port"],
	["levels", "guesttools.debug.levels", "levels"],
	["memory_reference", "guesttools.debug.memory_reference", "memory ref"],
	["instruction_reference", "guesttools.debug.instruction_reference", "instruction ref"],
	["instruction_count", "guesttools.debug.instruction_count", "instruction count"],
	["instruction_offset", "guesttools.debug.instruction_offset", "instruction offset"],
	["offset", "guesttools.debug.offset", "offset"],
	["count", "guesttools.debug.count", "count"],
	["data", "guesttools.debug.data", "data"],
	["data_id", "guesttools.debug.data_id", "data id"],
	["access_type", "guesttools.debug.access_type", "access"],
	["command", "guesttools.debug.command", "command"],
	["resolve_symbols", "guesttools.debug.resolve_symbols", "resolve symbols"],
	["allow_partial", "guesttools.debug.allow_partial", "allow partial"],
	["start_module", "guesttools.debug.start_module", "start module"],
	["module_count", "guesttools.debug.module_count", "module count"],
	["timeout", "guesttools.debug.timeout", "timeout"],
];

function Body(props: ToolRenderProps): ReactNode {
	const t = useTranslation();
	const { args, result } = props;
	const program = str(args.program);
	const file = str(args.file);
	const line = num(args.line);
	const expression = str(args.expression);
	const programArgs = Array.isArray(args.args) ? args.args.filter(a => typeof a === "string") : [];

	const argRows: ReactNode[] = [];
	if (program !== null) {
		argRows.push(
			<Kv key="program" k={t("guesttools.label.program", "program")}>
				<PathText path={program} />
			</Kv>,
		);
	}
	if (programArgs.length > 0) {
		argRows.push(
			<Kv key="args" k={t("guesttools.label.arguments_short", "args")}>
				{truncate(programArgs.join(" "), 160)}
			</Kv>,
		);
	}
	if (file !== null) {
		argRows.push(
			<Kv key="file" k={t("guesttools.label.file", "file")}>
				<PathText path={file} from={line ?? undefined} />
			</Kv>,
		);
	} else if (line !== null) {
		argRows.push(
			<Kv key="line" k={t("guesttools.label.line", "line")}>
				{line}
			</Kv>,
		);
	}
	for (const [key, messageKey, label] of SCALAR_ARGS) {
		const value = args[key];
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
		argRows.push(
			<Kv key={key} k={t(messageKey, label)}>
				{truncate(display(value), 120)}
			</Kv>,
		);
	}

	let customArgsJson = "";
	if (isRecord(args.arguments)) {
		try {
			customArgsJson = JSON.stringify(args.arguments, null, 2) ?? "";
		} catch {
			customArgsJson = "";
		}
	}

	const snapshot = snapshotOf(result);
	return (
		<>
			{argRows.length > 0 && <KvGrid>{argRows}</KvGrid>}
			{expression !== null && (
				<CodeBlock code={expression} title={t("guesttools.label.expression", "expression")} maxLines={8} />
			)}
			{customArgsJson && (
				<CodeBlock
					code={customArgsJson}
					lang="json"
					title={t("guesttools.label.arguments", "arguments")}
					maxLines={10}
				/>
			)}
			{snapshot && (
				<KvGrid>
					{snapshot.id !== null && <Kv k={t("guesttools.label.session", "session")}>{snapshot.id}</Kv>}
					{snapshot.adapter !== null && <Kv k={t("guesttools.label.adapter", "adapter")}>{snapshot.adapter}</Kv>}
					{snapshot.status !== null && (
						<Kv k={t("guesttools.label.status", "status")}>
							<Badge tone={snapshot.status === "exited" ? "warn" : "ok"}>{snapshot.status}</Badge>
						</Kv>
					)}
					{snapshot.program !== null && (
						<Kv k={t("guesttools.label.program", "program")}>
							<PathText path={snapshot.program} />
						</Kv>
					)}
					{snapshot.stopReason !== null && (
						<Kv k={t("guesttools.label.stop_reason", "stop reason")}>{snapshot.stopReason}</Kv>
					)}
					{snapshot.frameName !== null && <Kv k={t("guesttools.label.frame", "frame")}>{snapshot.frameName}</Kv>}
					{snapshot.sourcePath !== null && snapshot.line !== null && (
						<Kv k={t("guesttools.label.location", "location")}>
							<PathText
								path={snapshot.sourcePath}
								sel={snapshot.column !== null ? `${snapshot.line}:${snapshot.column}` : String(snapshot.line)}
							/>
						</Kv>
					)}
					{snapshot.exitCode !== null && (
						<Kv k={t("guesttools.label.exit_code", "exit code")}>{snapshot.exitCode}</Kv>
					)}
					{snapshot.needsConfigurationDone && (
						<Kv k={t("guesttools.label.configuration", "configuration")}>
							{t(
								"guesttools.debug.configuration_pending",
								"pending configurationDone — set breakpoints, then continue",
							)}
						</Kv>
					)}
				</KvGrid>
			)}
			<ResultText result={result} maxLines={10} />
		</>
	);
}

export const debugRenderer: ToolRenderer = { Summary, Body };
