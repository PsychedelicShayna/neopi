# Routines Visual Canvas Builder

> Historical canvas design proposal. The implemented builder now uses
> `spec-toml.ts` and direct `RoutineSpec` TOML in `spec_toml`; its source editor,
> save preview and bundled templates are native TOML. YAML snippets below
> describe the original proposal, not the current authoring contract. See
> [the current tutorial](../routines-v1-tutorial.md).

## Problem

The current V1 routines builder is correct but not ambitious enough: it is a schema-driven form editor for a linear YAML pipeline. That gets users off raw YAML, but it still feels like editing blocks in a narrow admin form. It does not match the interaction model people expect from an automation builder: visual nodes, handles, connections, branches, and clear data flow.

The reference direction is closer to `my-org-viewer`: a dark grid canvas with node cards for `agent`, `write`, `run`, `read/http`, `if`, visible connector handles, and explicit curved edges.

## Goal

Ship a first-class visual routine builder where users compose routines as a graph:

- drag/create typed nodes (`run`, `agent`, `write`, `http/read`, `transform`, `wait`, `set_state`, `mcp`, `if`)
- connect node outputs to downstream node inputs
- branch explicitly with `if` / condition nodes
- inspect/edit a selected node in a right-side property panel
- keep YAML as an export/debug surface, not the primary authoring mode
- preserve compatibility with existing V1 linear routines

## Non-goals

- Full BPMN/workflow engine semantics
- Arbitrary loops in V1 of the canvas
- Parallel fan-out execution in the first canvas release
- Replacing the YAML spec overnight
- Making `mcp` execution real before the SDK exposes a direct tool-call API

## Design direction

Use the existing deck theme, not a separate visual identity. The canvas can be richer than the rest of the app, but it should still use:

- IBM Plex Sans / Mono
- existing `paper`, `ink`, `line`, `accent`, `success`, `warn`, `danger` tokens
- flat borders, restrained fills, no ornamental display typography
- dark grid in Slate/Horizon, warm paper grid in Paper theme

The reference image's interaction model is right; its neon style should be translated into deck-native restraint.

## UX shape

### Top toolbar

Compact horizontal toolbar above the canvas:

```text
+ run   + agent   + write   + read/http   + if   + wait   + state   + mcp
```

Each button creates a node at the canvas center or at the current cursor position.

### Canvas

- pan and zoom
- dotted grid background
- nodes draggable
- selected node gets a stronger border + visible handles
- curved edges between node handles
- edge labels for branch outcomes (`true`, `false`, `success`, `error`) where relevant
- minimap optional later; not needed initially

### Node card shape

Each node has:

- colored type strip
- `TYPE id` header
- one-line summary of the most important field
- small badges for `when`, `retry`, `timeout`, `budget` if present
- input/output handles

Examples:

```text
AGENT research
You are the Outgoing Growth Researcher...
```

```text
WRITE write_summary
archive/reports/outgoing-growth-researcher-{{ run.date }}.md
```

```text
IF should_send
steps.digest.json.highPriority === true
true -> send_summary
false -> persist_state
```

### Property inspector

Clicking a node opens a side panel with the same schema-driven fields V1 already built, but scoped to a single selected node:

- common fields (`id`, `when`, `on_failure`, `retry`, `timeout_secs`)
- type-specific fields
- data preview from the last run (if available)
- validation errors for that node

This reuses most existing `StepCommonFields` + `StepForms` code, but moves it out of the main column and into a selected-node inspector.

### YAML tab

YAML remains available as:

- read/write source tab
- diff/debug surface
- export/import path

Invalid YAML disables canvas mode with the same parse/schema error treatment V1 already has.

## Runtime model options

There are two possible approaches.

### Option A — visual-only DAG over today's linear runner (recommended first cut)

Keep the engine as an ordered list of steps. The canvas stores node positions and edges as editor metadata; save compiles the graph into a valid linear `steps:` array plus `when:` gates.

Advantages:

- can ship without rewriting `v1-runner.ts`
- existing runs, step records, budget, concurrency, state all keep working
- YAML compatibility remains simple
- graph is an authoring layer, not a second runtime

Limits:

- no true parallel execution
- no loops
- branches compile to skipped steps, not separate control-flow blocks
- graph must be topologically sortable

This is the right first release.

### Option B — first-class graph execution engine

Extend `RoutineSpec` with nodes + edges and make the runner execute a DAG directly.

Advantages:

- real branching
- parallel fan-out/fan-in possible later
- runtime semantics match the UI exactly

Costs:

- migration story for linear V1 specs
- new scheduler semantics
- budget accounting changes
- step-run ordering changes
- more complicated retry/failure semantics

This should wait until the visual-only DAG proves the UX.

## Spec model: visual-only DAG metadata

Add optional `layout` metadata to `RoutineSpec` without changing runtime semantics:

```yaml
name: daily-briefing
trigger:
  - cron: "0 7 * * *"
layout:
  version: 1
  nodes:
    should_run: { x: 220, y: 160 }
    fetch_tasks: { x: 220, y: 320 }
    write_briefing: { x: 220, y: 640 }
  edges:
    - from: should_run
      to: fetch_tasks
      kind: success
    - from: should_run
      to: persist_state
      kind: false
steps:
  - id: should_run
    type: transform
    body: |
      return state.last_briefing_date !== run.date
  - id: fetch_tasks
    type: http
    when: steps.should_run.json === true
    method: GET
    url: http://127.0.0.1:8787/api/tasks
```

Protocol type:

```ts
export interface RoutineLayout {
  version: 1;
  nodes: Record<string, { x: number; y: number; collapsed?: boolean }>;
  edges: Array<{
    from: string;
    to: string;
    kind?: "success" | "error" | "true" | "false" | "manual";
    label?: string;
  }>;
}
```

Add optional `layout?: RoutineLayout` to `RoutineSpec` and schema.

## Branching model for first cut

Introduce a visual `if` node that compiles to an existing runtime step:

```yaml
- id: should_send
  type: transform
  body: |
    return steps.digest.json.highPriority === true
```

Downstream edges compile into `when:` gates:

```yaml
- id: send_summary
  type: agent
  when: steps.should_send.json === true

- id: persist_only
  type: set_state
  when: steps.should_send.json === false
```

So the first implementation does not require a new runtime step type. It is a visual affordance over `transform` + `when`.

Later, if needed, introduce a real runtime step:

```ts
type IfStep = RoutineStepCommon & {
  type: "if";
  condition: string;
}
```

But this is not required for the first canvas release.

## Graph compilation

When saving from canvas mode:

1. Validate all node IDs are unique.
2. Validate every edge references existing nodes.
3. Validate graph is acyclic.
4. Topologically sort nodes.
5. Emit `steps:` in topo order.
6. For branch edges from an `if` node, apply/merge `when:` expressions onto downstream nodes.
7. Preserve existing manually-authored `when:` by AND-ing:

```ts
existingWhen && branchWhen
```

Example:

```yaml
when: (steps.should_send.json === true) && (state.enabled !== false)
```

8. Save `layout.nodes` and `layout.edges` so the canvas reopens exactly as authored.

## Graph import from existing V1 routines

For existing linear routines with no `layout`:

1. Parse `steps` in order.
2. Place nodes vertically, 220px apart.
3. Infer sequential edges `step[i] -> step[i + 1]`.
4. If a step has `when:` containing `steps.<id>`, draw a secondary dependency edge from `<id>` to the step.
5. Mark inferred edges as `kind: "inferred"` internally, but do not persist that kind unless user edits graph.

This makes every existing V1 routine immediately open in canvas mode.

## Recommended library

Use React Flow (`@xyflow/react`) unless there is a strong reason not to.

Why:

- mature pan/zoom/canvas model
- custom nodes and custom edges
- fit-view, selection, handles, keyboard deletion built in
- good TypeScript support
- can be themed to deck tokens

Alternative: build on dnd-kit and SVG manually. Not recommended: it creates a small workflow editor framework from scratch.

## Component architecture

New files:

```text
apps/web/src/components/routines/canvas/
  RoutineCanvasBuilder.tsx
  RoutineCanvas.tsx
  nodes/
    StepNode.tsx
    IfNode.tsx
  edges/
    BranchEdge.tsx
  graph-compile.ts
  graph-import.ts
  graph-types.ts
  layout-utils.ts
```

Reuse existing files:

- `StepCommonFields.tsx`
- `StepForms.tsx`
- `TriggerPicker.tsx`
- `SettingsForm.tsx`
- `spec-yaml.ts`

Refactor needed:

- `StepForms.tsx` should expose one selected-node form render function without assuming card layout.
- `RoutineBuilder.tsx` becomes a mode switcher: `Canvas | Form | Spec`.
- Form mode remains as fallback/debug; Canvas becomes default.

## UI modes

Recommended tabs:

```text
Canvas | Form | Triggers | Settings | Spec
```

Canvas default for V1 routines.

Form mode is still valuable for:

- accessibility fallback
- small screens
- precise editing
- debugging graph compiler output

Spec remains source-of-truth/export.

## Validation

Canvas-level validation errors:

- duplicate node ID
- dangling edge
- cycle detected
- branch edge from non-if node with `true`/`false`
- node not reachable from any trigger/root
- disconnected component
- downstream branch would overwrite an existing incompatible `when:`

Errors render in a bottom strip and on affected nodes.

## Observability integration

V2 canvas should merge builder + run detail:

- after a run, each node shows last status color
- duration badge on each node
- token/cost badge on agent nodes
- output preview popover from `routine_step_runs.output_json`
- failed node pulses red; clicking opens stderr/error
- replay from node should pre-select that node in the RunDetailView

First release only needs static canvas editing; observability overlay can follow.

## Phased plan

### Phase 1 — Canvas as authoring layer

- Add `layout` optional field to protocol + schema.
- Add React Flow dependency.
- Render existing routines as imported vertical graph.
- Allow pan/zoom/drag nodes.
- Persist node positions into `layout.nodes`.
- Preserve existing form + spec tabs.

Acceptance:

- daily-briefing opens as 7 nodes connected in order.
- moving nodes and saving persists positions.
- no runtime behavior changes.

### Phase 2 — Node creation and property inspector

- Toolbar creates typed nodes.
- Clicking node opens property inspector using existing step forms.
- Add/delete nodes and edges.
- Save compiles to `steps:` order.

Acceptance:

- user can build a simple `agent -> write` routine entirely in canvas mode.
- YAML output validates and the routine runs.

### Phase 3 — Branching via visual if node

- Add `if` node in toolbar.
- `true`/`false` edge handles.
- Compile branch edges into downstream `when:` gates.
- Validate DAG + branch semantics.

Acceptance:

- user can build `if -> true: agent/write, false: set_state` flow.
- both branches are represented in YAML as `transform` + `when:`.
- run detail shows skipped branch steps as skipped.

### Phase 4 — Run overlay

- Overlay latest run status on nodes.
- Node click can show last output/error.
- Link node to run-detail step row.

Acceptance:

- after running daily-briefing, canvas nodes show success/skipped/failed state.

## Migration

No DB migration required for Phase 1 if `layout` lives inside `spec_yaml`.

Protocol/schema change required:

- add `RoutineLayout`
- add optional `layout` to `RoutineSpec`
- schema allows `layout.version = 1`, `nodes` map, `edges` array

Existing V1 routines without layout import automatically.

## Risks

- React Flow theming can drift from deck style. Mitigation: custom nodes only, no default bright palette.
- Branch compiler can silently change behavior. Mitigation: preview generated YAML diff before saving branch graphs.
- Graph cycles create impossible runtime order. Mitigation: hard validation before save.
- Existing `when:` expressions can be complex. Mitigation: branch compiler only ANDs onto downstream node and shows generated expression visibly.

## Decision

Build this as **Routines Canvas Builder (V2 visual mode)**, but implement it as a visual authoring layer over V1's linear runner first. Do not rewrite the engine until user demand proves that true DAG runtime semantics are necessary.
