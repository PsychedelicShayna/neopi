import { useEffect, useState } from "react";
import { Archive, MessageSquarePlus, RotateCcw, Trash2, X } from "lucide-react";
import type { Task, TaskState } from "@npi-deck/protocol";

import { MarkdownEdit } from "@/components/MarkdownEdit";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/utils";

interface Props {
	task: Task | null;
	states: TaskState[];
	onClose: () => void;
	onSave: (patch: { title?: string; body?: string; stateId?: string; cwd?: string | null }) => void;
	onDelete: () => void;
	onArchive: () => void;
	onOpenInChat: () => void;
	onAssign: (patch: { title: string; body: string; stateId: string; cwd: string | null }) => Promise<void>;
	onCancel: () => Promise<void>;
}

/**
 * Centered modal for task details, raw TOML/body editing, and card agent runs.
 * Open in chat remains a separate operation from assigning an agent.
 */
export function TaskModal({
	task,
	states,
	onClose,
	onSave,
	onDelete,
	onArchive,
	onOpenInChat,
	onAssign,
	onCancel,
}: Props) {
	const open = task !== null;

	// Local mirror of editable fields so we can commit on blur without
	// thrashing the API on every keystroke.
	const [title, setTitle] = useState("");
	const [stateId, setStateId] = useState("");
	const [cwd, setCwd] = useState("");
	const [body, setBody] = useState("");
	const [rawEditing, setRawEditing] = useState(false);
	const [runPending, setRunPending] = useState(false);
	const [runError, setRunError] = useState<string>();

	useEffect(() => {
		setTitle(task?.title ?? "");
	}, [task?.id, task?.title]);
	useEffect(() => {
		setStateId(task?.stateId ?? "");
	}, [task?.id, task?.stateId]);
	useEffect(() => {
		setCwd(task?.cwd ?? "");
	}, [task?.id, task?.cwd]);
	useEffect(() => {
		setBody(task?.body ?? "");
	}, [task?.id, task?.body]);
	useEffect(() => {
		setRawEditing(false);
		setRunError(undefined);
	}, [task?.id]);

	if (!task) return null;

	function commitTitle(): void {
		if (!task) return;
		if (title !== task.title) onSave({ title });
	}
	function commitState(next: string): void {
		setStateId(next);
		if (!task || next === task.stateId) return;
		onSave({ stateId: next });
	}
	function commitCwd(): void {
		if (!task) return;
		// A blank field clears the cwd; `undefined` would be dropped by JSON and change nothing.
		const next = cwd.trim() || null;
		if ((task.cwd ?? null) !== next) onSave({ cwd: next });
	}

	const isArchived = Boolean(task.archivedAt);
	const runActive = task.run?.status === "queued" || task.run?.status === "running";

	async function runAction(action: () => Promise<void>): Promise<void> {
		if (runPending) return;
		setRunPending(true);
		setRunError(undefined);
		try {
			await action();
		} catch (e) {
			setRunError(String(e));
		} finally {
			setRunPending(false);
		}
	}

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-3xl">
			<header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
				<select
					value={stateId}
					onChange={e => commitState(e.target.value)}
					className="field h-8 px-2 font-mono text-2xs uppercase tracking-meta"
				>
					{states.map(s => (
						<option key={s.id} value={s.id}>
							{s.name}
						</option>
					))}
				</select>
				<div
					className="h-2 w-2 rounded-full"
					style={{
						backgroundColor: states.find(s => s.id === stateId)?.color ?? "var(--ink-3, #6e6a62)",
					}}
				/>
				<div className="ml-auto flex shrink-0 items-center gap-1">
					<IconAction
						label={isArchived ? "Unarchive" : "Archive"}
						icon={isArchived ? RotateCcw : Archive}
						onClick={onArchive}
					/>
					<IconAction label="Delete" icon={Trash2} tone="danger" onClick={onDelete} />
					<button
						type="button"
						onClick={onOpenInChat}
						className="btn-primary h-8 shrink-0 gap-1.5 whitespace-nowrap px-2.5 text-sm"
						title="Open this task as a new chat session"
					>
						<MessageSquarePlus className="h-4 w-4 shrink-0" />
						<span>Open in chat</span>
					</button>
					<IconAction label="Close" icon={X} onClick={onClose} />
				</div>
			</header>

			<div className="shrink-0 border-b border-line px-6 pt-5 pb-3">
				<input
					value={title}
					onChange={e => setTitle(e.target.value)}
					onBlur={commitTitle}
					onKeyDown={e => {
						if (e.key === "Enter") (e.target as HTMLInputElement).blur();
					}}
					placeholder="Untitled task"
					className={cn(
						"w-full bg-transparent text-xl font-semibold text-ink placeholder:text-ink-4 focus:outline-none",
						isArchived && "text-ink-3 line-through",
					)}
				/>
				<div className="mt-1 grid grid-cols-[max-content_1fr_max-content_1fr] gap-x-4 gap-y-1 font-mono text-2xs text-ink-3">
					<span className="text-ink-4">created</span>
					<span>{new Date(task.createdAt).toLocaleString()}</span>
					<span className="text-ink-4">updated</span>
					<span>{new Date(task.updatedAt).toLocaleString()}</span>
					<span className="text-ink-4">cwd</span>
					<span className="col-span-3">
						<input
							value={cwd}
							onChange={e => setCwd(e.target.value)}
							onBlur={commitCwd}
							placeholder="Unassigned"
							className="w-full bg-transparent font-mono text-2xs text-ink placeholder:text-ink-4 focus:outline-none"
						/>
					</span>
					{isArchived ? (
						<>
							<span className="text-warn">archived</span>
							<span>{new Date(task.archivedAt!).toLocaleString()}</span>
						</>
					) : null}
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
				<section className="mb-5 border-b border-line pb-4" aria-label="Card agent">
					<div className="flex items-center justify-between gap-2">
						<span className="font-mono text-xs text-ink-3">Agent · {task.run?.status ?? "Not assigned"}</span>
						{runActive ? (
							<button
								type="button"
								disabled={runPending}
								onClick={() => void runAction(onCancel)}
								className="btn-ghost h-8 px-2.5 text-sm"
							>
								{runPending ? "Cancelling…" : "Cancel agent"}
							</button>
						) : (
							<button
								type="button"
								disabled={runPending || !title.trim()}
								onClick={() =>
									void runAction(() =>
										onAssign({
											title,
											body,
											stateId,
											cwd: cwd.trim() || null,
										}),
									)
								}
								className="btn-primary h-8 px-2.5 text-sm"
							>
								{runPending ? "Assigning…" : "Assign agent"}
							</button>
						)}
					</div>
					{task.run?.cwd ? (
						<p className="mt-2 break-all font-mono text-2xs text-ink-3">
							Run directory · {task.run.cwd}
							{task.run.ownedWorktree ? " · owned worktree" : ""}
						</p>
					) : null}
					{task.run?.outcome ? (
						<div className="mt-3">
							<div className="font-mono text-2xs text-ink-4">Outcome</div>
							<p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{task.run.outcome}</p>
						</div>
					) : null}
					{task.run?.error ? (
						<p className="mt-3 whitespace-pre-wrap break-words text-sm text-danger">{task.run.error}</p>
					) : null}
					{runError ? (
						<p role="alert" className="mt-3 text-sm text-danger">
							{runError}
						</p>
					) : null}
				</section>
				<div className="mb-3 flex items-center justify-between gap-2">
					<span className="font-mono text-2xs text-ink-3">Body / TOML properties</span>
					<button
						type="button"
						onClick={() => setRawEditing(current => !current)}
						className="btn-ghost h-7 px-2 text-xs"
					>
						{rawEditing ? "Preview" : "Edit raw TOML & body"}
					</button>
				</div>
				{rawEditing ? (
					<>
						<textarea
							aria-label="Raw TOML and task body"
							rows={14}
							value={body}
							onChange={e => setBody(e.target.value)}
							className="field w-full resize-y p-3 font-mono text-xs"
							placeholder={
								'+++\nread-only = true\nworktree = "/absolute/path/to/existing-worktree"\nmodel = "provider/id"\nrole = "default"\n+++\nTask instructions'
							}
						/>
						<button
							type="button"
							onClick={() => onSave({ body })}
							className="btn-primary mt-2 h-8 px-2.5 text-sm"
						>
							Save body
						</button>
					</>
				) : (
					<MarkdownEdit
						value={body}
						onChange={next => {
							setBody(next);
							onSave({ body: next });
						}}
						placeholder="Click to add notes — markdown supported. Edit raw TOML & body to set properties."
					/>
				)}
			</div>
		</Modal>
	);
}

function IconAction({
	label,
	icon: Icon,
	onClick,
	tone = "default",
}: {
	label: string;
	icon: typeof Trash2;
	onClick: () => void;
	tone?: "default" | "danger";
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			className={cn(
				"flex h-8 w-8 items-center justify-center rounded-md transition-colors",
				tone === "danger"
					? "text-ink-3 hover:bg-danger/10 hover:text-danger"
					: "text-ink-3 hover:bg-paper-3 hover:text-ink",
			)}
		>
			<Icon className="h-4 w-4" />
		</button>
	);
}
