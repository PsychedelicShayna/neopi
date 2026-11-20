/**
 * Canvas editor for a routine.
 *
 * - Renders the routine's `steps` as nodes, with explicit `layout.edges` when
 *   present and inferred sequential + dependency edges when not
 *   (`graph-import`). Dragging a node persists `layout.nodes` on drag-end.
 * - The trigger is on the canvas too: one start node above the root steps,
 *   wired to each of them. Selecting it edits the triggers in the inspector.
 * - Selecting a step opens the inspector (a flex sibling at >= 1100px, a
 *   drawer below). Esc / X / Delete all close it; renames cascade through
 *   `layout.nodes` + `layout.edges` via `replaceStep`.
 * - Validation lives at the node and at the field: `fieldErrors` from the
 *   parent is stamped onto node data, so a node shows its first problem and
 *   the inspector shows every problem at the field it belongs to. Graph
 *   compile errors (cycles, dangling edges) get the same treatment plus a
 *   small pill when they cannot be pinned on a node.
 *
 * Theming approach: React Flow ships with light-mode CSS that uses CSS custom
 * properties (`--xy-background-color`, `--xy-edge-stroke`, etc). We import its
 * stylesheet once globally and override the variables on the `.routine-canvas`
 * wrapper so the canvas inherits whichever deck theme is active.
 */

import {
	ReactFlowProvider,
	useEdgesState,
	useNodesState,
	useReactFlow,
	type Connection,
	type EdgeChange,
	type NodeChange,
	type NodePositionChange,
	type OnSelectionChangeParams,
} from "@xyflow/react";
import { CircleAlert } from "lucide-react";
import { GraphCanvasSurface } from "@/components/graph/GraphCanvasSurface";
import { NeoSelect } from "@/components/neo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
	RoutineDeckAction,
	RoutineLayout,
	RoutineRun,
	RoutineSpec,
	RoutineStep,
	RoutineStepRun,
	RoutineTrigger,
} from "@npi-deck/protocol";

import type { RoutineFieldErrors } from "../routine-validation";
import { removeStep, replaceStep, scaffoldStep } from "../spec-toml";

import { AddStepPalette } from "./AddStepPalette";
import { SequentialEdge } from "./edges/SequentialEdge";
import { applyAddNodeAtBottom } from "./graph-add";
import type { CompileError } from "./graph-compile";
import { applyEdgeConnection, applyEdgeRemoval } from "./legacy-graph-connect";
import { importFromSpec } from "./graph-import";
import {
	CANVAS_DEFAULT_X,
	type SequentialEdge as SequentialEdgeType,
	type StepNode as StepNodeType,
} from "./legacy-graph-types";
import { StepNode } from "./nodes/StepNode";
import { TRIGGER_NODE_ID, TriggerNodeView, type TriggerNode } from "./nodes/TriggerNode";
import { StepInspector } from "./StepInspector";
import { TriggerInspector } from "./TriggerInspector";

/** Delete and Backspace both remove the selection; React Flow ignores them while a text field has focus. */
const DELETE_KEYS = ["Delete", "Backspace"];

/** A request from the parent to select something on the canvas; `seq` makes repeats distinct. */
export interface CanvasSelectRequest {
	target: string | "trigger";
	seq: number;
}

interface RoutineCanvasProps {
	/** The routine spec being edited. */
	spec: RoutineSpec;
	/** Called whenever the canvas commits a change to the spec. */
	onChange: (next: RoutineSpec) => void;
	/** Called when the trigger inspector edits the trigger list. */
	onChangeTriggers?: (next: RoutineTrigger[]) => void;
	/**
	 * Compile errors from the parent's `compileGraph(spec)` memo. The canvas
	 * marks offending nodes and shows a pill for the count; the parent gates
	 * the Save button on this list being empty.
	 */
	compileErrors?: ReadonlyArray<CompileError>;
	/** Schema validation regrouped by field; see `fieldErrorsForSpec`. */
	fieldErrors?: RoutineFieldErrors;
	/** Parent-driven selection (e.g. "show me the first problem"). */
	selectRequest?: CanvasSelectRequest | null;
	/**
	 * Per-step run record for the currently-displayed run. The canvas
	 * stamps `stepRun` onto each node's `data.stepRun` so StepNode renders
	 * the status ring + telemetry. Empty/absent for routines that haven't run.
	 */
	stepRunsByStepId?: ReadonlyMap<string, RoutineStepRun>;
	/** Recent runs for the last-run picker, rendered when >= 1 run exists. */
	runs?: ReadonlyArray<RoutineRun>;
	/** Currently-selected run id; mirror of the picker's value. */
	selectedRunId?: string | null;
	/** Picker change handler. */
	onSelectRun?: (runId: string | null) => void;
	/** Optional deep-link target for the inspector's last-run section. */
	routineId?: string;
	advanced?: boolean;
	allowAdd?: boolean;
	allowDelete?: boolean;
	allowConnect?: boolean;
}

type CanvasNode = StepNodeType | TriggerNode;

const NODE_TYPES = { step: StepNode, trigger: TriggerNodeView };
const EDGE_TYPES = { sequential: SequentialEdge };

const WIDE_VIEWPORT_QUERY = "(min-width: 1100px)";
/** Vertical distance between the trigger pill and the first step. */
const TRIGGER_GAP = 96;

function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(
		() => typeof window !== "undefined" && window.matchMedia(query).matches,
	);
	useEffect(() => {
		if (typeof window === "undefined" || !window.matchMedia) return;
		const mql = window.matchMedia(query);
		const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, [query]);
	return matches;
}

// Keep fitView from zooming out below a legible scale on tall, narrow
// graphs (linear pipelines stack vertically and the canvas is wider than the
// graph). The user can scroll vertically if the graph overflows the viewport.
const FIT_VIEW_OPTIONS = { padding: 0.2, minZoom: 0.7, maxZoom: 1.25 } as const;

export function LegacyRoutineCanvas(props: RoutineCanvasProps): JSX.Element {
	return (
		<ReactFlowProvider>
			<RoutineCanvasInner {...props} />
		</ReactFlowProvider>
	);
}

function RoutineCanvasInner({
	spec,
	onChange,
	onChangeTriggers,
	compileErrors,
	fieldErrors,
	selectRequest,
	stepRunsByStepId,
	runs,
	selectedRunId,
	onSelectRun,
	routineId,
	advanced = false,
	allowAdd = true,
	allowDelete = true,
	allowConnect = true,
}: RoutineCanvasProps): JSX.Element {
	// Re-derive the React Flow graph whenever the spec's steps or layout change.
	const imported = useMemo(
		() => importFromSpec(spec),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[spec.steps, spec.layout],
	);

	// Flatten compile errors into a `step id -> first message` map.
	const errorByStepId = useMemo(() => {
		const m = new Map<string, string>();
		for (const err of compileErrors ?? []) {
			for (const id of err.nodeIds) {
				if (!m.has(id)) m.set(id, err.message);
			}
		}
		return m;
	}, [compileErrors]);

	// Canvas-local "if-flavored" tracker. The `if` palette entry scaffolds a
	// transform step; the node renders with two labeled handles when EITHER
	// (a) it has at least one outgoing branch edge already, OR (b) the user
	// just added it via the palette and hasn't wired anything yet.
	const [ifNodeIds, setIfNodeIds] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(() => {
		if (ifNodeIds.size === 0) return;
		const validIds = new Set(spec.steps.map((s) => s.id));
		let mutated = false;
		const next = new Set<string>();
		for (const id of ifNodeIds) {
			if (validIds.has(id)) next.add(id);
			else mutated = true;
		}
		if (mutated) setIfNodeIds(next);
	}, [spec.steps, ifNodeIds]);

	const isIfNode = useMemo(() => {
		const fromEdges = new Set<string>();
		for (const e of spec.layout?.edges ?? []) {
			if (e.kind === "true" || e.kind === "false") fromEdges.add(e.from);
		}
		return (id: string): boolean => fromEdges.has(id) || ifNodeIds.has(id);
	}, [spec.layout?.edges, ifNodeIds]);

	const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
	const [edges, setEdges, onEdgesChange] = useEdgesState<SequentialEdgeType>(imported.edges);
	const rf = useReactFlow();

	// Canvas-owned selection state. React Flow's internal node.selected flag
	// is the rendering source of truth; this is the AUTHORITATIVE id we use
	// to look up the selected step in `spec.steps` for the inspector.
	const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
	const [triggerSelected, setTriggerSelected] = useState(false);

	const specRef = useRef(spec);
	useEffect(() => {
		specRef.current = spec;
	}, [spec]);
	const selectedStepIdRef = useRef(selectedStepId);
	useEffect(() => {
		selectedStepIdRef.current = selectedStepId;
	}, [selectedStepId]);
	const triggerSelectedRef = useRef(triggerSelected);
	useEffect(() => {
		triggerSelectedRef.current = triggerSelected;
	}, [triggerSelected]);

	const triggerProblem = fieldErrors?.top.trigger ?? (spec.trigger.length === 0 ? "Choose how this routine starts." : undefined);

	// On spec change, error change, if-flag change, or run-overlay change:
	// reapply selection and stamp `compileError`, `fieldErrors`, `isIfNode`,
	// `stepRun` onto each node's data, then prepend the trigger node.
	useEffect(() => {
		const selId = selectedStepIdRef.current;
		const stepNodes: StepNodeType[] = imported.nodes.map((n) => {
			const data = {
				...n.data,
				compileError: errorByStepId.get(n.id),
				fieldErrors: fieldErrors?.steps.get(n.id),
				isIfNode: isIfNode(n.id),
				stepRun: stepRunsByStepId?.get(n.id),
				advanced,
			};
			return { ...n, data, selected: selId === n.id, deletable: allowDelete };
		});
		const roots = rootNodes(imported.nodes, imported.edges);
		const anchor = roots[0] ?? imported.nodes[0];
		const triggerNode: TriggerNode = {
			id: TRIGGER_NODE_ID,
			type: "trigger",
			position: anchor
				? { x: anchor.position.x + 14, y: anchor.position.y - TRIGGER_GAP }
				: { x: CANVAS_DEFAULT_X + 14, y: -TRIGGER_GAP },
			data: { triggers: spec.trigger, problem: triggerProblem },
			selected: triggerSelectedRef.current,
			draggable: false,
			deletable: false,
			connectable: false,
		};
		setNodes([triggerNode, ...stepNodes]);
		const triggerEdges: SequentialEdgeType[] = roots.map((root) => ({
			id: `${TRIGGER_NODE_ID}->${root.id}`,
			source: TRIGGER_NODE_ID,
			target: root.id,
			type: "sequential",
			deletable: false,
			selectable: false,
			data: { kind: "success", inferred: false },
		}));
		setEdges([...triggerEdges, ...imported.edges]);
	}, [imported, errorByStepId, fieldErrors, isIfNode, stepRunsByStepId, setNodes, setEdges, advanced, allowDelete, spec.trigger, triggerProblem]);

	const handleNodesChange = useCallback(
		(changes: NodeChange<CanvasNode>[]) => {
			onNodesChange(changes);
			const committed = changes.filter(
				(c): c is NodePositionChange =>
					c.type === "position" && c.dragging === false && !!c.position,
			);
			if (committed.length === 0) return;
			const currentSpec = specRef.current;
			const next = applyPositionCommits(currentSpec, committed);
			if (next !== currentSpec) onChange(next);
		},
		[onNodesChange, onChange],
	);

	// Edge authoring. Connect = add explicit edge to `layout.edges`, lifting
	// inferred sequentials on first author so the visual graph doesn't
	// collapse. Removal mirrors back to `layout.edges`. A connection from a
	// labeled handle (`true` / `false`) persists the edge kind.
	const handleConnect = useCallback(
		(conn: Connection) => {
			const { source, target, sourceHandle } = conn;
			if (!source || !target || source === TRIGGER_NODE_ID || target === TRIGGER_NODE_ID) return;
			const currentSpec = specRef.current;
			const kind =
				sourceHandle === "true" || sourceHandle === "false"
					? sourceHandle
					: undefined;
			const next = applyEdgeConnection(currentSpec, source, target, kind);
			if (next !== currentSpec) onChange(next);
		},
		[onChange],
	);

	// Removals (Delete or Backspace on a selected step or edge) arrive here once,
	// with every node and edge React Flow removed together, so the spec is
	// rewritten in a single pass instead of two handlers racing on a stale ref.
	const handleDelete = useCallback(
		({ nodes: goneNodes, edges: goneEdges }: { nodes: CanvasNode[]; edges: SequentialEdgeType[] }) => {
			const removed = new Set(goneNodes.filter((n) => n.id !== TRIGGER_NODE_ID).map((n) => n.id));
			let nextSpec = specRef.current;
			for (const edge of goneEdges) {
				if (edge.source === TRIGGER_NODE_ID || removed.has(edge.source) || removed.has(edge.target)) continue;
				nextSpec = applyEdgeRemoval(nextSpec, edge.source, edge.target, edge.data?.kind ?? "success");
			}
			for (const id of removed) {
				const idx = nextSpec.steps.findIndex((s) => s.id === id);
				if (idx >= 0) nextSpec = removeStep(nextSpec, idx);
			}
			if (removed.has(selectedStepIdRef.current ?? "")) setSelectedStepId(null);
			if (nextSpec !== specRef.current) onChange(nextSpec);
		},
		[onChange],
	);

	// Keep canvas-local selection in lockstep with React Flow's view of
	// what's selected. Exactly one selected step → step inspector; the
	// trigger alone → trigger inspector; zero or many → nothing.
	const handleSelectionChange = useCallback(
		(params: OnSelectionChangeParams) => {
			const ids = params.nodes
				.map((n) => (n.type === "step" ? n.id : undefined))
				.filter((id): id is string => typeof id === "string");
			const trigger = params.nodes.some((n) => n.type === "trigger");
			setSelectedStepId(ids.length === 1 && !trigger ? ids[0]! : null);
			setTriggerSelected(trigger && ids.length === 0);
		},
		[],
	);

	const selectOnly = useCallback(
		(target: string | "trigger" | null) => {
			const stepId = target && target !== "trigger" ? target : null;
			setSelectedStepId(stepId);
			setTriggerSelected(target === "trigger");
			setNodes((prev) =>
				prev.map((n) => {
					const selected = target === "trigger" ? n.type === "trigger" : n.id === stepId;
					return n.selected === selected ? n : { ...n, selected };
				}),
			);
		},
		[setNodes],
	);

	// Parent-driven selection: "show me the first problem".
	const lastSelectSeq = useRef<number | null>(null);
	useEffect(() => {
		if (!selectRequest || selectRequest.seq === lastSelectSeq.current) return;
		lastSelectSeq.current = selectRequest.seq;
		selectOnly(selectRequest.target);
	}, [selectRequest, selectOnly]);

	// Palette → scaffold + insert + stamp a bottom-anchored layout position,
	// then auto-select the new node so the inspector opens on it.
	const handleAddStep = useCallback(
		(
			type: RoutineStep["type"],
			presetAction?: RoutineDeckAction,
			presetKind?: "if",
		) => {
			const currentSpec = specRef.current;
			const existingIds = currentSpec.steps.map((s) => s.id);
			const newStep = scaffoldStep(type, existingIds, presetAction, presetKind);
			const next = applyAddNodeAtBottom(currentSpec, newStep);
			onChange(next);
			setSelectedStepId(newStep.id);
			setTriggerSelected(false);
			if (presetKind === "if") {
				setIfNodeIds((prev) => {
					const next = new Set(prev);
					next.add(newStep.id);
					return next;
				});
			}
		},
		[onChange],
	);

	// Inspector edit: rebuild the spec via replaceStep, which already cascades
	// id renames through `layout.nodes` + `layout.edges`. If the id changed,
	// keep the selection pointing at the NEW id so the inspector stays open.
	const handleInspectorChange = useCallback(
		(nextStep: RoutineStep) => {
			const currentSpec = specRef.current;
			const idx = currentSpec.steps.findIndex(
				(s) => s.id === selectedStepIdRef.current,
			);
			if (idx < 0) return;
			const nextSpec = replaceStep(currentSpec, idx, nextStep);
			onChange(nextSpec);
			if (currentSpec.steps[idx]!.id !== nextStep.id) {
				setSelectedStepId(nextStep.id);
			}
		},
		[onChange],
	);

	const handleInspectorClose = useCallback(() => selectOnly(null), [selectOnly]);

	const handleInspectorDelete = useCallback(() => {
		const currentSpec = specRef.current;
		const idx = currentSpec.steps.findIndex(
			(s) => s.id === selectedStepIdRef.current,
		);
		if (idx < 0) return;
		onChange(removeStep(currentSpec, idx));
		setSelectedStepId(null);
	}, [onChange]);

	const selectedStep = useMemo(() => {
		if (!selectedStepId) return null;
		return spec.steps.find((s) => s.id === selectedStepId) ?? null;
	}, [spec.steps, selectedStepId]);

	const empty = imported.nodes.length === 0;
	const existingIds = useMemo(() => spec.steps.map((s) => s.id), [spec.steps]);

	// At viewport >= 1100px the inspector becomes a flex sibling of the
	// canvas, so the React Flow viewport shrinks when it opens and grows back
	// when it closes. Re-fit on each transition so the graph stays centered.
	const isWide = useMediaQuery(WIDE_VIEWPORT_QUERY);
	const inspectorOpen = selectedStep !== null || (triggerSelected && onChangeTriggers !== undefined);
	const inlineInspectorOpen = inspectorOpen && isWide;
	const drawerInspectorOpen = inspectorOpen && !isWide;
	useEffect(() => {
		if (!isWide) return;
		// Two rAFs: the first lets the flex reflow land, the second lets React
		// Flow's internal ResizeObserver pick up the new dimensions.
		let inner = 0;
		const outer = requestAnimationFrame(() => {
			inner = requestAnimationFrame(() => {
				rf.fitView({ ...FIT_VIEW_OPTIONS, duration: 200 });
			});
		});
		return () => {
			cancelAnimationFrame(outer);
			cancelAnimationFrame(inner);
		};
	}, [inlineInspectorOpen, isWide, rf]);

	const inspector = selectedStep ? (
		<StepInspector
			step={selectedStep}
			existingIds={existingIds}
			errors={fieldErrors?.steps.get(selectedStep.id)}
			onChange={handleInspectorChange}
			onClose={handleInspectorClose}
			onDelete={handleInspectorDelete}
			mode={isWide ? "inline" : "drawer"}
			advanced={advanced}
			allowDelete={allowDelete}
			isIfNode={isIfNode(selectedStep.id)}
			stepRun={stepRunsByStepId?.get(selectedStep.id)}
			routineId={routineId}
			selectedRunId={selectedRunId ?? null}
		/>
	) : triggerSelected && onChangeTriggers ? (
		<TriggerInspector
			triggers={spec.trigger}
			onChange={onChangeTriggers}
			onClose={handleInspectorClose}
			mode={isWide ? "inline" : "drawer"}
			error={fieldErrors?.top.trigger}
		/>
	) : null;

	const firstCompileTarget = compileErrors?.[0]?.nodeIds[0];

	return (
		<div className="routine-canvas relative flex h-full w-full">
			<div className="relative h-full flex-1 min-w-0">
				<GraphCanvasSurface
					nodes={nodes}
					edges={edges}
					onNodesChange={handleNodesChange}
					onEdgesChange={onEdgesChange}
					onDelete={handleDelete}
					deleteKeyCode={DELETE_KEYS}
					onSelectionChange={handleSelectionChange}
					onConnect={handleConnect}
					nodeTypes={NODE_TYPES}
					edgeTypes={EDGE_TYPES}
					fitView
					fitViewOptions={FIT_VIEW_OPTIONS}
					nodesDraggable
					nodesConnectable={allowConnect}
					elementsSelectable
				/>
				{allowAdd ? <AddStepPalette onAdd={handleAddStep} advanced={advanced} /> : null}
				{runs && runs.length > 0 && onSelectRun ? (
					<RunOverlayPicker
						runs={runs}
						selectedRunId={selectedRunId ?? null}
						onSelect={onSelectRun}
					/>
				) : null}
				{compileErrors && compileErrors.length > 0 ? (
					<button
						type="button"
						className="neo-canvas-pill"
						data-tone="bad"
						title={compileErrors.map((e) => e.message).join("\n")}
						onClick={() => firstCompileTarget && selectOnly(firstCompileTarget)}
					>
						<CircleAlert size={13} />
						{compileErrors.length === 1 ? compileErrors[0]!.message : `${compileErrors.length} problems in the graph`}
					</button>
				) : null}
				{empty ? (
					<div className="pointer-events-none absolute inset-x-0 top-[calc(50%+48px)] flex justify-center">
						<div className="neo-empty max-w-[320px] rounded-[var(--r-card)] border border-dashed border-[var(--neo-line-2)] bg-[color-mix(in_srgb,var(--neo-panel)_85%,transparent)] py-6">
							<div className="neo-empty-title">What should this routine do?</div>
							<div className="neo-empty-hint">Choose <span className="text-ink">Add action</span> to put the first step on the canvas.</div>
						</div>
					</div>
				) : null}
			</div>
			{inlineInspectorOpen ? inspector : null}
			{drawerInspectorOpen ? (
				<>
					<div
						onClick={handleInspectorClose}
						aria-hidden="true"
						className="neo-scrim fixed inset-0 z-20"
					/>
					{inspector}
				</>
			) : null}
		</div>
	);
}

/** Steps with no incoming edge: where the trigger connects. */
function rootNodes(nodes: ReadonlyArray<StepNodeType>, edges: ReadonlyArray<SequentialEdgeType>): StepNodeType[] {
	const targets = new Set(edges.map((e) => e.target));
	const roots = nodes.filter((n) => !targets.has(n.id));
	return roots.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
}

/**
 * Merge committed drag positions into the spec's `layout.nodes`, preserving
 * existing layout edges and per-node metadata (e.g. `collapsed`). Positions are
 * rounded to integers so TOML diffs stay clean.
 *
 * Steps that were dragged but not yet in `layout.nodes` get a fresh entry.
 * Orphan `layout.nodes` entries (no matching step id) are pruned so a save
 * does not preserve dead positions for deleted steps. Changes for ids that
 * are not steps (the trigger node) are ignored.
 *
 * Returns the original spec reference when nothing meaningful changed.
 */
export function applyPositionCommits(
	spec: RoutineSpec,
	commits: ReadonlyArray<NodePositionChange>,
): RoutineSpec {
	const validSteps = new Set(spec.steps.map((s) => s.id));
	const prev = spec.layout?.nodes ?? {};
	const next: Record<string, { x: number; y: number; collapsed?: boolean }> = {};

	// Carry over existing entries (keyed by step id), pruning orphans.
	for (const [id, entry] of Object.entries(prev)) {
		if (!validSteps.has(id)) continue;
		next[id] = { ...entry };
	}

	let mutated = false;
	for (const change of commits) {
		if (!validSteps.has(change.id)) continue;
		const pos = change.position;
		if (!pos) continue;
		const x = Math.round(pos.x);
		const y = Math.round(pos.y);
		const existing = next[change.id];
		if (existing && existing.x === x && existing.y === y) continue;
		next[change.id] = existing ? { ...existing, x, y } : { x, y };
		mutated = true;
	}

	if (!mutated) return spec;

	const layout: RoutineLayout = {
		version: 1,
		nodes: next,
		...(spec.layout?.edges?.length ? { edges: spec.layout.edges } : {}),
	};
	return { ...spec, layout };
}

/** Run evidence stays on the canvas; its chooser uses the shared portal layer. */
function RunOverlayPicker({
	runs,
	selectedRunId,
	onSelect,
}: {
	runs: ReadonlyArray<RoutineRun>;
	selectedRunId: string | null;
	onSelect: (id: string | null) => void;
}): JSX.Element {
	return (
		<div className="pointer-events-auto absolute right-3 top-3 z-20 flex items-center gap-2">
			<span className="text-[12px] text-ink-3">Showing run</span>
			<NeoSelect
				value={selectedRunId ?? ""}
				onChange={(e) => onSelect(e.target.value || null)}
				className="neo-input max-w-[220px] truncate"
				size="sm"
				mono
				aria-label="Select run to overlay"
			>
				{runs.map((r) => (
					<option key={r.id} value={r.id}>
						{formatRunLabel(r)}
					</option>
				))}
			</NeoSelect>
		</div>
	);
}

function formatRunLabel(run: RoutineRun): string {
	const status = !run.endedAt
		? "running"
		: run.abortReason
			? "stopped"
			: run.exitCode === 0
				? "ok"
				: "failed";
	const date = new Date(run.startedAt);
	const pad = (n: number): string => n.toString().padStart(2, "0");
	const stamp = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return `${stamp} · ${status}`;
}
