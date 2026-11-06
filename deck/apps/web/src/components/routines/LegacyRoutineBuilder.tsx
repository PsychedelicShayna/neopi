/** Canvas-first authoring with deliberate advanced controls and source access. */
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { CircleAlert, Play, Save } from "lucide-react";

import {
	validateRoutineSpec,
	type Routine,
	type RoutineDeckAction,
	type RoutineRun,
	type RoutineSpec,
	type RoutineStep,
	type RoutineTrigger,
	type ValidationError,
} from "@npi-deck/protocol";

import { routinesApi } from "@/lib/routines-api";
import { formatDurationMs } from "@/lib/utils";

import { compileGraph } from "./canvas/graph-compile";
import { LegacyRoutineCanvas, type CanvasSelectRequest } from "./canvas/LegacyRoutineCanvas";
import { SavePreviewDialog, shouldSkipSavePreview } from "./canvas/SavePreviewDialog";
import { useRunOverlay } from "./canvas/use-run-overlay";
import { AddStepPicker } from "./AddStepPicker";
import { Field, Select, TextArea, TextInput } from "./form-primitives";
import { stepTitle } from "./step-form-render";
import { SettingsForm } from "./SettingsForm";
import { StepCard } from "./StepCard";
import { TriggerPicker } from "./TriggerPicker";
import { WebhookSecretPanel } from "./WebhookSecretPanel";
import {
	appendStepRenderKey,
	makeStepRenderKeys,
	moveStepRenderKey,
	reconcileStepRenderKeys,
	removeStepRenderKey,
} from "./step-render-keys";
import {
	fieldErrorsForSpec,
	type RoutineFieldErrors,
	summarizeRoutineValidationErrors,
} from "./routine-validation";
import {
	emptyV1Spec,
	insertStep,
	moveStep,
	parseSpec,
	removeStep,
	replaceStep,
	replaceTriggers,
	scaffoldStep,
	stringifySpec,
} from "./spec-toml";

import type { RoutineBuilderProps } from "./RoutineBuilder";

type Tab = "steps" | "canvas" | "triggers" | "settings" | "spec";

export function LegacyRoutineBuilder({ routine, onSaved, onError, embedded, view, editorRef, onStateChange }: RoutineBuilderProps) {
	const legacy = routine?.specVersion === 0;
	const initialSpec = useMemo<RoutineSpec>(() => {
		if (routine?.specVersion === 0) {
			return {
				name: routine.name,
				description: routine.description,
				trigger: routine.cron ? [{ cron: routine.cron }] : [{ manual: {} }],
				steps: [routine.actionKind === "prompt"
					? { id: "action", type: "agent", prompt: routine.actionBody }
					: { id: "action", type: "run", command: routine.actionBody, cwd: routine.actionCwd }],
			};
		}
		if (routine?.specToml) {
			const parsed = parseSpec(routine.specToml);
			if (parsed.ok && parsed.spec) return parsed.spec;
		}
		return emptyV1Spec();
	}, [routine]);

	const stepKeySeq = useRef(0);
	function nextStepKey(): string {
		const n = stepKeySeq.current;
		stepKeySeq.current += 1;
		return `step-${n}`;
	}
	function makeStepKeys(count: number): string[] {
		return makeStepRenderKeys(count, nextStepKey);
	}
	function reconcileStepKeys(next: RoutineSpec): void {
		setStepKeys((prev) => reconcileStepRenderKeys(prev, next.steps.length, nextStepKey));
	}

	const [spec, setSpec] = useState<RoutineSpec>(initialSpec);
	const persistedSpec = useRef(initialSpec);
	const [stepKeys, setStepKeys] = useState<string[]>(() => makeStepKeys(initialSpec.steps.length));
	const [tomlBuffer, setTomlBuffer] = useState<string>(() =>
		routine?.specToml ?? stringifySpec(initialSpec),
	);
	const [tomlDirty, setTomlDirty] = useState(false);
	const [tomlError, setTomlError] = useState<string | undefined>();
	const [schemaErrors, setSchemaErrors] = useState<ValidationError[] | undefined>();
	const [tab, setTab] = useState<Tab>("canvas");
	const [advanced, setAdvanced] = useState(false);
	const [legacyCwd, setLegacyCwd] = useState(routine?.actionCwd ?? "");
	const [legacyKind, setLegacyKind] = useState(routine?.actionKind ?? "bash");
	const [busy, setBusy] = useState(false);
	const [enabled, setEnabled] = useState<boolean>(routine?.enabled ?? false);
	const [runs, setRuns] = useState<RoutineRun[]>([]);
	const [showRuns, setShowRuns] = useState(false);
	const [selectRequest, setSelectRequest] = useState<CanvasSelectRequest | null>(null);
	// Pre-save diff preview state. When non-null, the SavePreviewDialog is
	// open and the contained `specToSave` + `specToml` are what will be PATCHed
	// or POSTed when the user confirms. Cancelling clears this back to null.
	const [pendingSave, setPendingSave] = useState<{
		specToSave: RoutineSpec;
		specToml: string;
	} | null>(null);

	// When the parent passes a different routine, reset everything.
	const lastRoutineId = useRef<string | undefined>(routine?.id);
	useEffect(() => {
		if (lastRoutineId.current === routine?.id) return;
		lastRoutineId.current = routine?.id;
		setStepKeys(makeStepKeys(initialSpec.steps.length));
		setSpec(initialSpec);
		persistedSpec.current = initialSpec;
		setTomlBuffer(routine?.specToml ?? stringifySpec(initialSpec));
		setTomlDirty(false);
		setTomlError(undefined);
		setSchemaErrors(undefined);
		setEnabled(routine?.enabled ?? false);
		setTab("canvas");
		setAdvanced(false);
		setLegacyCwd(routine?.actionCwd ?? "");
		setLegacyKind(routine?.actionKind ?? "bash");
	}, [routine, initialSpec]);
	useEffect(() => {
		if (routine) setEnabled(routine.enabled);
	}, [routine?.enabled]);
	useEffect(() => {
		if (embedded && view) switchTab(view === "source" ? "spec" : "canvas");
	}, [embedded, view]);

	useEffect(() => {
		if (!routine) return;
		void routinesApi.runs(routine.id, 10).then((r) => setRuns(r.runs));
	}, [routine]);

	// Form -> TOML sync. Step cards use render-only keys that are deliberately
	// separate from editable step ids; otherwise changing `id` remounts the
	// active input and drops focus after every character.
	function updateSpec(next: RoutineSpec, nextStepKeys?: string[]): void {
		if (legacy && next.steps[0]?.type === "run") setLegacyCwd(next.steps[0].cwd ?? "");
		if (nextStepKeys) setStepKeys(nextStepKeys);
		else reconcileStepKeys(next);
		setSpec(next);
		setTomlBuffer(stringifySpec(next, tomlBuffer));
		setTomlDirty(false);
		setTomlError(undefined);
		setSchemaErrors(undefined);
	}
	// TOML -> form sync: the textarea onChange just tracks the buffer; we
	// re-parse when the user clicks "Apply", switches tab or saves.
	function applyToml(): RoutineSpec | undefined {
		const result = parseSpec(tomlBuffer);
		if (!result.ok) {
			if (result.tomlError) setTomlError(`${result.tomlError.message}${result.tomlError.line ? ` (line ${result.tomlError.line})` : ""}`);
			else setTomlError(undefined);
			if (result.schemaErrors) setSchemaErrors(result.schemaErrors);
			else setSchemaErrors(undefined);
			return undefined;
		}
		const nextSpec = result.spec ?? emptyV1Spec();
		setStepKeys(makeStepKeys(nextSpec.steps.length));
		setSpec(nextSpec);
		setTomlDirty(false);
		setTomlError(undefined);
		setSchemaErrors(undefined);
		return nextSpec;
	}

	function switchTab(next: Tab): void {
		// If leaving the source tab with unapplied TOML, try to apply it first;
		// if invalid, stay on the source tab so the problem is visible.
		if (tab === "spec" && tomlDirty && next !== "spec") {
			const ok = applyToml();
			if (!ok) return;
		}
		setTab(next);
	}

	function toggleAdvanced(): void {
		if (advanced) {
			if (tab === "spec" && tomlDirty && !applyToml()) return;
			setTab("canvas");
		}
		setAdvanced((value) => !value);
	}

	const specValidation = useMemo(() => validateRoutineSpec(spec), [spec]);
	const fieldErrors = useMemo<RoutineFieldErrors>(
		() => legacy ? { top: {}, steps: new Map(), count: 0 } : fieldErrorsForSpec(specValidation.errors, spec),
		[specValidation.errors, spec, legacy],
	);
	// Compile the canvas graph on every spec change. In the linear short-circuit
	// path (no `layout.edges`), this is the identity function; it only does work
	// when the user has wired explicit edges via the canvas. Errors gate Save
	// and feed the canvas's node marks + pill.
	const compile = useMemo(() => legacy ? { steps: spec.steps, errors: [] } : compileGraph(spec), [spec, legacy]);

	// Run-status overlay state. Shared between the canvas (node marks + last-
	// run picker) and the inspector (per-step output preview).
	const runOverlay = useRunOverlay(routine?.id);

	async function save(): Promise<void> {
		if (legacy) {
			await commitSave(spec, "");
			return;
		}
		const currentSpec = tomlDirty ? applyToml() : spec;
		if (!currentSpec) {
			onError("The source has problems. Fix them before saving.");
			return;
		}
		const validation = validateRoutineSpec(currentSpec);
		if (!validation.valid) {
			onError(`Cannot save: ${summarizeRoutineValidationErrors(validation.errors, currentSpec)[0]?.message ?? "Routine is invalid"}`);
			return;
		}
		// An untouched loaded routine keeps its exact authored source and step
		// order; opening the canvas is not an implicit migration or graph edit.
		if (routine?.specToml && !tomlDirty && currentSpec === persistedSpec.current) {
			await commitSave(currentSpec, routine.specToml);
			return;
		}
		const finalCompile = compileGraph(currentSpec);
		if (finalCompile.errors.length > 0) {
			const first = finalCompile.errors[0]!;
			onError(`Cannot save: ${first.message}${finalCompile.errors.length > 1 ? ` (+${finalCompile.errors.length - 1} more)` : ""}`);
			return;
		}
		// Apply the topo-sorted step order so the runtime engine walks the graph
		// the user drew. No-op when compile was the identity.
		const specToSave: RoutineSpec = finalCompile.steps === currentSpec.steps
			? currentSpec
			: { ...currentSpec, steps: finalCompile.steps };
		const specToml = stringifySpec(specToSave, tomlBuffer);

		// Source review is optional, never part of the normal create/save path.
		const previewable =
			tab === "spec" &&
			!embedded &&
			!legacy &&
			!shouldSkipSavePreview() &&
			specToml !== (routine?.specToml ?? "");
		if (previewable) {
			setPendingSave({ specToSave, specToml });
			return;
		}
		await commitSave(specToSave, specToml);
	}

	async function commitSave(specToSave: RoutineSpec, specToml: string): Promise<void> {
		setBusy(true);
		try {
			if (routine && legacy) {
				const action = specToSave.steps[0]!;
				const cron = specToSave.trigger.find((trigger) => "cron" in trigger);
				const updated = await routinesApi.update(routine.id, {
					name: specToSave.name,
					description: specToSave.description ?? "",
					cron: cron && "cron" in cron ? cron.cron : "",
					actionKind: legacyKind,
					actionBody: action.type === "agent" ? action.prompt : action.type === "run" ? action.command : routine.actionBody,
					actionCwd: legacyCwd,
					enabled,
				});
				onSaved(updated);
			} else if (routine) {
				const updated = await routinesApi.update(routine.id, {
					name: specToSave.name,
					description: specToSave.description ?? "",
					specToml,
					enabled,
				});
				onSaved(updated);
			} else {
				const created = await routinesApi.create({
					name: specToSave.name,
					description: specToSave.description ?? "",
					enabled,
					specToml,
				});
				onSaved(created);
			}
			setPendingSave(null);
			persistedSpec.current = specToSave;
			setSpec(specToSave);
			setTomlBuffer(specToml || stringifySpec(specToSave));
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(false);
		}
	}

	async function runNow(): Promise<void> {
		if (!routine) return;
		try {
			await routinesApi.runNow(routine.id);
			await new Promise((r) => setTimeout(r, 600));
			const r = await routinesApi.runs(routine.id, 10);
			setRuns(r.runs);
			setShowRuns(true);
		} catch (e) {
			onError(String(e));
		}
	}

	// ─── Step helpers ───────────────────────────────────────────────────────

	const existingStepIds = spec.steps.map((s) => s.id);
	function onAddStep(type: RoutineStep["type"], presetAction?: RoutineDeckAction): void {
		updateSpec(
			insertStep(spec, scaffoldStep(type, existingStepIds, presetAction)),
			appendStepRenderKey(stepKeys, nextStepKey),
		);
	}
	function onChangeStep(index: number, next: RoutineStep): void {
		updateSpec(replaceStep(spec, index, next), stepKeys);
	}
	function onRemoveStep(index: number): void {
		updateSpec(removeStep(spec, index), removeStepRenderKey(stepKeys, index));
	}
	function onMoveUp(index: number): void {
		const target = Math.max(0, index - 1);
		updateSpec(moveStep(spec, index, target), moveStepRenderKey(stepKeys, index, target));
	}
	function onMoveDown(index: number): void {
		const target = Math.min(spec.steps.length - 1, index + 1);
		updateSpec(moveStep(spec, index, target), moveStepRenderKey(stepKeys, index, target));
	}
	function onChangeTriggers(triggers: RoutineTrigger[]): void {
		updateSpec(replaceTriggers(spec, triggers), stepKeys);
	}

	// ─── Render ────────────────────────────────────────────────────────────

	const legacyAction = spec.steps[0];
	const nameMissing = spec.name.trim().length === 0;
	const nameError = fieldErrors.top.name ?? (nameMissing ? "Give the routine a name." : undefined);
	const canSave =
		!nameMissing &&
		spec.trigger.length > 0 &&
		spec.steps.length > 0 &&
		(legacy
			? (legacyAction?.type === "agent"
				? legacyAction.prompt
				: legacyAction?.type === "run"
					? legacyAction.command
					: routine?.actionBody ?? "").trim().length > 0
			: specValidation.valid && fieldErrors.count === 0) &&
		compile.errors.length === 0 &&
		!busy;
	const dirty = tomlDirty || spec !== persistedSpec.current || (routine !== undefined && enabled !== routine.enabled);
	useImperativeHandle(editorRef, () => ({
		save,
		updateSpec,
		updateMetadata: (value) => updateSpec({ ...spec, ...value }),
	}));
	useEffect(() => {
		onStateChange?.({ name: spec.name, spec, dirty, canSave });
	}, [spec, dirty, canSave, onStateChange]);

	// What stands between the author and Save, with somewhere to click.
	const attention = useMemo(() => {
		if (legacy) return null;
		const items: Array<{ label: string; target?: string | "trigger" }> = [];
		for (const [stepId, fields] of fieldErrors.steps) {
			const step = spec.steps.find((s) => s.id === stepId);
			const title = step ? stepTitle(step) : stepId;
			items.push({ label: `${title}: ${Object.keys(fields).length === 1 ? "one field" : `${Object.keys(fields).length} fields`}`, target: stepId });
		}
		if (spec.trigger.length === 0 || fieldErrors.top.trigger) items.push({ label: "No trigger", target: "trigger" });
		for (const err of compile.errors) {
			const target = err.nodeIds[0];
			if (target) items.push({ label: err.message, target });
		}
		if (spec.steps.length === 0) items.push({ label: "No actions yet" });
		return items.length > 0 ? items : null;
	}, [fieldErrors, compile.errors, spec.steps, spec.trigger.length, legacy]);

	function showFirstProblem(): void {
		const first = attention?.[0];
		if (!first) return;
		if (tab !== "canvas") {
			// Leaving the source tab applies the buffer first; an invalid buffer
			// keeps the author on Source where the problem is shown.
			if (tab === "spec" && tomlDirty && !applyToml()) return;
			setTab("canvas");
		}
		if (!first.target) return;
		setSelectRequest({ target: first.target, seq: Date.now() });
	}

	return (
		<div
			className={
				// The canvas tab claims the full width so the graph + inspector can
				// spread out; the form tabs stay capped for readability.
				tab === "canvas"
					? "flex min-h-0 flex-1 flex-col overflow-hidden"
					: "mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col overflow-hidden"
			}
		>
			{!embedded ? <div className="flex shrink-0 flex-wrap items-start gap-3 px-1 pb-3">
				<div className="min-w-0 flex-1">
					<Field label="Name" error={nameError}>
						<TextInput value={spec.name} onChange={(v) => updateSpec({ ...spec, name: v })} placeholder="morning-briefing" mono ariaLabel="Routine name" />
					</Field>
				</div>
				<div className="pt-[22px]">
					<button type="button" aria-expanded={advanced} onClick={toggleAdvanced} className="neo-btn" data-variant="ghost" data-on={advanced || undefined}>
						{advanced ? "Hide advanced" : "Advanced"}
					</button>
				</div>
			</div> : null}
			{advanced || embedded ? <TabBar tab={tab} onChange={switchTab} stepCount={spec.steps.length} triggerCount={spec.trigger.length} legacy={legacy} /> : null}
			<div
				className={
					tab === "canvas"
						? "neo-card min-h-0 flex-1 overflow-hidden"
						: tab === "spec"
							? "flex min-h-0 flex-1 flex-col pt-3"
							: "min-h-0 flex-1 overflow-y-auto px-1 pt-4"
				}
			>
				{tab === "steps" ? (
					<div className="space-y-3">
						{spec.steps.length === 0 ? (
							<div className="neo-empty rounded-[var(--r-card)] border border-dashed border-[var(--neo-line-2)]">
								<div className="neo-empty-title">No steps yet</div>
								<div className="neo-empty-hint">Add one below; the canvas shows the same steps as a graph.</div>
							</div>
						) : (
							spec.steps.map((step, idx) => (
								<StepCard
									key={`${routine?.id ?? "new"}-${stepKeys[idx] ?? idx}`}
									step={step}
									index={idx}
									total={spec.steps.length}
									existingIds={existingStepIds}
									errors={fieldErrors.steps.get(step.id)}
									onChange={(n) => onChangeStep(idx, n)}
									onRemove={() => onRemoveStep(idx)}
									onMoveUp={() => onMoveUp(idx)}
									onMoveDown={() => onMoveDown(idx)}
								/>
							))
						)}
						<AddStepPicker onAdd={onAddStep} />
					</div>
				) : null}

				{tab === "canvas" ? (
					<LegacyRoutineCanvas
						spec={spec}
						onChange={updateSpec}
						onChangeTriggers={legacy ? undefined : onChangeTriggers}
						compileErrors={compile.errors}
						fieldErrors={fieldErrors}
						selectRequest={selectRequest}
						routineId={routine?.id}
						runs={runOverlay.runs}
						selectedRunId={runOverlay.selectedRunId}
						onSelectRun={runOverlay.setSelectedRunId}
						stepRunsByStepId={runOverlay.stepRunsByStepId}
						advanced={advanced}
						allowAdd={!legacy}
						allowDelete={!legacy}
						allowConnect={!legacy}
					/>
				) : null}

				{tab === "triggers" ? (
					<TriggerPicker triggers={spec.trigger} onChange={onChangeTriggers} error={fieldErrors.top.trigger} />
				) : null}

				{tab === "settings" ? (
					<div className="space-y-4">
						{legacy ? (
							<div className="space-y-4">
								<Field label="Description" optional>
									<TextArea mono={false} ariaLabel="Routine description" value={spec.description ?? ""} onChange={(v) => updateSpec({ ...spec, description: v })} rows={3} />
								</Field>
								<Field label="Schedule" optional help="Cron expression; empty runs on demand.">
									<TextInput mono ariaLabel="Routine schedule" value={spec.trigger.flatMap((trigger) => "cron" in trigger ? [trigger.cron] : [])[0] ?? ""} onChange={(v) => updateSpec({ ...spec, trigger: v ? [{ cron: v }] : [{ manual: {} }] })} />
								</Field>
								<Field label="Action">
									<Select ariaLabel="Legacy action kind" value={legacyKind} onChange={(kind) => {
										const action = spec.steps[0]!;
										const body = action.type === "agent" ? action.prompt : action.type === "run" ? action.command : "";
										setLegacyKind(kind);
										updateSpec({ ...spec, steps: [kind === "prompt" ? { id: "action", type: "agent", prompt: body } : { id: "action", type: "run", command: body, cwd: action.type === "run" ? action.cwd : legacyCwd }] });
									}} options={[
										{ value: "bash", label: "Shell command" },
										{ value: "script", label: "Script" },
										{ value: "prompt", label: "Ask an agent" },
									]} />
								</Field>
								<Field label="Working directory" optional>
									<TextInput mono ariaLabel="Working directory" value={legacyCwd} onChange={(cwd) => {
										const action = spec.steps[0];
										if (action?.type === "run") updateSpec({ ...spec, steps: [{ ...action, cwd }] });
										else setLegacyCwd(cwd);
									}} />
								</Field>
							</div>
						) : <SettingsForm spec={spec} onChange={updateSpec} errors={fieldErrors.top} />}
						{routine && !legacy ? (
							<WebhookSecretPanel routineId={routine.id} refreshKey={routine.updatedAt} onError={onError} />
						) : null}
					</div>
				) : null}

				{tab === "spec" ? (
					<div className="neo-source">
						<div className="neo-source-bar">
							<span>Source</span>
							<span className="neo-mono text-ink-4">TOML</span>
							<span className="ml-auto">
								{tomlDirty ? <span className="neo-badge" data-tone="warn">Not applied yet</span> : <span className="text-ink-4">Matches the canvas</span>}
							</span>
							<button
								type="button"
								onClick={applyToml}
								disabled={!tomlDirty}
								className="neo-btn"
								data-size="sm"
							>
								Apply to canvas
							</button>
						</div>
						<textarea
							value={tomlBuffer}
							aria-label="Routine source"
							onChange={(e) => {
								setTomlBuffer(e.target.value);
								setTomlDirty(true);
							}}
							spellCheck={false}
						/>
						{tomlError || schemaErrors ? (
							<div className="neo-source-problems" role="alert">
								{tomlError ? <div>{tomlError}</div> : null}
								{schemaErrors?.slice(0, 6).map((e, idx) => (
									<div key={idx}>
										<span className="neo-mono">{e.path || "/"}</span>
										{e.message}
									</div>
								))}
							</div>
						) : null}
					</div>
				) : null}

				{routine && tab !== "canvas" && tab !== "spec" ? (
					<div className="mt-4 border-t border-[var(--neo-line-1)] pt-3">
						<button
							type="button"
							onClick={() => setShowRuns((s) => !s)}
							className="flex w-full items-center gap-1 text-left text-[12.5px] text-ink-3 hover:text-ink"
						>
							<span>Recent runs ({runs.length})</span>
							<span className="text-ink-4">{showRuns ? "▾" : "▸"}</span>
						</button>
						{showRuns ? <RunList routine={routine} runs={runs} /> : null}
					</div>
				) : null}
			</div>
			{!embedded ? <Footer
				routine={routine}
				canSave={canSave}
				busy={busy}
				dirty={dirty}
				enabled={enabled}
				setEnabled={setEnabled}
				attention={attention}
				onShowProblem={showFirstProblem}
				onSave={() => void save()}
				onRunNow={() => void runNow()}
			/> : null}
			{pendingSave ? (
				<SavePreviewDialog
					currentToml={routine?.specToml ?? ""}
					newToml={pendingSave.specToml}
					busy={busy}
					onCancel={() => {
						if (!busy) setPendingSave(null);
					}}
					onConfirm={() => {
						void commitSave(pendingSave.specToSave, pendingSave.specToml);
					}}
				/>
			) : null}
		</div>
	);
}

function TabBar({
	tab,
	onChange,
	stepCount,
	triggerCount,
	legacy,
}: {
	tab: Tab;
	onChange: (next: Tab) => void;
	stepCount: number;
	triggerCount: number;
	legacy: boolean;
}) {
	const tabs: ReadonlyArray<{ id: Tab; label: string; badge?: number }> = legacy
		? [{ id: "canvas", label: "Canvas" }, { id: "settings", label: "Options" }]
		: [
			{ id: "canvas", label: "Canvas" },
			{ id: "steps", label: "Steps", badge: stepCount },
			{ id: "triggers", label: "Triggers", badge: triggerCount },
			{ id: "settings", label: "Options" },
			{ id: "spec", label: "Source" },
		];
	return (
		<div className="neo-tabs mb-3 shrink-0">
			{tabs.map((t) => (
				<button
					key={t.id}
					type="button"
					onClick={() => onChange(t.id)}
					className="neo-tab"
					data-active={tab === t.id}
				>
					{t.label}
					{t.badge !== undefined ? <span className="neo-badge" data-mono="true">{t.badge}</span> : null}
				</button>
			))}
		</div>
	);
}

function Footer({
	routine,
	canSave,
	busy,
	dirty,
	enabled,
	setEnabled,
	attention,
	onShowProblem,
	onSave,
	onRunNow,
}: {
	routine: Routine | undefined;
	canSave: boolean;
	busy: boolean;
	dirty: boolean;
	enabled: boolean;
	setEnabled: (v: boolean) => void;
	attention: ReadonlyArray<{ label: string; target?: string }> | null;
	onShowProblem: () => void;
	onSave: () => void;
	onRunNow: () => void;
}) {
	return (
		<div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-[var(--neo-line-1)] px-1 pt-3" data-testid="routine-save-bar">
			<label className="neo-check">
				<input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
				<span>Enabled</span>
			</label>
			<div className="min-w-0 flex-1 text-[12.5px] text-ink-3">
				{attention ? (
					<button type="button" onClick={onShowProblem} className="inline-flex max-w-full items-center gap-1.5 text-left text-danger hover:underline" title={attention.map((a) => a.label).join("\n")}>
						<CircleAlert size={13} />
						<span className="truncate">
							{attention.length === 1 ? attention[0]!.label : `${attention.length} things need attention`}
						</span>
						{attention[0]!.target ? <span className="text-ink-3">· show me</span> : null}
					</button>
				) : dirty ? (
					<span>Unsaved changes</span>
				) : routine ? (
					<span>Saved</span>
				) : null}
			</div>
			<div className="flex items-center gap-2">
				{routine ? (
					<button type="button" onClick={onRunNow} className="neo-btn">
						<Play size={13} />
						Run now
					</button>
				) : null}
				<button
					type="button"
					onClick={onSave}
					disabled={!canSave}
					className="neo-btn"
					data-variant="primary"
				>
					<Save size={13} />
					{busy ? "Saving…" : routine ? "Save routine" : "Create routine"}
				</button>
			</div>
		</div>
	);
}

function RunList({ routine, runs }: { routine: Routine; runs: RoutineRun[] }) {
	return (
		<ul className="mt-2 space-y-1">
			{runs.length === 0 ? (
				<li className="text-[12.5px] text-ink-3">No runs yet.</li>
			) : (
				runs.map((r) => {
					const dur =
						r.endedAt && r.startedAt
							? new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime()
							: undefined;
					const ok = !r.error && !r.abortReason;
					return (
						<li key={r.id} className="flex items-center gap-2 text-[12.5px]">
							<span className="neo-dot" data-tone={r.endedAt || r.abortedAt ? (ok ? "ok" : "bad") : "accent"} />
							<span className="neo-mono text-ink-3">{new Date(r.startedAt).toLocaleString()}</span>
							<span className="text-ink-4">{r.trigger}</span>
							{dur !== undefined ? <span className="neo-mono text-ink-4">{formatDurationMs(dur)}</span> : null}
							{r.abortReason ? <span className="text-warn">{r.abortReason}</span> : null}
							<a
								href={`/legacy/routines/${encodeURIComponent(routine.id)}/runs/${encodeURIComponent(r.id)}`}
								className="ml-auto text-ink-3 underline-offset-2 hover:text-accent hover:underline"
							>
								detail
							</a>
						</li>
					);
				})
			)}
		</ul>
	);
}
