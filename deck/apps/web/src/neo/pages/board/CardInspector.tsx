import { Archive, ArrowDownLeft, GitBranch, Inbox, MessagesSquare, Plus, RotateCcw, Trash2, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { MarkdownEdit } from "@/components/MarkdownEdit";
import { ErrorState, formatRelativeTime, formatShortRelative, formatTimestamp, NeoButton, NeoLinkButton, NeoSelect, SectionLabel } from "@/components/neo";
import { projectLabel } from "@/lib/kanban-project";
import { cardBodyParts } from "@/lib/card-frontmatter";
import { Markdown } from "@/lib/markdown";
import { board, type BoardCard, type BoardColumn, type BoardEvent, type BoardLinks } from "../../client/board";
import { AgentSwatch } from "../../components/AgentSwatch";
import { ModelPicker } from "../../components/ModelPicker";
import { DockInspector } from "../../components/DockInspector";

export function CardInspector({ card, cards, columns, onClose, onOpenCard, onChanged, onRemoved }: { card: BoardCard; cards: BoardCard[]; columns: BoardColumn[]; onClose: () => void; onOpenCard: (id: string) => void; onChanged: () => Promise<void>; onRemoved: () => void }) {
	const [events, setEvents] = useState<BoardEvent[] | null>(null);
	const [links, setLinks] = useState<BoardLinks>({});
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [editingTitle, setEditingTitle] = useState(false);
	const [title, setTitle] = useState(card.title);
	const [editingBody, setEditingBody] = useState(false);
	const [body, setBody] = useState(card.body);
	const [assigning, setAssigning] = useState(false);
	const [model, setModel] = useState("");
	const [note, setNote] = useState("");
	const [splitTitle, setSplitTitle] = useState("");
	const [splitting, setSplitting] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const run = card.run;
	const running = run?.status === "running" || run?.status === "queued";
	const parent = cards.find(candidate => candidate.id === card.parent || `T-${candidate.number}` === card.parent);
	const children = cards.filter(candidate => candidate.parent === card.id || candidate.parent === `T-${card.number}`);
	useEffect(() => { setTitle(card.title); }, [card.title]);
	useEffect(() => { if (!editingBody) setBody(card.body); }, [card.body, editingBody]);
	useEffect(() => {
		let cancelled = false;
		void Promise.all([board.events(card.id), board.links(card.id)]).then(([nextEvents, nextLinks]) => { if (!cancelled) { setEvents(nextEvents); setLinks(nextLinks); } }).catch((err: unknown) => { if (!cancelled) setError(`Could not load card evidence. ${String(err)}`); });
		return () => { cancelled = true; };
	}, [card]);
	useEffect(() => { if (!confirmDelete) return; const timer = setTimeout(() => setConfirmDelete(false), 4000); return () => clearTimeout(timer); }, [confirmDelete]);
	async function act(action: () => Promise<unknown>): Promise<boolean> {
		if (busy) return false;
		setBusy(true); setError(null);
		try { await action(); await onChanged(); return true; }
		catch (err) { setError(`The action did not finish. ${String(err)}`); return false; }
		finally { setBusy(false); }
	}
	async function saveTitle() {
		if (!title.trim()) { setTitle(card.title); setEditingTitle(false); return; }
		if (title.trim() === card.title || await act(() => board.update(card.id, { title: title.trim() }))) setEditingTitle(false);
	}
	const thread = links.thread ? `/threads?thread=${encodeURIComponent(links.thread.id)}` : `/threads?card=T-${card.number}&draft=${encodeURIComponent(`About T-${card.number}: ${card.title}`)}`;
	const holder = card.holder;
	let content = card.body;
	try { content = cardBodyParts(card.body).content; } catch { /* Raw editing remains available for invalid TOML. */ }
	return <DockInspector onClose={onClose} returnFocusSelector={`[data-board-card="${CSS.escape(card.id)}"]`} title={editingTitle ? <input className="neo-input neo-board-title-input" aria-label="Card title" value={title} onChange={e => setTitle(e.target.value)} onBlur={() => void saveTitle()} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} autoFocus /> : <button type="button" className="neo-board-edit-title" title="Edit title" onClick={() => setEditingTitle(true)}>{card.title}</button>} subtitle={`T-${card.number} · ${projectLabel(card.cwd)} · ${columns.find(c => c.id === card.columnId)?.name ?? "Unknown column"} · created ${formatRelativeTime(card.createdAt)}`} footer={<div className="neo-board-inspector-actions">
		{editingBody && <div className="neo-board-actions"><NeoButton size="sm" variant="primary" disabled={busy} onClick={() => { void act(() => board.update(card.id, { body })).then(saved => { if (saved) setEditingBody(false); }); }}>Save instructions</NeoButton><NeoButton size="sm" variant="ghost" onClick={() => setEditingBody(false)}>Cancel editing</NeoButton></div>}
		<div className="neo-board-actions">{running ? <NeoButton variant="danger" size="sm" disabled={busy} onClick={() => void act(() => board.cancel(card.id))}>Stop assignment</NeoButton> : assigning ? <NeoButton size="sm" variant="primary" disabled={busy || card.archived} onClick={() => { void act(() => board.assign(card.id, model || undefined)).then(started => { if (started) setAssigning(false); }); }}>{busy ? "Starting…" : "Start assignment"}</NeoButton> : <NeoButton size="sm" onClick={() => setAssigning(true)} disabled={busy || card.archived}>{run ? "Assign again" : "Assign an agent"}</NeoButton>}<NeoLinkButton to={thread} size="sm"><MessagesSquare size={13} />Discuss in a thread</NeoLinkButton></div>
		<div className="neo-board-actions"><NeoButton size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => board.update(card.id, { archived: !card.archived }))}>{card.archived ? <RotateCcw size={13} /> : <Archive size={13} />}{card.archived ? "Restore" : "Archive"}</NeoButton><NeoButton size="sm" variant="danger" disabled={busy} onClick={() => { if (!confirmDelete) { setConfirmDelete(true); return; } void act(async () => { await board.remove(card.id); onRemoved(); }); }}><Trash2 size={13} />{confirmDelete ? "Delete for good?" : "Delete"}</NeoButton></div>
	</div>}>
		<div className="neo-board-detail">
			{error && <ErrorState error={error} />}
			<div className="neo-board-provenance"><Inbox size={14} /><span>{card.origin.kind === "manual" ? "Added directly to the board" : `Arrived from ${card.origin.kind}`}{card.origin.ref && <small>{card.origin.ref}</small>}</span>{card.origin.kind === "inbox" && card.origin.ref && <Link to={`/inbox?item=${encodeURIComponent(card.origin.ref)}`}>View capture</Link>}</div>
			<section><SectionLabel>Assignment</SectionLabel>{holder ? <div className="neo-board-run"><div className="neo-board-holder">{holder.kind === "agent" ? <AgentSwatch hue={holder.hue} name={holder.name} /> : <span>@{holder.handle}</span>}<span className="neo-board-run-state" data-status={run?.status}>{run?.status ?? "Holding"}</span></div>{holder.kind === "agent" && <div className="neo-board-model">{holder.model}</div>}{run && <span className="neo-board-since">Assigned {formatShortRelative(run.assignedAt)}{run.finishedAt ? `, finished ${formatShortRelative(run.finishedAt)}` : ""}</span>}</div> : <p className="neo-dim">Waiting for an agent. A card can hold an idea or investigation without starting work.</p>}
				{run?.outcome && <div className="neo-board-outcome"><Markdown>{run.outcome}</Markdown></div>}{run?.error && <p className="neo-board-run-error" role="status">{run.error}</p>}
				{assigning && !running && <div className="neo-board-assignment"><p className="neo-board-help">Choose a model for this assignment, or inherit the card's model and deck default. Start it with the action below.</p><div className="neo-board-actions"><ModelPicker value={model} onChange={setModel} />{model && <NeoButton size="sm" variant="ghost" onClick={() => setModel("")}>Use default</NeoButton>}<NeoButton size="sm" variant="ghost" onClick={() => setAssigning(false)}>Cancel assignment</NeoButton></div></div>}
			</section>
			<section><SectionLabel actions={!editingBody && <NeoButton size="sm" variant="ghost" onClick={() => { setBody(card.body); setEditingBody(true); }}>Edit instructions</NeoButton>}>The work</SectionLabel>{editingBody ? <div className="neo-board-markdown-editor"><MarkdownEdit value={body} onChange={setBody} onDraftChange={setBody} autoEdit autoFocus placeholder="Instructions, context and acceptance criteria…" /></div> : content.trim() ? <div className="neo-board-markdown"><Markdown>{content}</Markdown></div> : <p className="neo-dim">No extra instructions.</p>}</section>
			<section><SectionLabel actions={<NeoButton size="sm" variant="ghost" onClick={() => setSplitting(value => !value)}><Plus size={12} />Related card</NeoButton>}>Related work</SectionLabel>{parent && <button className="neo-board-related-row" type="button" onClick={() => onOpenCard(parent.id)}><ArrowDownLeft size={13} /><span>From T-{parent.number}</span><strong>{parent.title}</strong></button>}{children.map(child => <button className="neo-board-related-row" key={child.id} type="button" onClick={() => onOpenCard(child.id)}><span>T-{child.number}</span><strong>{child.title}</strong><small>{columns.find(column => column.id === child.columnId)?.name}</small></button>)}{!parent && !children.length && <p className="neo-dim">No linked cards. Split independent work into cards so each assignment keeps its own result.</p>}{splitting && <form className="neo-board-note-form" onSubmit={e => { e.preventDefault(); if (!splitTitle.trim()) return; void act(async () => { const child = await board.create({ title: splitTitle.trim(), cwd: card.cwd, properties: { parent: card.id, origin: card.origin.kind, origin_ref: card.origin.ref } }); await board.note(card.id, `Split out T-${child.number}: ${child.title}`); }).then(saved => { if (saved) { setSplitTitle(""); setSplitting(false); } }); }}><input className="neo-input" aria-label="Related card title" placeholder="What can be worked on separately?" value={splitTitle} onChange={e => setSplitTitle(e.target.value)} autoFocus /><NeoButton type="submit" size="sm" disabled={busy || !splitTitle.trim()}>Create related card</NeoButton></form>}</section>
			{(links.issue || links.pr || links.flow || links.thread) && <section><SectionLabel>Linked evidence</SectionLabel><div className="neo-board-links">{(["issue", "pr"] as const).map(kind => { const ref = links[kind]; if (!ref) return null; return <a key={kind} href={ref.url ?? `https://github.com/${ref.repo}/${kind === "pr" ? "pull" : "issues"}/${ref.number}`} target="_blank" rel="noreferrer"><GitBranch size={13} />{ref.repo} {kind === "pr" ? "PR" : "issue"} #{ref.number}</a>; })}{links.thread && <Link to={thread}><MessagesSquare size={13} />Thread</Link>}{links.flow && <Link to={`/studio?graph=${encodeURIComponent(links.flow.id)}`}><Workflow size={13} />{links.flow.name}</Link>}</div></section>}
			<section><SectionLabel>Activity and receipts</SectionLabel>{events === null ? <p className="neo-dim">Loading stored activity…</p> : <ol className="neo-board-events">{events.map(event => <li key={event.id} data-tone={event.tone}><i aria-hidden="true" /><time title={formatTimestamp(event.at)} dateTime={event.at}>{formatShortRelative(event.at)}</time><span>{event.actor && <strong>{event.actor} </strong>}{event.text}</span></li>)}</ol>}<form className="neo-board-note-form" onSubmit={e => { e.preventDefault(); if (note.trim()) void act(() => board.note(card.id, note.trim())).then(saved => { if (saved) setNote(""); }); }}><label htmlFor="neo-board-note">Leave context for the next agent</label><textarea id="neo-board-note" className="neo-textarea" value={note} onChange={e => setNote(e.target.value)} placeholder="A decision, result or link worth keeping…" rows={3} maxLength={20000} /><NeoButton type="submit" size="sm" disabled={busy || !note.trim()}>Add note</NeoButton></form></section>
			<section><SectionLabel>Change state</SectionLabel><NeoSelect size="sm" aria-label="Move card to column" value={card.columnId} disabled={busy} onChange={e => void act(() => board.move(card.id, e.target.value))}>{columns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</NeoSelect></section>
		</div>
	</DockInspector>;
}
