/**
 * Owns the `/cleanse` overlay lifecycle: mounts the {@link CleansePanelComponent}
 * above the editor and drives the shared cleanse core against it.
 */
import { t } from "@oh-my-pi/pi-utils/i18n";
import { runCleanse } from "../../cleanse";
import { appKey } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { CleanseBoardModel } from "@oh-my-pi/pi-tui/apps/cleanse-board";
import type { CleanseCheckerDescriptor } from "../../cleanse/checkers";
import type { CleanseTargetChoice } from "@oh-my-pi/pi-tui/apps/cleanse-picker";
import { CleansePanelComponent } from "@oh-my-pi/pi-tui/overlays/cleanse-panel";
import type { InteractiveModeContext } from "../types";

interface CleanseRun {
	panel: CleansePanelComponent;
	abortController: AbortController;
	settled: boolean;
}

interface ParsedCleanseArgs {
	request?: string;
	all: boolean;
	includeTests: boolean;
	maxAgents?: number;
	model?: string;
	error?: string;
}

const cleanseUsage = () => t("overlays.cleanse_command_controller.usage");

export class CleanseCommandController {
	#active: CleanseRun | undefined;

	constructor(private readonly ctx: InteractiveModeContext) {}

	hasActiveRun(): boolean {
		return this.#active !== undefined;
	}

	/** Esc dismisses a settled panel without cancelling live work. */
	handleEscape(): boolean {
		const run = this.#active;
		if (!run?.settled) return false;
		this.#close(run);
		return true;
	}

	handleCancel(): boolean {
		const run = this.#active;
		if (!run || run.settled) return false;
		run.abortController.abort(new Error(t("overlays.cleanse_command_controller.interrupted")));
		return true;
	}

	dispose(): void {
		const run = this.#active;
		if (!run) return;
		run.abortController.abort(new Error(t("overlays.cleanse_command_controller.interrupted")));
		this.#close(run);
	}

	async start(args: string): Promise<void> {
		if (this.#active) {
			this.ctx.showStatus(
				t("overlays.cleanse_command_controller.already_active", {
					part1: `${appKey(this.ctx.keybindings, "app.interrupt")}`,
				}),
			);
			return;
		}
		const parsed = parseCleanseArgs(args);
		if (parsed.error) {
			this.ctx.showStatus(parsed.error);
			return;
		}
		const run: CleanseRun = {
			panel: new CleansePanelComponent({
				request: parsed.request,
				tui: this.ctx.ui,
				model: new CleanseBoardModel(),
			}),
			abortController: new AbortController(),
			settled: false,
		};
		this.#active = run;
		this.ctx.cleanseContainer.clear();
		this.ctx.cleanseContainer.addChild(run.panel);
		this.ctx.ui.requestRender();
		await this.#run(run, parsed);
	}

	async #run(run: CleanseRun, options: ParsedCleanseArgs): Promise<void> {
		try {
			const result = await runCleanse(
				{
					request: options.request,
					all: options.all,
					includeTests: options.includeTests,
					maxAgents: options.maxAgents,
					model: options.model,
				},
				{
					board: run.panel,
					print: text => run.panel.log(text),
					printError: text => run.panel.logError(text),
					pickTarget: checkers => this.#pickTarget(checkers),
					promptRequest: () => this.#promptRequest(),
				},
				run.abortController.signal,
			);
			if (this.#active !== run) return;
			run.panel.finish(result.status);
			// A picker-level cancel settles without any output worth keeping.
			if (result.status === "cancelled" && result.report.checks.length === 0) this.#close(run);
		} catch (error) {
			if (this.#active !== run) return;
			run.panel.markError(error instanceof Error ? error.message : String(error));
		} finally {
			if (this.#active === run) run.settled = true;
		}
	}

	async #pickTarget(checkers: readonly CleanseCheckerDescriptor[]): Promise<CleanseTargetChoice> {
		const allLabel = t("overlays.cleanse_command_controller.run_all", {
			part1: `${checkers.length}`,
			part2: `${checkers.length === 1 ? "" : "s"}`,
		});
		const choice = await this.ctx.showHookSelector(t("overlays.cleanse_command_controller.select"), [
			{ value: "all", label: allLabel },
			...checkers.map(checker => ({
				value: `checker:${checker.id}`,
				label: `${checker.label} — ${checker.command}`,
			})),
			{ value: "request", label: t("overlays.cleanse_command_controller.describe_fix") },
		]);
		if (choice === undefined) return { kind: "cancel" };
		if (choice === "all") return { kind: "all" };
		if (choice === "request") {
			const request = await this.#promptRequest();
			return request === null ? { kind: "cancel" } : { kind: "request", request };
		}
		const checker = checkers.find(checker => `checker:${checker.id}` === choice);
		return checker ? { kind: "checker", id: checker.id } : { kind: "cancel" };
	}

	async #promptRequest(): Promise<string | null> {
		const answer = await this.ctx.showHookInput(
			t("overlays.cleanse_command_controller.describe"),
			t("overlays.cleanse_command_controller.example"),
		);
		const trimmed = answer?.trim();
		return trimmed ? trimmed : null;
	}

	#close(run: CleanseRun): void {
		if (this.#active !== run) return;
		this.#active = undefined;
		run.panel.dispose();
		this.ctx.cleanseContainer.clear();
		this.ctx.ui.requestRender();
	}
}

/** Parse `/cleanse` arguments; flag names mirror the `npi cleanse` CLI. */
function parseCleanseArgs(args: string): ParsedCleanseArgs {
	const tokens = args.split(/\s+/).filter(Boolean);
	const requestParts: string[] = [];
	const parsed: ParsedCleanseArgs = { all: false, includeTests: false };
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] ?? "";
		if (token === "--all" || token === "-a") {
			parsed.all = true;
		} else if (token === "--tests" || token === "-t") {
			parsed.includeTests = true;
		} else if (token === "--agents" || token === "-n") {
			const value = Number(tokens[++i]);
			if (!Number.isInteger(value) || value <= 0) return { ...parsed, error: cleanseUsage() };
			parsed.maxAgents = value;
		} else if (token === "--model" || token === "-m") {
			const value = tokens[++i];
			if (!value) return { ...parsed, error: cleanseUsage() };
			parsed.model = value;
		} else if (token.startsWith("-") && token.length > 1 && !/^-\d/.test(token)) {
			return { ...parsed, error: cleanseUsage() };
		} else {
			requestParts.push(token);
		}
	}
	parsed.request = requestParts.join(" ") || undefined;
	return parsed;
}
