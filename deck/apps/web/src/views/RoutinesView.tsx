import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import type { Routine } from "@npi-deck/protocol";

import { Layout } from "@/components/Layout";
import { Dot, NeoButton } from "@/components/neo";
import { EditorInspector } from "@/components/routines/EditorInspector";
import { RoutineEditorPage } from "@/components/routines/RoutineEditorPage";
import { routinesApi } from "@/lib/routines-api";
import { cn } from "@/lib/utils";

export function RoutinesView() {
	const [params, setParams] = useSearchParams();
	const target = params.get("edit") ?? "new";
	const [routines, setRoutines] = useState<Routine[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string>();
	const refresh = useCallback(async () => {
		try {
			const result = await routinesApi.list();
			setRoutines(result.routines);
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		void refresh();
	}, [refresh]);

	function open(id: string): void {
		setParams(previous => {
			const next = new URLSearchParams(previous);
			next.set("edit", id);
			return next;
		});
	}
	function onSaved(saved: Routine): void {
		setRoutines(previous => [...previous.filter(routine => routine.id !== saved.id), saved]);
		if (target === "new") open(saved.id);
	}
	function onDeleted(id: string): void {
		setRoutines(previous => previous.filter(routine => routine.id !== id));
		open("new");
	}
	const selected = target === "new" ? "new" : routines.find(routine => routine.id === target);
	const sidebar = (
		<div className="flex h-full flex-col overflow-y-auto">
			<section className="px-3 pb-2 pt-4">
				<NeoButton
					variant="primary"
					className="w-full"
					onClick={() => open("new")}
					data-active={target === "new" || undefined}
				>
					<Plus size={14} />
					New routine
				</NeoButton>
			</section>
			<nav aria-label="Saved routines" className="px-2 py-2">
				<div className="neo-nav-heading">Saved</div>
				{loading ? <p className="px-2 py-1 text-[12.5px] text-ink-3">Loading routines…</p> : null}
				{!loading && routines.length === 0 ? (
					<p className="px-2 py-1 text-[12.5px] leading-relaxed text-ink-3">
						Nothing saved yet. The first one you create shows up here.
					</p>
				) : null}
				{routines
					.slice()
					.sort((a, b) => a.name.localeCompare(b.name))
					.map(routine => (
						<button
							key={routine.id}
							type="button"
							onClick={() => open(routine.id)}
							aria-current={target === routine.id ? "page" : undefined}
							className={cn(
								"neo-nav-row h-auto w-full items-start py-1.5 text-left",
								target === routine.id && "",
							)}
							data-active={target === routine.id}
						>
							<span className="mt-[5px]">
								<Dot tone={routine.enabled && !routine.specImportError ? "ok" : undefined} />
							</span>
							<span className="min-w-0 flex-1">
								<span className="neo-nav-row-label block truncate">{routine.name}</span>
								{routine.description ? (
									<span className="block truncate text-[11.5px] text-ink-3">{routine.description}</span>
								) : null}
								{routine.specImportError ? (
									<span className="block text-[11.5px] text-danger">Import unavailable</span>
								) : null}
							</span>
						</button>
					))}
			</nav>
		</div>
	);
	const main = (
		<div className="flex h-full min-h-0 flex-col">
			{error ? (
				<div
					role="alert"
					className="mx-6 mt-4 rounded-[var(--r-control)] border border-danger/30 bg-[var(--neo-bad-soft)] px-3 py-2 text-[12.5px] text-danger"
				>
					{error}
				</div>
			) : null}
			<div className="min-h-0 flex-1 px-6 pb-4 pt-5">
				{selected ? (
					<RoutineEditorPage key={target} routine={selected} onSaved={onSaved} onDeleted={onDeleted} />
				) : (
					<div className="text-[13.5px] text-ink-3">
						{loading ? "Loading routine…" : "Routine not found. Select a saved routine or create a new one."}
					</div>
				)}
			</div>
		</div>
	);
	return (
		<Layout
			sidebar={sidebar}
			main={main}
			inspector={
				<EditorInspector
					routine={selected === "new" ? undefined : selected}
					onChange={updated =>
						setRoutines(previous => previous.map(routine => (routine.id === updated.id ? updated : routine)))
					}
					onDeleted={onDeleted}
					onError={setError}
				/>
			}
			topBar={null}
		/>
	);
}
