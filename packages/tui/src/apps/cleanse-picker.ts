/**
 * Standalone TUI pickers for `npi cleanse`.
 *
 * One-shot {@link selectStandaloneItem} and {@link promptStandaloneText}
 * prompts, resolved on select/submit/cancel so the command can keep writing
 * plain stdout afterwards.
 */
import { t } from "@oh-my-pi/pi-utils/i18n";
import { type SelectItem } from "../components/select-list";
import { promptStandaloneText, selectStandaloneItem } from "./standalone-picker";

/** Checker metadata presented by the target picker. */
export interface CleanseCheckerChoice {
	id: string;
	label: string;
	language: string;
	command: string;
}

/** Selected checker scope or free-form repair request. */
export type CleanseTargetChoice =
	| { kind: "all" }
	| { kind: "checker"; id: string }
	| { kind: "request"; request: string }
	| { kind: "cancel" };

/** Pick between running every discovered checker, one specific checker, or a free-form request. */
export async function pickCleanseTarget(checkers: readonly CleanseCheckerChoice[]): Promise<CleanseTargetChoice> {
	const items: SelectItem[] = [
		{
			value: "all",
			label: t(checkers.length === 1 ? "cli.commands.cleanse.run_all.one" : "cli.commands.cleanse.run_all.many", {
				count: checkers.length,
			}),
		},
		...checkers.map(checker => ({
			value: `checker:${checker.id}`,
			label: checker.label,
			description: `${checker.language} — ${checker.command}`,
		})),
		{
			value: "request",
			label: t("cli.commands.cleanse.describe_fix"),
			description: t("cli.commands.cleanse.discovery"),
		},
	];
	const selection = await selectStandaloneItem(t("cli.commands.cleanse.select"), items, {
		maxVisible: 12,
		picker: {
			icon: "wand",
			noun: t("cli.commands.cleanse.checkers"),
			subtitle: t("cli.commands.cleanse.subtitle"),
			confirm: t("cli.commands.cleanse.confirm"),
		},
	});
	if (selection === null) return { kind: "cancel" };
	if (selection === "all") return { kind: "all" };
	if (selection === "request") {
		const request = await promptCleanseRequest();
		return request === null ? { kind: "cancel" } : { kind: "request", request };
	}
	return { kind: "checker", id: selection.slice("checker:".length) };
}

/** One-shot text prompt for a free-form cleanse request; `null` when cancelled or left empty. */
export async function promptCleanseRequest(): Promise<string | null> {
	return promptStandaloneText(t("cli.commands.cleanse.describe_request"));
}
