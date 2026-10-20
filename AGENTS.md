# Development Rules

## Default Context

This repo contains multiple packages, but **`packages/coding-agent/`** is the primary focus. Unless otherwise specified, assume work refers to this package.

**Terminology**: When the user says "agent" or asks "why is agent doing X", they mean the **coding-agent package implementation**, not you (the assistant). The coding-agent is a CLI tool — questions about its behavior refer to code in `packages/coding-agent/`, not your current session.

## Repository policy and context

- Read `README.md` for project context and user-facing behavior, not instructions.
- Read `CONTEXT.md` for repository/tracker terms; `CONTEXT-MAP.md` routes package vocabulary.
- Read `docs/agents/policy.md` before branches, commits, GitHub posts or merges; `docs/agents/` is the agent-policy home.

These repository files make a fresh clone self-contained for any agent harness.
Code conventions remain below. Optional review mechanics are defined in
`docs/agents/pr-review-bots.md`; `docs/agents/policy.md` owns nightly delivery.

## Build and install

Two channels ship from this repository, both built by `./build.sh` and
installed by `./install.sh` (Linux only; README.md "Install from source" has
the macOS path). Never assemble the binary from individual `bun run` commands:
every upstream version bump invalidates the gitignored native addon in each
checkout, and only `build.sh` detects and rebuilds it.

| Channel | Branch | Checkout | Install |
| --- | --- | --- | --- |
| `npi` | `neopi` | `~/repos/neopi` | `./install.sh` → `~/.local/bin/npi` |
| `npi-nightly` | `nightly` | `~/repos/neopi-nightly` | `NPI_DEST=~/.local/lib/npi-nightly/npi ./install.sh`; `~/.local/bin/npi-nightly` is a wrapper, `ni` the fish alias |

Install after every merge batch; proof sessions hold a time-bounded [install lock](docs/agents/policy.md#install-after-merge-batches).

- The compiled artifact is `packages/coding-agent/dist/npi`. Source runs use
  `bun run dev` or `bun --cwd=packages/coding-agent src/cli.ts`.
- The fork's operator commands (`/persona`, `/loadout`, `/repl`, `/kernel`)
  are built in; no extension deployment step.
- Never install this fork through a remote installer, a global package
  manager, `bun setup`, or `scripts/link-omp.sh`.
- Stage a throwaway install with `NPI_DEST=<temp>/bin/npi PI_CODING_AGENT_DIR=<temp>/agent ./install.sh`.

## Fork maintenance

Before adding fork behavior, integrating upstream, or rebasing a fork PR, read
`docs/agents/fork-maintenance.md` for extension-first placement and compatibility
checks. Before synchronizing an upstream release, read and follow
`docs/agents/upstream-sync.md`.

Exact argv `npi update` launches the fork-specific interactive update session
from `packages/coding-agent/src/prompts/npi-update.md`; the executable basename
and exact argument list gate that rewrite. `npi update --check`,
`npi update --help`, and any additional arguments keep the ordinary
update-command behavior.


### Package Structure

| Package                 | Description                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `packages/ai`           | Multi-provider LLM client with streaming support                                        |
| `packages/catalog`      | Model catalog: bundled models.json, provider descriptors, model identity/classification |
| `packages/agent`        | Agent runtime with tool calling and state management                                    |
| `packages/coding-agent` | Main CLI application (primary focus)                                                    |
| `packages/tui`          | Terminal UI library with differential rendering                                         |
| `packages/natives`      | Bindings for native text/image/grep operations                                          |
| `packages/stats`        | Local observability dashboard (`npi stats`)                                             |
| `packages/omptype`      | ArkType-compatible schema validation with a lazy JIT runtime                            |
| `packages/utils`        | Shared utilities (logger, streams, temp files)                                          |
| `crates/pi-natives`     | Rust crate for performance-critical text/grep ops                                       |

**Catalog import convention**: code in this repo imports catalog _values_ (bundled models, model-thinking helpers, identity, descriptors, model manager/cache) from `@oh-my-pi/pi-catalog/<module>` — never via `@oh-my-pi/pi-ai`. The pi-ai barrel re-exports only the model/effort _types_ its own signatures use (`Model`, `Api`, `ThinkingConfig`, `Effort`, …); type-only imports of those from `@oh-my-pi/pi-ai` are fine.

## GitHub

Posting, commenting, filing issues, and merging follow the workspace policy;
nothing here requires confirmation beyond it. Repository specifics:

- Contributor PRs (any author other than the owner) are read-only on the
  owner's machine: never run their code locally. `docs/agents/pr-review-bots.md`
  › Running PR code has the owner-head test.
- PR bodies use `.github/PULL_REQUEST_TEMPLATE.md` as the workspace policy
  requires. User-facing changes follow the [Changelog](#changelog)
  attribution rules.
- The Issue Funnel seat (`IssueFunnel` / Rue) publishes and amends issues per
  `docs/agents/issue-funnel.md`.


## Code Quality

- No `any` unless absolutely necessary.
- **NEVER use `ReturnType<>`** — use the actual type name.
- **NEVER use inline imports** — no `await import()`, no `import("pkg").Type` in type positions, no dynamic type imports. Always top-level.
- Check `node_modules` for external API types instead of guessing.
- **Barrel exports**: prefer `export * from "./module"` over named re-exports, including `export type { ... } from`. In pure `index.ts` barrels, use star re-exports even for single-specifier cases. If stars create ambiguity, remove the redundant export path; do not keep duplicates.
- **Class privacy**: use ES `#private` fields; leave externally accessible members bare. **No `private`/`protected`/`public` keyword on fields or methods**, except on **constructor parameter properties** where TypeScript requires it (e.g. `constructor(private readonly session: ToolSession)`).
- **Promises**: use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)`.
- **Prompts**: never build prompts in code (no inline strings, template literals, or concatenation). Prompts live in static `.md` files; use Handlebars for dynamic content. Import them via `import content from "./prompt.md" with { type: "text" }` — not `readFile`.
- **Judge questions**: one JSON file per feature (`src/prompts/judge/<feature>.json`) maps question ids to `{ instructions, criteria? }`. Load it with `judgeQuestions(file)` from `@oh-my-pi/pi-ai`; fill Handlebars instructions with `renderQuestion(question, context)`. `criteria` sets the kind: a list of levels → score, omitted or `true`/`false` keys only → yes/no, any other labels → choice (`{}` when the caller supplies the labels). Choice labels and answer types come from the JSON keys.
- **Worker scripts**: workers re-enter the CLI entrypoint; never spawn separate worker entry modules. `cli.ts` declares itself as the worker host at startup (`declareWorkerHostEntry()` from `@oh-my-pi/pi-utils/env`) and dispatches hidden argv selectors (`__omp_worker_stats_sync`, `__omp_worker_tab`, `__omp_worker_js_eval`, `__omp_worker_tiny_inference`) before loading the command registry. Spawn sites use:
  ```ts
  import { workerHostEntry } from "@oh-my-pi/pi-utils";
  const hostEntry = workerHostEntry();
  const worker = hostEntry
  	? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_<name>"] })
  	: new Worker(new URL("./<worker>.ts", import.meta.url).href, { type: "module" });
  ```
  When the process was started from the npi CLI — source `cli.ts`, npm-bundle `dist/cli.js`, or compiled binary — `workerHostEntry()` is `Bun.main` and the worker re-enters the single entry module, so no per-worker `--compile` entrypoints or bundle entries exist. Outside a CLI host (`bun test`, SDK embedding, standalone `omp-stats`) it returns `null` and the direct-module fallback loads the worker source. New worker kinds MUST add their selector to the dispatch table in `cli.ts` and keep the fallback branch.
  History: `with { type: "file" }` only copied the entry as a raw asset (workers crashed silently in compiled binaries — issues #1011, #1027), and the later literal-path + extra-entrypoint pattern required keeping spawn literals and two build scripts in sync (issue #1150). The smoke probe below is the live validation of this contract.
  Validate any new worker with the dedicated smoke probe: `npi --smoke-test` spawns the stats sync worker and the tiny-model subprocess, pings them, and exits — it's wired into `ci:test:smoke` and `scripts/install-tests/run-ci.sh` so binary, source-link, and tarball installs all exercise it. Add a sibling smoke if the new worker is on a different module graph.

## Central Utilities

Before writing a helper, check whether one already exists — `packages/coding-agent/src/utils/`, `@oh-my-pi/pi-utils`, `@oh-my-pi/pi-tui`, and the domain modules next to your callsite. This applies to **everything**: VCS wrappers, formatting/truncation/path-display helpers, image handling, clipboard, streams, temp files, caching. The central versions carry hardening a fresh copy always loses (timeouts, output caps, non-interactive env, lock avoidance, caching, TUI sanitization).

- Search first: `grep` for the operation before implementing it. Two implementations of the same thing is a bug even when both work.
- Examples of the pattern: `@oh-my-pi/pi-natives/vcs` and `src/utils/active-repo-context.ts` are the only sanctioned way to run git/jj (`import * as vcs from "@oh-my-pi/pi-natives/vcs"` — never hand-spawn via `$`/`Bun.spawn`); rendering goes through the helpers in TUI Sanitization below (`replaceTabs`, `truncateToWidth`, `shortenPath`, `PREVIEW_LIMITS`) rather than ad-hoc string math.
- Missing capability? Extend the central helper (new option, new sub-function on the namespace) and call it — don't fork its logic locally.

## Bun Over Node

Use Bun APIs where they provide a cleaner alternative; fall back to `node:*` only for what Bun doesn't cover. **Never spawn shell commands for operations with proper APIs** (e.g., don't `Bun.spawnSync(["mkdir", "-p", dir])` — use `mkdirSync`).

### Quick reference

| Operation       | Use                                       | Not                                |
| --------------- | ----------------------------------------- | ---------------------------------- |
| File read/write | `Bun.file()`, `Bun.write()`               | `readFileSync`, `writeFileSync`    |
| Spawn process   | `` $`cmd` ``, `Bun.spawn()`               | `child_process`                    |
| Sleep           | `Bun.sleep(ms)`                           | `setTimeout` promise               |
| Binary lookup   | `$which("git")` from `@oh-my-pi/pi-utils` | `spawnSync(["which", "git"])`      |
| HTTP server     | `Bun.serve()`                             | `http.createServer()`              |
| SQLite          | `bun:sqlite`                              | `better-sqlite3`                   |
| Hashing         | `Bun.hash()`, `Bun.password.*`, WebCrypto | `node:crypto`                      |
| Path resolution | `import.meta.dir`, `import.meta.path`     | `fileURLToPath` dance              |
| JSON5           | `Bun.JSON5.parse()` / `.stringify()`      | `json5` package                    |
| JSONL           | `Bun.JSONL.parse()` / `.parseChunk()`     | `text.split("\n").map(JSON.parse)` |
| String width    | `Bun.stringWidth()`                       | `get-east-asian-width`, custom     |
| Text wrapping   | `Bun.wrapAnsi()`                          | custom ANSI-aware wrappers         |

### Process execution

Prefer Bun Shell (`` $`cmd` ``) for simple commands:

```typescript
import { $ } from "bun";

const result = await $`git status`.cwd(dir).quiet().nothrow();
if (result.exitCode === 0) {
	const text = result.text();
}

$`do-stuff ${tmpFile}`.quiet().nothrow(); // fire and forget
```

Methods: `.quiet()`, `.nothrow()`, `.text()`, `.cwd(path)`.

Use `Bun.spawn`/`Bun.spawnSync` only for: long-running processes (LSP, kernels), streaming stdin/stdout/stderr (SSE, JSON-RPC), or process control (signals, kill, complex lifecycle).

When using `pipe` mode, cast the stream:

```typescript
const child = Bun.spawn(["cmd"], { stdout: "pipe", stderr: "pipe" });
const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
```

### Node module imports

Always use **namespace imports** for `node:fs`, `node:path`, `node:os`:

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
```

- Async-only file → `node:fs/promises`.
- Needs both sync and async → `node:fs`, then `fs.promises.xxx` for async.

### File I/O

Prefer Bun:

```typescript
const text = await Bun.file(path).text();
const data = await Bun.file(path).json();
await Bun.write(path, data); // auto-creates parent dirs
```

Use `node:fs/promises` for directory ops (`fs.mkdir`, `fs.rm`, `fs.readdir`) — Bun has no native directory APIs. Avoid sync APIs in async flows; use sync only when forced by a synchronous interface.

**Anti-patterns:**

- `existsSync`/`readFileSync`/`writeFileSync` in async code → `Bun.file()` APIs.
- `mkdir(dirname(path), …)` before `Bun.write(path, …)` → redundant; `Bun.write` handles it.
- `if (await file.exists()) { await file.json() }` → two syscalls plus race. Use try-catch with `isEnoent`:
  ```typescript
  import { isEnoent } from "@oh-my-pi/pi-utils";
  try {
  	return await Bun.file(path).json();
  } catch (err) {
  	if (isEnoent(err)) return null;
  	throw err;
  }
  ```
- Multiple `Bun.file(path)` handles for the same path (including across `checkX`/`loadX` helpers).
- `Buffer.from(await Bun.file(x).arrayBuffer())` → `await fs.readFile(path)`.
- Existence check + try-catch around the same read → drop the existence check.

### Streams

Prefer centralized helpers:

```typescript
import { readStream, readLines } from "./utils/stream";
const text = await readStream(child.stdout);
for await (const line of readLines(stream)) {
	/* ... */
}
```

Manual reader loops only when the protocol requires it (SSE, streaming JSON-RPC).

### Misc

- **Sleep**: `await Bun.sleep(ms)`, never `new Promise(r => setTimeout(r, ms))`.
- **Password hashing**: `Bun.password.hash(pw, "bcrypt")` / `Bun.password.verify(pw, hash)`.
- **String width**: `Bun.stringWidth(text, { countAnsiEscapeCodes?: false })`.
- **Wrapping**: `Bun.wrapAnsi(text, width, { wordWrap, hard, trim })`.

## Model/Provider Policy Lives in KDL

**NEVER hard-code model- or provider-conditional policy in TypeScript.** No `id.includes("claude")`, no model-name regexes, no per-model lookup tables (effort ladders, pricing, context windows, modalities, API routing, quirk flags). All of it belongs in the KDL rule tree at `packages/catalog/src/compat/rules/`, compiled by `bun run gen:compat` into the committed `rules.json` and resolved at build time via `resolveModelPolicy`/`buildModel`.

Ownership strata (see `src/compat/rules/README.md`):

- `taxonomy/*.kdl` — identity: class membership, families, revision extraction, reviewed overrides, suffix collapse.
- `classes/*.kdl` — model-lineage truths (behavior inherent to a model line, on any host).
- `providers/*.kdl` — deployment contracts (behavior a host imposes), plus documented exact-id residue.
- `runtime/behavior.kdl` — heuristics that run before/outside exact model lookup (`api-routes`, `model-limits`, `exclude-models`, `pricing-peer`, hosted defaults).

Rules for TS code:

- Branching on model identity in TS is allowed **only** through structured facts from `classifyModel()` (`class`/`family`/`revision`/effort facts) — never through string matching on ids, and prefer a KDL axis when one can express the policy.
- Discovery mappers map authoritative upstream fields as reported; seed neutral values only for fields the upstream omits or misreports **and** KDL explicitly owns via a correction axis (`input-modalities`, `cost-patch`, `limits-patch`, `context-window-floor`, thinking axes). Assert rule-owned corrections through `buildModel`; raw discovery specs remain the right assertion surface for parsing/normalization contracts.
- An id that no selector can isolate gets an exact-id `models` residue rule with a comment — never a special case in TS.
- Equal-rank rule overlaps throw `AmbiguousOverlapError` at resolve time; fix with an explicit `priority=` in KDL, not code.
- After editing rules: `bun run gen:compat` and commit `rules.json` alongside the `.kdl` change.

## Generated Files

**NEVER edit `packages/catalog/src/models.json` directly.** It is generated from upstream sources (stencil.so, provider catalog discovery, OpenCode docs) by `packages/catalog/scripts/generate-models.ts` and the descriptors/resolvers in `packages/catalog/src/provider-models/`. Hand-edits get overwritten on the next regen. The same applies to `packages/catalog/src/compat/rules.json`, compiled from the KDL tree by `bun run gen:compat`.

To change an entry, fix the source:

- **Model/provider policy** (identity, thinking ladders, wire quirks, modality/limit/pricing corrections, API routing, roster exclusions) → the KDL tree in `packages/catalog/src/compat/rules/` (see the section above).
- **Provider catalog entries** (default model, discovery factory/flags) → the `CATALOG_PROVIDERS` table in `packages/catalog/src/provider-models/descriptors.ts`.
- **Discovery/request plumbing** (endpoint shapes, auth, response parsing) → the mappers in `packages/catalog/src/provider-models/openai-compat.ts`.
- **Generator wiring** (upstream merges, premium multipliers, post-processing order) → `packages/catalog/scripts/generate-models.ts`.

Regenerate with `bun run gen:compat` and/or `bun run gen:models` and commit the generated files alongside the source change. Add a regression test against the **rule/descriptor/mapper**, not the bundled JSON, so it survives upstream metadata shifts.

## Logging and CLI Output

Code that may run while the TUI, RPC, SDK, workers, or background runtimes are active MUST NOT use `console.log`/`error`/`warn`; it corrupts rendering or protocols. Use the centralized logger:

```typescript
import { logger } from "@oh-my-pi/pi-utils";

logger.error("MCP request failed", { url, method });
logger.warn("Theme file invalid, using fallback", { path });
logger.debug("LSP fallback triggered", { reason });
```

Logs go to `~/.omp/logs/npi.YYYY-MM-DD.log` with automatic rotation. Standalone CLI commands that exit without entering the TUI MAY use `console.*` or process streams for intentional user-facing output. Keep structured stdout clean. This exception is semantic, not filename-based; shared code must use `logger` or an explicit output sink.

## Menu Navigation

Every menu, picker, overlay, and list surface opens in normal navigation. Keys resolve through `MenuKeyReader` and the viewport through `MenuViewport` (`packages/tui/src/components/menu-navigation.ts`); `SelectList` is the reference consumer. Arrows, PageUp/PageDown, Home/End, Enter, and Esc keep working beside the Vim keys.

| Keys | Meaning in normal navigation |
| --- | --- |
| `j`/`k` | Next/previous row. |
| `h`/`l` | Context-dependent: switch pane, collapse/expand, reorder, or adjust a value (effort). Pick one meaning per surface and show it in the hint line. |
| `Ctrl-d`/`Ctrl-u` | Half page down/up. PageDown/PageUp: full page. |
| `gg`/`G` | First/last row. |
| `Ctrl-e`/`Ctrl-y` | Scroll the view one line; the selection stays where it is. |
| `Space` | Toggle a checkbox, or soft-activate (preview without closing). |
| `Tab`/`Shift-Tab` | Next/previous context: tab, section, or focus region. |
| `/` | Focus the surface's filter or search field. |
| `Ctrl-o`/`Ctrl-i` | Back/forward through the menu history (`Alt-o` is the forward fallback where the terminal sends Tab for `Ctrl-i`). |

Text input is the exception. Focused fields keep printable keys and editing bindings literal. Search/filter fields use `MenuSearchField`: Enter confirms and retains the pattern without activating a result; Esc clears it and returns to navigation. Navigation keys MUST stay in the field while editing. `/` refocuses the active pattern. Ordinary patterns remain fuzzy; `/`-prefixed and `re:` patterns share the Vim translator in `menu-search.ts`, very-magic by default (`\m` selects default-magic), including inline errors and no matches for invalid regex. See [Menu search](docs/keybindings.md#menu-search) for the dialect. Rename/form fields retain their own submit/cancel contracts; the composer is out of scope.

Before binding a single printable key on a menu surface, check the table: a surface action that collides with a navigation key moves to another key rather than shadowing navigation. Leave a key unbound where its meaning would be nonsensical for that surface instead of forcing parity, and record the decision in the issue's menu inventory. Opening a single-instance menu goes through `SelectorController`'s menu registry so the menu history can return to it with its state.

## TUI Sanitization

All text displayed in tool renderers must be sanitized. Raw content (file contents, error messages, tool output) breaks terminal rendering: tabs → visual holes, long lines → overflow, paths → leak home directory.

**Rules:**

- **Tabs → spaces** via `replaceTabs()` (from `@oh-my-pi/pi-tui` or `../tools/render-utils`).
- **Truncate** lines with `truncateToWidth()` / `ui.truncate()`. Use `TRUNCATE_LENGTHS` constants.
- **Shorten paths** with `shortenPath()` (replaces home with `~`).
- **Preview limits** from `PREVIEW_LIMITS`. No ad-hoc numbers.

**Apply to every render path**, not just the happy one:

- Success output (file previews, command output, search results).
- **Error messages** — these often embed file content (e.g., patch failure messages include unmatched lines). If a message contains file content, it needs `replaceTabs()`.
- Diff content (added and removed).
- Streaming previews.

### Streaming tool previews

Tool-call previews can have **multiple render paths**. If you add preview-only fields or depend on partially streamed args, update every path — not only the final renderer. Streamed argument buffers decode into display args via `decodeStreamedToolArgs` / `ToolArgsRevealController` (`modes/controllers/tool-args-reveal.ts`); both the live event path and transcript rebuilds must go through them — never spread provider-parsed `arguments` next to a raw `__partialJson` (parsed args lag the stream by a throttled parse window).

For the bash tool specifically:

- The pending preview may need raw `partialJson`, not just parsed `arguments`. Parsed args lag until a JSON object closes, which makes inline env assignments appear only at the end.
- Preserve preview-only fields (e.g. `__partialJson`) through `event-controller.ts`, transcript rebuilds in `ui-helpers.ts`, and merged call/result rendering in `tool-execution.ts`. Missing one path causes inconsistent previews.
- `ToolExecutionComponent.#buildRenderContext()` for bash must work even before a result exists — the renderer uses call args plus render context to show the command preview while streaming.
- Verify both live streaming and rebuilt transcript paths after any bash preview change. A fix in one path does not fix the other.

## Commands

- Never use `tsc`/`npx tsc` — always `bun check`.
- Never run `cargo test` directly for Rust tests — use `bun run test:rs`. It runs `cargo nextest run` (config: `.config/nextest.toml`) followed by a `cargo test --doc` pass, because nextest does not execute doctests. The doctest pass runs every runnable doctest in the workspace's lib crates; today that is tree-sitter-go's one example (pi-natives is a `cdylib`, which rustdoc skips; pi-builtins' examples are `ignore`d vendored uutils docs).
- **Cargo parallelism**: always pass `-j 6` to cargo builds (e.g. `cargo build -j 6`,
  `bun run build:native` should use `CARGO_BUILD_JOBS=6`). The machine has 20 cores;
  unbounded cargo eats all of them and starves the session.

## Rust Build Profiles

Profiles live in the root `Cargo.toml`; `.cargo/config.toml` carries the settings Cargo.toml cannot express. Both are committed, so no local `~/.cargo/config.toml` is required.

| Profile | Use |
| --- | --- |
| `dev` | Default. Line tables for our crates, no debuginfo for deps, deps at `opt-level = 2`. |
| `release` | Shipping build: fat LTO, 1 codegen unit, stripped. |
| `local` | Fast local release iteration: thin LTO, 16 codegen units, incremental. |
| `profiling` | `release` codegen with symbols kept, for `perf`/`samply`/Instruments. |
| `ci` | Thin LTO, no debuginfo, stripped. |

**Never set `split-debuginfo = "off"` on a profile that has debuginfo.** On Mach-O the linker never merges DWARF into the executable — it writes a debug map (`N_OSO`) pointing at the `.o` files, and `"unpacked"` is what keeps those files. With `"off"` every backtrace frame in our own crates silently loses `file:line`; the `panicked at foo.rs:3` header still prints (that is `#[track_caller]`, not debuginfo), which makes the loss easy to miss. `ci` may use `"off"` only because it sets `debug = false`.

`embed-metadata = false` (in `.cargo/config.toml`) keeps crate metadata in `.rmeta` instead of duplicating it into every rlib — measured 196 MB → 130 MB on a reqwest-sized graph at identical build times. Its accepted spelling is toolchain-coupled; keep it in sync with `rust-toolchain.toml`.

Rejected, with measurements, so nobody re-litigates them: **sccache** (cannot cache incremental, bin, or proc-macro crates — measured slower than not using it), **mold** (ELF-only; no Mach-O support), and **`panic = "abort"` on `dev`** (Cargo ignores `panic` for the test profile, so the whole dep graph builds twice — 131 MB → 214 MB).

## Testing Guidance

The harness system prompt already carries the general test filter (contract-level, name the failure mode, no echoes/tautologies/source text). Repository rules on top of it:

- Tests **must be full-suite safe**, not just file-local safe. No long-lived file-wide mutations of `Bun.*`, `process.platform`, `process.env`, or `Bun.env` when a narrower seam exists. Prefer per-test `vi.spyOn(...)` with `vi.restoreAllMocks()` in `afterEach`. A test that passes alone but poisons later files is broken.
- **Never use `mock.module()`**. Bun's `mock.module()` mutates the global module registry and leaks across files ([oven-sh/bun#12823](https://github.com/oven-sh/bun/issues/12823)). Use `spyOn` on the imported module object instead. For pass deps, import the pass and spy on `.run`. For package deps, namespace-import and spy on the exported function.
- **Never source-grep.** A test that reads an implementation file (`.ts`/`.rs`/build script) and asserts on its _text_ (`expect(src).toContain("someCall()")`, `.toMatch(/import .../)`, "comment must say X") is banned: it breaks on harmless refactors and passes while the behavior is broken. Assert the observable contract, use the runtime smoke probe for wiring you cannot exercise in-process, and enforce structural invariants (no value-import of X, no self-import) with a type test or an oxlint rule. Reading a file your code _wrote_ and asserting on that output is fine.
- Compile-time guarantees → type checks/type tests, not runtime placeholders.
- For error handling, trigger the real failure path and assert the surfaced contract; don't instantiate error classes directly or inspect internal metadata.
- Smoke tests are acceptable only when they catch a failure mode narrower tests would miss. "Package boots" or "command starts" alone is not enough.
- Don't duplicate coverage across abstraction levels; if an integration test proves the behavior, drop the unit test that restates it through mocks.
- Prefer focused package-local verification for the changed area.

## Changelog

Location: `packages/*/CHANGELOG.md` (per package).

**Format** — sections under `## [Unreleased]`:

- `### Breaking Changes` (first if present)
- `### Added`
- `### Changed`
- `### Fixed`
- `### Removed`

**Rules:**

- New entries always go under `## [Unreleased]`.
- Entries are one line, brief, and user-facing: lead with what the user will see or can now do. Root-cause narration and implementation detail belong in the commit/PR, not the changelog.
- Never modify already-released sections (e.g., `## [0.12.2]`) — they are immutable.
- Don't flag changelog section order or formatting in reviews or PRs — `bun run fix:changelogs` normalizes everything automatically.

**Attribution:**

- Fork issues: `Fixed foo bar ([#123](https://github.com/PsychedelicShayna/neopi/issues/123))`. Entries carried in from upstream keep their `can1357/oh-my-pi` links.
- External contributions: `Added feature X ([#456](https://github.com/PsychedelicShayna/neopi/pull/456) by [@username](https://github.com/username))`.

## Releasing

This fork does not publish to npm; `bun run release` is upstream's flow and is never run here. Promotion of `nightly` into `neopi` follows `docs/agents/policy.md` › Promotion and issue completion. Version bumps arrive through upstream syncs.

## Agent skills

### Issue tracker

Issues and specs are tracked in `PsychedelicShayna/neopi` GitHub Issues. See
`docs/agents/issue-tracker.md`.

### Triage labels

Before classifying or reconciling issues and PRs, read `docs/agents/triage.md`;
`docs/agents/triage-labels.md` defines composable label meanings.

### Domain docs

Use the multi-context layout rooted at `CONTEXT-MAP.md`. See
`docs/agents/domain.md`.

### PR review bots

Before requesting review or assessing merge eligibility, read
`docs/agents/pr-review-bots.md` for optional large-blast-radius review, descriptive
labels and the owner-head safety rule. CI and review never gate nightly merges.
