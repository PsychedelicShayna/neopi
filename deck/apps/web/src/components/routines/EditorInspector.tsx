import { useEffect, useState } from "react";
import { Power, RefreshCcw, Trash2, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import type { Routine, RoutineRun } from "@npi-deck/protocol";

import { routinesApi, type RoutineMetrics } from "@/lib/routines-api";

interface Props {
	routine: Routine | undefined;
	onChange: (updated: Routine) => void;
	onDeleted: (id: string) => void;
	onError: (msg: string) => void;
}

export function EditorInspector({ routine, onChange, onDeleted, onError }: Props) {
	const [runs, setRuns] = useState<RoutineRun[]>([]);
	const [metrics, setMetrics] = useState<RoutineMetrics | undefined>();
	const [busy, setBusy] = useState<string | undefined>();

	useEffect(() => {
		if (!routine) {
			setRuns([]);
			setMetrics(undefined);
			return;
		}
		const routineId = routine.id;
		let cancelled = false;
		async function load(): Promise<void> {
			try {
				const [runRes, metricsRes] = await Promise.all([
					routinesApi.runs(routineId, 10),
					routinesApi.metrics(routineId),
				]);
				if (cancelled) return;
				setRuns(runRes.runs);
				setMetrics(metricsRes);
			} catch (e) {
				if (!cancelled) onError(String(e));
			}
		}
		void load();
		return () => {
			cancelled = true;
		};
	}, [routine, onError]);

	async function refresh(): Promise<void> {
		if (!routine) return;
		setBusy("refresh");
		try {
			const [runRes, metricsRes] = await Promise.all([
				routinesApi.runs(routine.id, 10),
				routinesApi.metrics(routine.id),
			]);
			setRuns(runRes.runs);
			setMetrics(metricsRes);
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(undefined);
		}
	}

	async function runNow(): Promise<void> {
		if (!routine) return;
		if (routine.specImportError) {
			onError(routine.specImportError);
			return;
		}
		setBusy("run");
		try {
			await routinesApi.runNow(routine.id);
			await new Promise(r => setTimeout(r, 800));
			await refresh();
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(undefined);
		}
	}

	async function toggle(): Promise<void> {
		if (!routine) return;
		setBusy("toggle");
		try {
			const updated = await routinesApi.update(routine.id, { enabled: !routine.enabled });
			onChange(updated);
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(undefined);
		}
	}

	async function remove(): Promise<void> {
		if (!routine) return;
		if (!confirm(`Delete routine "${routine.name}"?`)) return;
		setBusy("delete");
		try {
			await routinesApi.remove(routine.id);
			onDeleted(routine.id);
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(undefined);
		}
	}

	if (!routine) {
		return (
			<div className="p-4">
				<div className="text-[12px] font-medium text-ink-3">This routine</div>
				<p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
					Save it to see run history, quick actions and a success rate here.
				</p>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-y-auto">
			<section className="border-b border-[var(--neo-line-1)] p-4">
				<h3 className="mb-2 text-[12px] font-medium text-ink-3">Status</h3>
				{routine.specImportError ? (
					<p role="alert" className="mb-2 text-[12px] text-danger">
						{routine.specImportError}
					</p>
				) : null}
				<dl className="space-y-1.5 text-[13px]">
					<div className="flex items-center justify-between gap-2">
						<dt className="text-ink-2">Enabled</dt>
						<dd>
							<span className="neo-badge" data-tone={routine.enabled ? "ok" : undefined}>
								{routine.enabled ? "on" : "off"}
							</span>
						</dd>
					</div>
					{routine.nextRunAt ? (
						<div className="flex items-center justify-between gap-2">
							<dt className="text-ink-2">Next run</dt>
							<dd className="neo-mono text-[12px] text-ink-3">{new Date(routine.nextRunAt).toLocaleString()}</dd>
						</div>
					) : null}
					{metrics ? (
						<div className="flex items-center justify-between gap-2">
							<dt className="text-ink-2">Success, 30 days</dt>
							<dd className="neo-mono text-[12px] text-ink-3">{Math.round(metrics.successRate30d * 100)}%</dd>
						</div>
					) : null}
				</dl>
			</section>

			<section className="border-b border-[var(--neo-line-1)] p-4">
				<div className="mb-2 flex items-center justify-between">
					<h3 className="text-[12px] font-medium text-ink-3">Recent runs</h3>
					<button
						type="button"
						onClick={() => void refresh()}
						disabled={busy === "refresh"}
						className="neo-btn"
						data-variant="ghost"
						data-size="sm"
						data-icon="true"
						aria-label="Refresh runs"
					>
						<RefreshCcw size={13} />
					</button>
				</div>
				<ul className="space-y-0.5">
					{runs.length === 0 ? (
						<li className="text-[12.5px] text-ink-3">No runs yet.</li>
					) : (
						runs.map(run => <RunMini key={run.id} routineId={routine.id} run={run} />)
					)}
				</ul>
			</section>

			<section className="border-b border-[var(--neo-line-1)] p-4">
				<h3 className="mb-2 text-[12px] font-medium text-ink-3">Actions</h3>
				<div className="space-y-1">
					<button
						type="button"
						onClick={() => void runNow()}
						disabled={busy === "run" || !!routine.specImportError}
						className="neo-btn w-full justify-start"
						data-variant="ghost"
						data-size="sm"
					>
						<Zap size={13} />
						Run now
					</button>
					<button
						type="button"
						onClick={() => void toggle()}
						disabled={busy === "toggle"}
						className="neo-btn w-full justify-start"
						data-variant="ghost"
						data-size="sm"
					>
						<Power size={13} />
						{routine.enabled ? "Disable" : "Enable"}
					</button>
					<button
						type="button"
						onClick={() => void remove()}
						disabled={busy === "delete"}
						className="neo-btn w-full justify-start text-danger"
						data-variant="ghost"
						data-size="sm"
					>
						<Trash2 size={13} />
						Delete
					</button>
				</div>
			</section>

			<details className="p-4">
				<summary className="cursor-pointer text-[12.5px] text-ink-3">Template reference</summary>
				<div className="neo-mono mt-2 space-y-1 text-[11.5px] text-ink-3">
					<div>
						{"{{ run.date }}"} · {"{{ steps.<name>.json }}"} · {"{{ steps.<name>.stdout }}"} ·{" "}
						{"{{ state.<key> }}"}
					</div>
				</div>
			</details>
		</div>
	);
}

function RunMini({ routineId, run }: { routineId: string; run: RoutineRun }) {
	const ok = !run.error && !run.abortReason;
	const running = !run.endedAt && !run.abortedAt;
	return (
		<li>
			<Link
				to={`/legacy/routines/${encodeURIComponent(routineId)}/runs/${encodeURIComponent(run.id)}`}
				className="flex items-center gap-2 rounded-[var(--r-chip)] px-1.5 py-1 text-[12px] hover:bg-[var(--neo-hover)]"
			>
				<span
					className="neo-dot"
					data-tone={running ? "accent" : ok ? "ok" : "bad"}
					data-pulse={running || undefined}
				/>
				<span className="neo-mono text-ink-3">
					{new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
				</span>
				<span className="text-ink-4">{run.trigger}</span>
				{run.abortReason ? <span className="ml-auto text-warn">{run.abortReason}</span> : null}
			</Link>
		</li>
	);
}
