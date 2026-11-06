/**
 * Custom React Flow node for a single `RoutineStep`.
 *
 * A node is a small card that answers three questions at a glance: what is
 * this step called (its id, as words), what kind of action is it (icon and
 * action label), and what does it do (the prompt, the command, the URL, the
 * path). The footer appears only when there is something to say: a problem
 * to fix, a `when` gate, or the result of the last run.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CircleAlert, GitBranch } from "lucide-react";
import { memo } from "react";

import type { RoutineStep, RoutineStepRun } from "@npi-deck/protocol";

import type { StepNode as StepNodeType } from "../legacy-graph-types";
import { actionLabel, STEP_ICON, stepIconTone, stepTitle } from "../../step-form-render";
import { cardBodyParts } from "../../../../lib/card-frontmatter";

interface Summary {
	text: string;
	mono: boolean;
}

/** What the step does, in one to three lines. Empty text means "nothing yet". */
export function summarizeStep(step: RoutineStep): Summary {
	switch (step.type) {
		case "agent":
			return { text: step.prompt.trim(), mono: false };
		case "http":
			return { text: step.url ? `${step.method} ${step.url}` : "", mono: true };
		case "write":
			return { text: step.path, mono: true };
		case "run":
			return { text: step.command.trim(), mono: true };
		case "deck": {
			if ("title" in step && step.title) return { text: step.title, mono: false };
			if ("task_ref" in step && step.task_ref) return { text: `Card ${step.task_ref}`, mono: false };
			if ("inbox_ref" in step && step.inbox_ref) return { text: `Inbox item ${step.inbox_ref}`, mono: false };
			if ("path" in step && step.path) return { text: step.path, mono: true };
			if (step.action === "list_tasks") return { text: step.state_ref ? `Cards in ${step.state_ref}` : "All cards", mono: false };
			if (step.action === "list_inbox") return { text: step.kind ? `${step.kind} items` : "All inbox items", mono: false };
			return { text: "", mono: false };
		}
		case "mcp":
			return { text: step.server || step.tool ? `${step.server}.${step.tool}` : "", mono: true };
		case "transform":
			return { text: step.body.trim(), mono: true };
		case "wait":
			return { text: `Wait ${step.duration_secs} s`, mono: false };
		case "set_state": {
			const keys = Object.keys(step.state ?? {});
			return { text: keys.length ? keys.join(", ") : "", mono: true };
		}
		default:
			return { text: "", mono: false };
	}
}

/** Card bodies carry frontmatter; the node shows the prose part only. */
function stripFrontmatter(text: string): string {
	try {
		return cardBodyParts(text).content;
	} catch {
		return text;
	}
}

export const StepNode = memo(function StepNode({
	data,
	selected,
}: NodeProps<StepNodeType>) {
	const { step, compileError, fieldErrors, isIfNode, stepRun } = data;
	const summary = summarizeStep(step);
	const summaryText = summary.mono ? summary.text : stripFrontmatter(summary.text);
	const Icon = STEP_ICON[step.type];
	const problem = compileError ?? firstFieldProblem(fieldErrors);

	return (
		<div
			className="neo-node"
			data-kind="step"
			data-selected={selected ? "true" : undefined}
			data-problem={problem ? "true" : undefined}
			data-run={!problem && stepRun ? stepRun.status : undefined}
			data-step-id={step.id}
			data-status={stepRun?.status ?? "none"}
			title={problem ?? undefined}
		>
			<Handle type="target" position={Position.Top} />
			<div className="neo-node-head">
				<span className="neo-node-icon" data-tone={stepIconTone(step)}>
					<Icon size={14} />
				</span>
				<div className="neo-node-titles">
					<div className="neo-node-title">{stepTitle(step)}</div>
					<div className="neo-node-kicker">{actionLabel(step)}</div>
				</div>
				{stepRun && !problem ? <span className="neo-dot" data-tone={runTone(stepRun)} data-pulse={stepRun.status === "running" || undefined} aria-label={`status: ${stepRun.status}`} /> : null}
			</div>
			<div className="neo-node-body" data-mono={summary.mono || undefined} data-empty={summaryText ? undefined : "true"}>
				{summaryText || "Nothing here yet. Select the step to fill it in."}
			</div>
			{problem ? (
				<div className="neo-node-foot" data-tone="bad">
					<CircleAlert size={12} />
					<span>{problem}</span>
				</div>
			) : null}
			{!problem && step.when ? (
				<div className="neo-node-foot" title={step.when}>
					<GitBranch size={12} />
					<span className="truncate">Only when <span className="neo-mono">{step.when}</span></span>
				</div>
			) : null}
			{stepRun && !problem ? <RunFootline run={stepRun} /> : null}
			{isIfNode ? (
				<>
					<div className="neo-node-branches">
						<span className="text-success">true ↓</span>
						<span className="text-danger">↓ false</span>
					</div>
					<Handle id="true" type="source" position={Position.Bottom} style={{ left: "30%" }} />
					<Handle id="false" type="source" position={Position.Bottom} style={{ left: "70%" }} />
				</>
			) : (
				<Handle type="source" position={Position.Bottom} />
			)}
		</div>
	);
});

function firstFieldProblem(errors: Readonly<Record<string, string>> | undefined): string | undefined {
	if (!errors) return undefined;
	const [field, message] = Object.entries(errors)[0] ?? [];
	if (!field || !message) return undefined;
	return `${FIELD_WORDS[field] ?? field}: ${message.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())}`;
}

/** Field names as the forms label them, so the node and the inspector agree. */
const FIELD_WORDS: Record<string, string> = {
	id: "Name",
	prompt: "Prompt",
	command: "Command",
	path: "Path",
	content: "Content",
	url: "URL",
	method: "Method",
	server: "Server",
	tool: "Tool",
	body: "Body",
	title: "Title",
	duration_secs: "Duration",
	state: "Values",
	action: "Action",
	when: "Run only when",
};

function runTone(run: RoutineStepRun): "ok" | "live" | "warn" | "bad" | "accent" | undefined {
	switch (run.status) {
		case "success":
			return "ok";
		case "running":
			return "accent";
		case "failed":
			return "bad";
		case "aborted":
			return "warn";
		default:
			return undefined;
	}
}

/**
 * Bottom info strip with run telemetry. Only fields that have a value are
 * rendered so successful no-cost steps (e.g. `set_state`) don't get a noisy
 * footer of dashes.
 */
function RunFootline({ run }: { run: RoutineStepRun }): JSX.Element | null {
	const tokensTotal = (run.llmTokensIn ?? 0) + (run.llmTokensOut ?? 0);
	const costUsd =
		run.llmCostMicros != null ? run.llmCostMicros / 1_000_000 : null;
	const parts: string[] = [STATUS_WORDS[run.status] ?? run.status];
	if (run.durationMs != null) parts.push(formatDur(run.durationMs));
	if (run.model) parts.push(run.model);
	if (tokensTotal > 0) parts.push(`${tokensTotal.toLocaleString()} tokens`);
	if (costUsd != null && costUsd > 0) parts.push(`$${costUsd.toFixed(3)}`);
	return (
		<div className="neo-node-foot">
			<span className="neo-mono truncate">{parts.join(" · ")}</span>
		</div>
	);
}

const STATUS_WORDS: Record<string, string> = {
	pending: "Waiting",
	running: "Running",
	success: "Ran",
	skipped: "Skipped",
	failed: "Failed",
	aborted: "Stopped",
};

function formatDur(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rem = Math.round(s - m * 60);
	return `${m}m${rem}s`;
}
