import { pluralize } from "@oh-my-pi/pi-utils";
import { getCatalog, t } from "@oh-my-pi/pi-utils/i18n";

const nounKeys = new Map<string, string>([
	["change", "tools.count.change"],
	["entry", "tools.count.entry"],
	["message", "tools.count.message"],
	["result", "tools.count.result"],
	["stage", "tools.count.stage"],
	["task", "tools.count.task"],
	["tool", "tools.count.tool"],
	["agent", "tools.count.agent"],
	["error", "tools.count.error"],
	["field", "tools.count.field"],
	["file", "tools.count.file"],
	["finding", "tools.count.finding"],
	["hint", "tools.count.hint"],
	["hit", "tools.count.hit"],
	["info", "tools.count.info"],
	["item", "tools.count.item"],
	["line", "tools.count.line"],
	["match", "tools.count.match"],
	["more file", "tools.count.more_file"],
	["more hit", "tools.count.more_hit"],
	["reference", "tools.count.reference"],
	["replacement", "tools.count.replacement"],
	["server failure", "tools.count.server_failure"],
	["source", "tools.count.source"],
	["step", "tools.count.step"],
	["symbol", "tools.count.symbol"],
	["todo", "tools.count.todo"],
	["unverified file", "tools.count.unverified_file"],
	["warning", "tools.count.warning"],
	["yield", "tools.count.yield"],
]);

export function localizedNoun(label: string, count: number): string {
	const key = nounKeys.get(label);
	return (key && getCatalog()[`${key}.${count === 1 ? "one" : "many"}`]) || pluralize(label, count);
}

/** A count for tool presentation only; model-facing text uses the unlocalized formatter. */
export function formatCount(label: string, count: number): string {
	const safeCount = Number.isFinite(count) ? count : 0;
	return t("tools.count.quantity", { count: safeCount, noun: localizedNoun(label, safeCount) });
}
