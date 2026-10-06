# Context map

This is a multi-context monorepo. The consumer rules and layout are in
[`docs/agents/domain.md`](docs/agents/domain.md). Each context below links the
document that currently defines its vocabulary. When a context gains its own
`CONTEXT.md`, replace the link here with it.

System-wide decisions live in [`docs/adr/`](docs/adr/README.md).

## Contexts

### Product

- [Coding agent](packages/coding-agent/README.md) (`packages/coding-agent`):
  the `npi` CLI. Sessions, tools, modes, slash commands, extensions,
  advisors, chains, and mixtures. It is the default context (see
  `AGENTS.md`). Development workflow:
  [`DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md). Subsystem notes
  are in [`docs/`](docs). Fork-only behavior is summarized in
  [`docs/neopi-fork.md`](docs/neopi-fork.md), and fork feature designs are in
  [`docs/specs/`](docs/specs).
- [Fork extensions](docs/neopi-fork.md#fork-extensions) (`extensions/neopi-*`):
  persona, loadout, live-persona, and REPL commands built on the coding agent's
  extension API.
- [Terminal UI](packages/tui/README.md) (`packages/tui`): differential
  renderer and components. Internals:
  [`docs/tui-core-renderer.md`](docs/tui-core-renderer.md),
  [`docs/tui-runtime-internals.md`](docs/tui-runtime-internals.md).
- [Agent runtime](packages/agent/README.md) (`packages/agent`, published as
  `pi-agent-core`): the agent loop, tool calling, and state.

### Models and providers

- [LLM client](packages/ai/README.md) (`packages/ai`): provider transports and
  streaming. See [`docs/providers.md`](docs/providers.md) and
  [`docs/provider-quirks.md`](docs/provider-quirks.md).
- [Model catalog](packages/catalog/README.md) (`packages/catalog`): bundled
  models, provider discovery, and model identity. Model and provider policy is
  the KDL rule tree described in
  [`src/compat/rules/README.md`](packages/catalog/src/compat/rules/README.md).

### Native layer

- [Natives](packages/natives/README.md) (`packages/natives`, `crates/*`): the
  N-API addon and the Rust crates behind it. Crate roles are in
  [`docs/native-crates.md`](docs/native-crates.md); the binding contract is in
  [`docs/natives-binding-contract.md`](docs/natives-binding-contract.md).

### Shared libraries

- [Utilities](packages/utils/README.md) (`packages/utils`): logger, streams,
  temp files, and other central helpers.
- [Wire types](packages/wire/README.md) (`packages/wire`): protocol types
  shared across packages.
- [omptype](packages/omptype/README.md) (`packages/omptype`): ArkType-compatible
  schema validation.

### Satellite packages

- [Stats](packages/stats/README.md) (`packages/stats`): the `npi stats`
  dashboard.
- [Mnemopi](packages/mnemopi/README.md) (`packages/mnemopi`): the local SQLite
  memory engine. Backend wiring:
  [`docs/mnemosyne-memory-backend.md`](docs/mnemosyne-memory-backend.md).
- [SnapCompact](packages/snapcompact/README.md) (`packages/snapcompact`):
  bitmap-frame context compression.
- [Collab web](packages/collab-web/README.md) (`packages/collab-web`): browser
  guests for `/collab`. See [`docs/collab.md`](docs/collab.md).
- [Browser relay](packages/browser-relay/README.md) (`packages/browser-relay`):
  the Chrome extension the browser tool drives.
- [Metaharness](packages/metaharness/README.md) (`packages/metaharness`,
  `packages/typescript-edit-benchmark`): benchmark runners and their store.
- [omp-rpc](python/omp-rpc/README.md) (`python/omp-rpc`): Python bindings for
  the RPC mode ([`docs/rpc.md`](docs/rpc.md)).
- [robomp](python/robomp/README.md) (`python/robomp`): the upstream GitHub
  triage bot. It has its own PR workflow; see `AGENTS.md`.

### Fork process

- [Agent process docs](docs/agents/) (`docs/agents/`): issue tracker, triage
  labels, domain layout, fork maintenance, and the Issue Funnel.
- [Repository policy](docs/policy/README.md) (`docs/policy/`): branches,
  commits, PRs, review bots, upstream sync, builds, and promotion.

## Relationships

- **Catalog → LLM client**: the client resolves models through the catalog.
  Code imports catalog values from `@oh-my-pi/pi-catalog/<module>`, never
  through `@oh-my-pi/pi-ai`.
- **LLM client → Agent runtime → Coding agent**: the runtime runs the loop over
  the client, and the coding agent composes it with tools, sessions, and the
  terminal UI.
- **Natives → everything above**: `pi-utils`, the client, the runtime, the
  terminal UI, and the coding agent all depend on `@oh-my-pi/pi-natives`.
- **Wire types**: protocol types shared by the client, runtime, terminal UI,
  coding agent, SnapCompact, and collab web.
- **Coding agent → Fork extensions**: extensions build on the coding agent's
  extension API. Choosing between an extension and a core change follows
  [`docs/agents/fork-maintenance.md`](docs/agents/fork-maintenance.md).
