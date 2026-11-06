/**
 * Routine options: concurrency, budget caps, timezone, tags, declared
 * state keys. Lives under the editor's "Options" tab.
 */
import type { RoutineBudget, RoutineConcurrency, RoutineSpec } from "@npi-deck/protocol";

import { Field, NumInput, Select, TagInput, TextInput } from "./form-primitives";

interface Props {
	spec: RoutineSpec;
	onChange: (next: RoutineSpec) => void;
	errors?: Readonly<Record<string, string>>;
}

const CONCURRENCY_OPTIONS: ReadonlyArray<{ value: RoutineConcurrency; label: string; help: string }> = [
	{ value: "skip", label: "Skip", help: "Drop new fires while a run is in flight." },
	{ value: "queue", label: "Queue", help: "Queue new fires; run them after the current one." },
	{ value: "cancel-previous", label: "Cancel the previous run", help: "Stop the in-flight run and start the new one." },
	{ value: "parallel", label: "Run in parallel", help: "Runs overlap. Costs add up." },
];

export function SettingsForm({ spec, onChange, errors }: Props) {
	function patchSpec(p: Partial<RoutineSpec>): void {
		onChange({ ...spec, ...p });
	}
	function patchBudget(p: Partial<RoutineBudget>): void {
		const next: RoutineBudget = { ...(spec.budget ?? {}), ...p };
		// Drop empty keys so the TOML output stays clean.
		const cleaned: RoutineBudget = {};
		for (const [k, v] of Object.entries(next)) {
			if (v !== undefined && v !== null) (cleaned as Record<string, unknown>)[k] = v;
		}
		if (Object.keys(cleaned).length === 0) {
			const without = { ...spec };
			delete without.budget;
			onChange(without);
		} else {
			patchSpec({ budget: cleaned });
		}
	}
	const concurrency = spec.concurrency ?? "skip";
	return (
		<div className="space-y-4">
			<Field label="Name" error={errors?.name}>
				<TextInput value={spec.name} onChange={(v) => patchSpec({ name: v })} placeholder="morning-briefing" mono />
			</Field>
			<Field label="Description" optional error={errors?.description}>
				<TextInput
					value={spec.description ?? ""}
					onChange={(v) => {
						const next = { ...spec };
						if (v.trim() === "") delete next.description;
						else next.description = v;
						onChange(next);
					}}
					placeholder="What this routine does"
				/>
			</Field>
			<Field label="If it fires while already running" help={CONCURRENCY_OPTIONS.find((o) => o.value === concurrency)?.help} error={errors?.concurrency}>
				<Select value={concurrency} onChange={(v) => patchSpec({ concurrency: v })} options={CONCURRENCY_OPTIONS} />
			</Field>
			<div className="grid grid-cols-2 gap-4">
				<Field label="Timezone" optional help="IANA name, for schedules." error={errors?.timezone}>
					<TextInput
						value={spec.timezone ?? ""}
						onChange={(v) => {
							const next = { ...spec };
							if (v.trim() === "") delete next.timezone;
							else next.timezone = v;
							onChange(next);
						}}
						placeholder="America/Sao_Paulo"
						mono
					/>
				</Field>
				<Field label="Tags" optional>
					<TagInput
						values={spec.tags ?? []}
						onChange={(v) => {
							const next = { ...spec };
							if (v.length === 0) delete next.tags;
							else next.tags = v;
							onChange(next);
						}}
						placeholder="daily, inbox"
					/>
				</Field>
			</div>
			<section className="space-y-3 border-t border-[var(--neo-line-1)] pt-4">
				<div>
					<h3 className="text-[13px] font-medium text-ink">Budget</h3>
					<p className="text-[12px] text-ink-3">A run stops when it crosses any of these. Empty means no cap.</p>
				</div>
				<div className="grid grid-cols-2 gap-4 md:grid-cols-3">
					<Field label="Max duration" help="Seconds.">
						<NumInput value={spec.budget?.max_duration_secs} onChange={(v) => patchBudget({ max_duration_secs: v })} placeholder="180" />
					</Field>
					<Field label="Max cost" help="US dollars across all model calls.">
						<NumInput value={spec.budget?.max_llm_cost_usd} onChange={(v) => patchBudget({ max_llm_cost_usd: v })} placeholder="0.05" />
					</Field>
					<Field label="Max steps">
						<NumInput value={spec.budget?.max_steps_executed} onChange={(v) => patchBudget({ max_steps_executed: v })} placeholder="20" />
					</Field>
					<Field label="Max input tokens">
						<NumInput value={spec.budget?.max_llm_tokens_input} onChange={(v) => patchBudget({ max_llm_tokens_input: v })} placeholder="50000" />
					</Field>
					<Field label="Max output tokens">
						<NumInput value={spec.budget?.max_llm_tokens_output} onChange={(v) => patchBudget({ max_llm_tokens_output: v })} placeholder="8000" />
					</Field>
				</div>
			</section>
			<Field label="State keys this routine uses" optional help="Informational; helps readers of the source know what the routine remembers.">
				<TagInput
					values={spec.state?.declared_keys ?? []}
					onChange={(v) => {
						const next = { ...spec };
						if (v.length === 0) {
							if (next.state) {
								const stateNext = { ...next.state };
								delete stateNext.declared_keys;
								if (Object.keys(stateNext).length === 0) delete next.state;
								else next.state = stateNext;
							}
						} else {
							next.state = { ...(next.state ?? {}), declared_keys: v };
						}
						onChange(next);
					}}
					placeholder="last_run_date"
				/>
			</Field>
		</div>
	);
}
