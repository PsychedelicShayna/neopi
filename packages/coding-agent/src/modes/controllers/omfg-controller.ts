import { t } from "@oh-my-pi/pi-utils/i18n";
import { renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
import { invalidate as invalidateCapabilityCache } from "../../capability";
import type { Rule } from "../../capability/rule";
import omfgUserPrompt from "../../prompts/system/omfg-user.md" with { type: "text" };
import { TtsrToolInspector } from "../../session/ttsr-outputs";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { OmfgPanelComponent } from "@oh-my-pi/pi-tui/overlays/omfg-panel";
import type { InteractiveModeContext } from "../types";
import {
	buildOmfgRuleForPath,
	extractGeneratedRuleJson,
	historyOutputs,
	type OmfgRuleSourceLevel,
	type ParsedGeneratedRule,
	parseGeneratedRule,
	validateParsedRuleAgainstAssistantHistory,
} from "./omfg-rule";

interface OmfgRequest {
	component: OmfgPanelComponent;
	abortController: AbortController;
	complaint: string;
	settled: boolean;
}

interface OmfgCandidate extends ParsedGeneratedRule {
	validated: boolean;
}

interface GenerateCandidateOptions {
	initialFeedback?: string;
	previousRule?: string;
}

type SaveCandidateResult = { kind: "saved" | "aborted" | "rejected" } | { kind: "amend"; feedback: string };

const MAX_ATTEMPTS = 3;
/** Keep /omfg prompts in the composer slot: a picker sheet would cover the candidate rule above it. */
const OMFG_DIALOG = { inline: true } as const;

export class OmfgController {
	#activeRequest: OmfgRequest | undefined;
	readonly #inspector: TtsrToolInspector;

	constructor(private readonly ctx: InteractiveModeContext) {
		this.#inspector = new TtsrToolInspector(
			() => ctx.session.agent.state.tools,
			() => ctx.sessionManager.getCwd(),
		);
	}

	hasActiveRequest(): boolean {
		return this.#activeRequest !== undefined;
	}

	handleCancel(): boolean {
		if (!this.#activeRequest || this.#activeRequest.settled) return false;
		this.#closeActiveRequest({ abort: true });
		return true;
	}

	handleDismiss(): boolean {
		if (!this.#activeRequest?.settled) return false;
		this.#closeActiveRequest({ abort: false });
		return true;
	}

	dispose(): void {
		this.#closeActiveRequest({ abort: true });
	}

	async start(complaint: string): Promise<void> {
		const trimmedComplaint = complaint.trim();
		if (!trimmedComplaint) {
			this.ctx.showStatus(t("overlays.omfg_controller.usage"));
			return;
		}

		const model = this.ctx.session.model;
		if (!model) {
			this.ctx.showError(t("overlays.omfg_controller.no_model"));
			return;
		}

		this.#closeActiveRequest({ abort: true });

		const request: OmfgRequest = {
			component: new OmfgPanelComponent({ complaint: trimmedComplaint, tui: this.ctx.ui }),
			abortController: new AbortController(),
			complaint: trimmedComplaint,
			settled: false,
		};
		this.ctx.omfgContainer.clear();
		this.ctx.omfgContainer.addChild(request.component);
		this.ctx.ui.requestRender();
		this.#activeRequest = request;
		void this.#runRequest(request);
	}

	async #runRequest(request: OmfgRequest): Promise<void> {
		try {
			let candidate = await this.#generateCandidate(request);
			for (;;) {
				if (!this.#isActiveRequest(request)) return;
				if (!candidate) {
					request.component.markError(t("overlays.omfg_controller.invalid_rule"));
					return;
				}

				if (!candidate.validated) {
					request.component.setStatus("confirming", t("overlays.omfg_controller.no_match"));
					const shouldSave = await this.ctx.showHookConfirm(
						t("overlays.omfg_controller.validation"),
						t("overlays.omfg_controller.confirm_unmatched"),
						OMFG_DIALOG,
					);
					if (!this.#isActiveRequest(request)) return;
					if (!shouldSave) {
						request.component.markRejected();
						return;
					}
				}

				const saveResult = await this.#saveCandidate(request, candidate);
				if (!this.#isActiveRequest(request)) return;
				if (saveResult.kind !== "amend") {
					return;
				}

				candidate = await this.#generateCandidate(request, {
					initialFeedback: `User requested this amendment before saving:\n${saveResult.feedback}`,
					previousRule: candidate.fileContent,
				});
			}
		} catch (error) {
			if (!this.#isActiveRequest(request)) {
				return;
			}
			if (request.abortController.signal.aborted) {
				request.component.markAborted();
				return;
			}
			request.component.markError(error instanceof Error ? error.message : String(error));
		} finally {
			request.settled = true;
		}
	}

	async #generateCandidate(
		request: OmfgRequest,
		options: GenerateCandidateOptions = {},
	): Promise<OmfgCandidate | undefined> {
		const failedAttempts = options.initialFeedback ? [options.initialFeedback] : [];
		let previousRule = options.previousRule;
		let lastCandidate: ParsedGeneratedRule | undefined;

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			if (this.#shouldStop(request)) return undefined;
			request.component.setRule("");
			request.component.setStatus(
				"generating",
				t("overlays.omfg_controller.generating", { part1: `${attempt}`, part2: `${MAX_ATTEMPTS}` }),
			);
			const promptText = renderPromptAsset(
				"system/omfg-user.md",
				omfgUserPrompt,
				{
					complaint: request.complaint,
					feedback: failedAttempts.length > 0 ? failedAttempts.join("\n\n") : undefined,
					previousRule,
				},
				{ cwd: this.ctx.sessionManager.getCwd() },
			);
			const { replyText } = await this.ctx.session.runEphemeralTurn({
				promptText,
				purpose: "omfg",
				dedupeReply: false,
				onTextDelta: delta => {
					if (this.#isActiveRequest(request)) {
						request.component.appendDraft(delta);
					}
				},
				signal: request.abortController.signal,
			});
			if (this.#shouldStop(request)) return undefined;

			const parsed = parseGeneratedRule(replyText);
			if ("error" in parsed) {
				const failedRule = extractGeneratedRuleJson(replyText) ?? replyText.trim();
				failedAttempts.push(
					`Attempt ${attempt} failed: invalid rule (${parsed.error}).\nFailed candidate:\n${failedRule}`,
				);
				previousRule = failedRule;
				request.component.setStatus(
					"validating",
					t("overlays.omfg_controller.attempt", {
						part1: `${attempt}`,
						part2: `${MAX_ATTEMPTS}`,
						part3: `${parsed.error}`,
					}),
				);
				continue;
			}

			request.component.setRule(parsed.fileContent);
			request.component.setStatus(
				"validating",
				t("overlays.omfg_controller.validating", { part1: `${attempt}`, part2: `${MAX_ATTEMPTS}` }),
			);
			const validated = await validateParsedRuleAgainstAssistantHistory(
				parsed,
				historyOutputs(this.ctx.session.messages, this.#inspector),
				parsed.rule.question !== undefined ? this.ctx.session.ruleJudge() : undefined,
			);
			if (this.#shouldStop(request)) return undefined;
			if (validated.repairedCondition) {
				request.component.setRule(validated.candidate.fileContent);
			}
			if (validated.validation.matched) {
				return { ...validated.candidate, validated: true };
			}
			// Regenerating cannot conjure a judge; let the user decide on this candidate.
			if (validated.validation.judgeUnavailable) {
				return { ...validated.candidate, validated: false };
			}

			lastCandidate = validated.candidate;
			const failure =
				validated.validation.feedback ?? "The rule condition did not match any earlier assistant output.";
			failedAttempts.push(
				`Attempt ${attempt} failed validation:\n${failure}\nFailed candidate:\n${validated.candidate.fileContent}`,
			);
			previousRule = validated.candidate.fileContent;
		}

		return lastCandidate ? { ...lastCandidate, validated: false } : undefined;
	}

	async #saveCandidate(request: OmfgRequest, candidate: OmfgCandidate): Promise<SaveCandidateResult> {
		if (this.#shouldStop(request)) return { kind: "aborted" };

		for (;;) {
			request.component.setStatus("saving", t("overlays.omfg_controller.select_action"));
			const location = await this.ctx.showHookSelector(
				t("overlays.omfg_controller.save_where"),
				[
					{ value: "project", label: t("overlays.omfg_controller.project") },
					{ value: "user", label: t("overlays.omfg_controller.global") },
					{ value: "amend", label: t("overlays.omfg_controller.amend") },
				],
				OMFG_DIALOG,
			);
			if (!this.#isActiveRequest(request)) return { kind: "aborted" };
			if (!location) {
				request.component.markAborted();
				this.#closeActiveRequest({ abort: false });
				return { kind: "aborted" };
			}

			if (location === "amend") {
				request.component.setStatus("confirming", t("overlays.omfg_controller.describe_amendment"));
				const amendment = await this.ctx.showHookInput(
					t("overlays.omfg_controller.amend_rule"),
					t("overlays.omfg_controller.amend_example"),
				);
				if (!this.#isActiveRequest(request)) return { kind: "aborted" };
				const feedback = amendment?.trim();
				if (!feedback) continue;
				return { kind: "amend", feedback };
			}

			const target = this.#resolveTarget(location === "user" ? "user" : "project", candidate.rule.name);
			if (await Bun.file(target.filePath).exists()) {
				const shouldOverwrite = await this.ctx.showHookConfirm(
					t("overlays.omfg_controller.overwrite"),
					t("overlays.omfg_controller.overwrite_detail", { part1: `${shortenPath(target.filePath)}` }),
					OMFG_DIALOG,
				);
				if (!this.#isActiveRequest(request)) return { kind: "aborted" };
				if (!shouldOverwrite) {
					request.component.markRejected();
					return { kind: "rejected" };
				}
			}

			request.component.setStatus(
				"saving",
				t("overlays.omfg_controller.saving", { part1: `${candidate.rule.name}` }),
			);
			await Bun.write(target.filePath, candidate.fileContent);
			// Drop the cached directory snapshot the discovery layer reads, so the next
			// session-scoped rebuild's rule rediscovery observes this new file instead of
			// a stale listing that would make `replaceTtsrRules` evict the live rule
			// registered below (issue #10940 review). Invalidating the file clears its
			// parent (rules dir); invalidating that dir clears its parent (the config dir)
			// so a first-ever rule in a freshly created `.omp/rules` is still discovered.
			invalidateCapabilityCache(target.filePath);
			invalidateCapabilityCache(path.dirname(target.filePath));
			if (!this.#isActiveRequest(request)) return { kind: "aborted" };

			const savedRule = buildOmfgRuleForPath(
				candidate.rule.name,
				candidate.fileContent,
				target.filePath,
				target.level,
			);
			this.#registerLive(savedRule);
			request.component.markSaved(shortenPath(target.filePath));
			return { kind: "saved" };
		}
	}

	#resolveTarget(level: OmfgRuleSourceLevel, ruleName: string): { filePath: string; level: OmfgRuleSourceLevel } {
		if (level === "user") {
			return {
				filePath: path.join(this.ctx.settings.getAgentDir(), "rules", `${ruleName}.md`),
				level: "user",
			};
		}
		return {
			filePath: path.join(this.ctx.sessionManager.getCwd(), CONFIG_DIR_NAME, "rules", `${ruleName}.md`),
			level: "project",
		};
	}

	#registerLive(rule: Rule): void {
		this.ctx.session.ttsrManager?.addRule(rule);
	}

	#closeActiveRequest(options: { abort: boolean }): void {
		const request = this.#activeRequest;
		if (!request) return;
		this.#activeRequest = undefined;
		if (options.abort) {
			request.abortController.abort();
		}
		request.component.close();
		this.ctx.omfgContainer.clear();
		this.ctx.ui.requestRender();
	}

	#isActiveRequest(request: OmfgRequest): boolean {
		return this.#activeRequest === request;
	}

	#shouldStop(request: OmfgRequest): boolean {
		return !this.#isActiveRequest(request) || request.abortController.signal.aborted;
	}
}
