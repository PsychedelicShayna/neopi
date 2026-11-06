import { useState } from "react";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus } from "lucide-react";
import type { Task, TaskState } from "@npi-deck/protocol";
import { cn } from "@/lib/utils";
import { TaskCard } from "./TaskCard";

interface Props {
	state: TaskState;
	tasks: Task[];
	onCreate: (stateId: string, title: string, body: string) => Promise<void>;
	onOpen: (task: Task) => void;
	onRenameRequest?: (state: TaskState) => void;
	isDraggingColumns: boolean;
}

/**
 * One kanban column.
 *
 * `useSortable` makes the column itself a drag source within the horizontal
 * `SortableContext` in `TasksView`; `data: { type: "column" }` is what
 * `onDragStart` / `onDragEnd` branch on to tell column reorders apart from
 * task drags. `useSortable` already registers the node as a droppable, so a
 * task dragged onto a column body still lands here — no second `useDroppable`
 * is needed.
 *
 * The drag handle is a dedicated `GripVertical` icon to the left of the color
 * dot, NOT the whole header — that keeps click-to-rename working on the
 * column name and avoids stealing pointer-down from card drags within the
 * column.
 */
export function Column({ state, tasks, onCreate, onOpen, onRenameRequest, isDraggingColumns }: Props) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
		id: state.id,
		data: { type: "column", stateId: state.id },
	});

	const style: React.CSSProperties = {
		transform: CSS.Translate.toString(transform),
		transition,
		opacity: isDragging ? 0.4 : undefined,
	};

	const [composing, setComposing] = useState(false);
	const [draft, setDraft] = useState("");
	const [body, setBody] = useState("");
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string>();

	async function submit(): Promise<void> {
		const t = draft.trim();
		if (!t || creating) return;
		setCreating(true);
		setError(undefined);
		try {
			await onCreate(state.id, t, body);
			setDraft("");
			setBody("");
			setComposing(false);
		} catch (e) {
			setError(String(e));
		} finally {
			setCreating(false);
		}
	}

	// Only highlight as a drop target while a task is being dragged. Column-vs-
	// column drags get their own visual feedback from the sortable transform.
	const showTaskDropHighlight = isOver && !isDragging && !isDraggingColumns;

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={cn(
				"flex w-72 shrink-0 flex-col border-r border-line bg-paper transition-colors",
				showTaskDropHighlight && "bg-accent-soft/40 ring-1 ring-inset ring-accent/40",
			)}
		>
			<div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line bg-paper px-3 py-2">
				<div className="flex items-center gap-1.5 min-w-0">
					<button
						type="button"
						{...attributes}
						{...listeners}
						className="cursor-grab touch-none text-ink-4 hover:text-ink active:cursor-grabbing"
						aria-label={`Drag to reorder column ${state.name}`}
						title="Drag to reorder"
					>
						<GripVertical className="h-3.5 w-3.5" />
					</button>
					<span
						className="h-2 w-2 shrink-0 rounded-full"
						style={{ backgroundColor: state.color }}
						aria-hidden="true"
					/>
					<button
						type="button"
						onClick={() => onRenameRequest?.(state)}
						className="font-mono text-2xs uppercase tracking-meta text-ink-2 hover:text-ink"
						title="Edit column"
					>
						{state.name}
					</button>
					<span className="font-mono text-2xs text-ink-4">{tasks.length}</span>
				</div>
				<button
					type="button"
					onClick={() => setComposing(true)}
					className="text-ink-3 hover:text-ink"
					aria-label="Add task"
					title="Add task"
				>
					<Plus className="h-4 w-4" />
				</button>
			</div>

			<div className="flex-1 overflow-y-auto px-2 py-2">
				<SortableContext items={tasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
					<div className="flex flex-col gap-1.5">
						{tasks.map(t => (
							<TaskCard key={t.id} task={t} onOpen={onOpen} />
						))}
					</div>
				</SortableContext>

				{composing ? (
					<div className="mt-2 border border-line bg-paper-2 p-2">
						<input
							autoFocus
							aria-label="Task title"
							value={draft}
							disabled={creating}
							onChange={e => setDraft(e.target.value)}
							placeholder="Task title"
							className="w-full bg-transparent text-sm placeholder:text-ink-4 focus:outline-none"
						/>
						<label className="mt-2 block font-mono text-2xs text-ink-3">
							Body / raw TOML properties
							<textarea
								rows={7}
								value={body}
								disabled={creating}
								onChange={e => setBody(e.target.value)}
								placeholder={
									'+++\nread-only = true\nworktree = "/absolute/path/to/existing-worktree"\nmodel = "provider/id"\nrole = "default"\n+++\nTask instructions'
								}
								className="mt-1 w-full resize-y bg-transparent font-mono text-xs placeholder:text-ink-4 focus:outline-none"
							/>
						</label>
						{error ? (
							<p role="alert" className="mt-1 text-xs text-danger">
								{error}
							</p>
						) : null}
						<div className="mt-2 flex justify-end gap-2">
							<button
								type="button"
								disabled={creating}
								onClick={() => {
									setDraft("");
									setBody("");
									setError(undefined);
									setComposing(false);
								}}
								className="btn-ghost h-7 px-2 text-xs"
							>
								Cancel
							</button>
							<button
								type="button"
								disabled={creating || !draft.trim()}
								onClick={() => void submit()}
								className="btn-primary h-7 px-2 text-xs"
							>
								{creating ? "Adding…" : "Add task"}
							</button>
						</div>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setComposing(true)}
						className="mt-2 w-full px-2 py-1.5 text-left font-mono text-2xs text-ink-4 hover:text-ink"
					>
						+ add task
					</button>
				)}
			</div>
		</div>
	);
}
