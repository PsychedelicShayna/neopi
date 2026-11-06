# Configuration

npi-deck reads configuration from three layers, in priority order:

1. **Process environment** — values set in the launching shell (or systemd
   unit). Always win.
2. **Deck-managed `.env`** — file the deck writes when you save through the
   Settings → Env UI. Loaded into `process.env` at boot.
3. **Built-in defaults** — declared in
   `apps/server/src/config.ts` and `apps/server/src/env-schema.ts`.

The Settings → Env UI edits layer 2 only. It never overwrites layer 1: if you
launched the deck with `NPI_DECK_PORT=9000` in the shell, the Settings page
still shows port 9000 as the active value with source `process env`, and
saving a new value writes to the managed `.env` (where it will take effect
only after you remove the shell override and restart).

See [.env.example](../.env.example) for a copy-paste template with comments.

## The data dir

Everything the deck keeps lives in one directory: `~/.npi-deck`, or
`NPI_DECK_HOME` if set. `NPI_DECK_HOME` must come from the launching
environment; the managed `.env` lives inside the data dir, so it cannot move
it. The old `~/.omp-deck`, `~/.config/omp-deck` and `NPI_DECK_DATA_DIR`
locations are not read. `bun scripts/migrate-omp-deck.ts` copies that state
over on request; see [upgrading.md](./upgrading.md#070-dev--from-omp-deck-to-npi-deck).

The managed `.env` is `<data dir>/.env`. The same directory holds:

- `env-audit.log` — append-only `timestamp | key | action (set/unset/reveal)`.
  Values are never logged.
- `telegram-bridge.db` — chat→session map (only when the bridge runs).
- `deck.db` and `uploads/` — kanban, routines, inbox, pasted images.
- `config.toml` and `neopi/<sha>/` — backend trees and the active backend.
- `run/` — launcher lock, generation and owned-process journals.

## Variable reference

### Network

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `NPI_DECK_HOST` | `127.0.0.1` | yes | Bind host. Loopback by default — never `0.0.0.0` without an auth layer. |
| `NPI_DECK_PORT` | `1701` | yes | HTTP + WebSocket port. |
| `NPI_DECK_WEB_PORT` | `5173` | yes | Vite dev server port (dev only). Proxies `/api` and `/ws` to `NPI_DECK_PORT`. |
| `NPI_DECK_API_BASE` | derived | no | Loopback URL standalone bridge processes use. Derived from host+port when unset. |

### Workspaces

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `NPI_DECK_DEFAULT_CWD` | `process.cwd()` | next session | Working dir for new chat sessions. |
| `NPI_DECK_WORKSPACES` | _(none)_ | no | Comma-separated extra workspace roots shown in the picker. Managed from Settings → Workspaces, which checks each is an existing directory and applies the list at once. |

### Notifications

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `NPI_DECK_NOTIFICATIONS_DISABLED` | _(none)_ | no | Comma-separated notification sources the server does not emit: `routine_failed`, `task_shipped`, `auth_fallback`. Managed from Settings → Notifications. |

### Starters

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `NPI_DECK_STARTERS` | _(none)_ | Settings: no; hand edits: next launch | Comma-separated starters to install into the NeoPi agent dir, as `skills/<name>` or `extensions/<name>` (e.g. `skills/handoff,extensions/maintenance-gate`). Unset installs nothing. Managed from Settings → Starters, which installs a starter the moment you opt in; each launch with a backend loaded re-copies an opted-in starter that went missing. Opting out never deletes an installed copy. |
| `NPI_DECK_MAINTENANCE_GATE_DISABLED` | _(off)_ | no | Truthy silences the maintenance-gate extension in new sessions. Managed from its row in Settings → Starters. |
| `NPI_DECK_ORG_ROOT` | kb root while maintenance-gate is opted in | no | The deck generates it from the kb root only while the maintenance-gate starter is opted in and not disabled; the Env editor shows that as its default. A value saved in the Env editor overrides it at once and survives opting out; clearing it brings the generated root back while the starter is opted in. A value exported by the launching shell is never touched. |

Starters are opt-in. `NPI_DECK_INSTALL_STARTER_SKILLS` and `NPI_DECK_INSTALL_STARTER_EXTENSIONS`, which used to switch off the install-everything default, are retired: the deck ignores them and logs a line at launch when either is still set. An off value already matches the new behavior; an on value no longer installs anything, so opt in to the starters you want instead. Starters already in your agent dir stay there and show as "installed, not opted in" until you opt in or delete them. With no backend loaded the deck skips starters entirely.

### NeoPi SDK and new-chat models

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `PI_NO_TITLE` | _(unset)_ | next session | Set truthy to disable SDK auto-title generation. |

New deck chats without an explicitly selected model start on **Opus 5.5
(`medium`)**. The deck chooses the first authenticated provider: Anthropic,
GitHub Copilot, then OpenRouter. The only retry fallback is **GPT-6 Sol
(`medium`)**, preferring OpenAI Codex, then GitHub Copilot, then OpenRouter.
If no Sol provider is authenticated, the fallback still targets OpenAI Codex
and requires sign-in before it can serve a request. If no Opus provider is
authenticated, creating a new chat reports an error instead of silently
switching to an unrelated model.

This policy applies only to new deck chats. It does not rewrite NeoPi's
`config.toml`, affect CLI sessions or resumed chats, or replace an explicit
model selection in the chat header. `OMP_MODEL` and NeoPi's global default
model do not override the deck's new-chat default.

The Sol fallback is a session-local override on top of the chat's configured
`retry.fallbackChains`, re-applied after every settings reload so later
config.toml edits reach the chat. Once config.toml has a chain keyed by the
chat's Opus model (`provider/id`, with or without an effort suffix), that
chain replaces the deck's for this model. The deck's `default` chain stays in
force for other models the chat switches to. Edit the active model's chain
from the model picker's **Fallbacks** row, or in Settings → NeoPi.

### Model configuration and picker visibility

Open **Models** at `/models` for the connected NeoPi catalogue, global role
assignments and validated custom `models.toml` definitions. The conversation's
quick switcher selects a model; opening the Models workspace does not.
Role selectors such as `@default` stay selectors rather than being replaced
by whichever concrete model currently resolves them.

Role edits and non-secret NeoPi settings include the value read by the
browser. If another client changes that setting, the server rejects the
stale save. Reload before trying again. Custom model documents retain their
existing revision check and server-side validation. Project-scope role writes
and effort-rule editing require the newer native Models configuration API;
the pinned SDK does not expose them yet, and Deck leaves native rules intact.

NeoPi settings and custom models are native `config.toml` and `models.toml`.
Legacy YAML is read only for a one-time sibling import: it is never rewritten
or deleted, its permissions are retained on the new TOML file, and existing
TOML always takes precedence. The models document API uses `raw` for TOML text.
Settings GUI saves patch the existing TOML so unrelated top-level and nested
comments survive. The models raw editor preserves the document's untouched
source, but masks **all** comments as well as credentials: unchanged whole
comment placeholders restore the original comment verbatim; deleting one
deletes that comment, and newly written comments are saved as typed. Editing
part of a comment placeholder is rejected rather than risking disclosure.
Credential placeholders restore only as whole credential values (and URL
placeholders only as whole URLs); ambiguous masking withholds the document.

**Settings / Inference providers / Deck picker visibility** hides a provider
from Deck model pickers in this browser. It does not disable inference,
remove credentials or change NeoProxy's served-model exposure. These browser
preferences persist across reloads. NeoProxy-backed accounts and provider
catalogues remain preview data, separate from the connected NeoPi runtime's
credential controls.


### Card agents

Assigning a card starts its agent without an approval step. Queued assignments
share one global limit; completed runs record their outcome and move to the
configured done/review column. Failed or cancelled runs move to the failure
column. The card modal exposes cancellation and the persisted run result.

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `NPI_DECK_CARD_AGENT_CONCURRENCY` | `12` | yes | Positive safe integer; extra cards queue. Values such as 16 or 32 have no hard-coded cap. |
| `NPI_DECK_CARD_AGENT_MODEL` | deck new-chat default | yes | Default model selector for card work. |
| `NPI_DECK_CARD_AGENT_ROLE` | _(none)_ | yes | Default NeoPi model role when no default model is explicitly selected. |
| `NPI_DECK_CARD_AGENT_ACTIVE_STATE` | `s_active` | yes | Column id entered when execution begins. |
| `NPI_DECK_CARD_AGENT_DONE_STATE` | `s_done` | yes | Done/review column id entered on successful completion. |
| `NPI_DECK_CARD_AGENT_FAILURE_STATE` | `s_blocked` | yes | Column id entered on failure or cancellation. |

Card properties are leading TOML between `+++` lines in the card body, not a
separate metadata store. All card-creating API requests accept a `properties`
mapping; it merges into existing front matter with the shared comment-preserving
TOML codec. The UI quick-add and modal raw-body editor accept native TOML:

```text
+++
read-only = true
worktree = "/absolute/path/to/an/existing/git-worktree"
role = "researcher"
[custom]
tags = ["investigation", "routing"]
+++
Research the linked source and report the result.
```

`read-only` must be a boolean. `worktree`, `model` and `role` must be nonempty
strings; a linked worktree must be an existing absolute registered git-worktree
root; the run records its canonical directory, including when the supplied path
uses a filesystem alias or Git's platform-specific path spelling. A card's
explicit `model` or `role` overrides the default selector. Other properties,
including nested mappings and arrays, remain part of its body.

Without `worktree`, execution creates a fresh detached temporary worktree from
the card's explicit project `cwd`, or the configured default working directory
when the card is Unassigned. Cleanup removes only worktrees owned by that run,
never a linked user worktree. Routing remains separate: a linked worktree or
TOML property does not infer project filing; omitted API `cwd` means Unassigned.
Inbox provenance stays after the leading TOML. Routines accept both `body`
and typed `properties`; chat `/task add` accepts multiline TOML or a JSON
card-creation object.

At database startup, existing YAML card bodies import once to canonical TOML.
The exact original Markdown, including YAML comments, is retained in the
immutable `card_legacy_originals` table before the body is changed; card deletion
does not delete that backup. Legacy API input goes through the same transactional
import seam. Subsequent reads and property edits use TOML only. Malformed legacy
metadata is retained for repair and cannot execute as an unannotated card.
Imports also carry YAML comment text into a TOML comment preamble. The preamble
explicitly notes that original comment-to-key placement is not retained; exact
placement and original syntax remain available in the immutable source backup.

KB notes use the same `+++` TOML frontmatter. On first indexing, a legacy
`note.md` imports to a same-permission `note.toml.md` sibling without changing
the YAML original. If both exist, the TOML sibling wins (including parse errors)
and the warning identifies paths only. The tree, graph, search and wikilinks
retain the logical `note.md` identity, indexing only the canonical content.
Raw edits update the TOML sibling, never the original. Explicit null properties
round-trip through the shared version-1 `__npi.null_paths` metadata.
External `SKILL.md` frontmatter remains YAML and is not migrated or re-encoded.

Card workers use `kb_read` and `kb_write` through a run-scoped bearer capability.
The server derives project identity and read-only policy from the active run;
workers cannot claim a different project. Completion or cancellation revokes
the capability, and read-only capabilities reject knowledge writes.

Read-only workers restrict the actual SDK capability set to bounded local
`card_read`/`card_search` and explicitly requested `kb_read`. Mutation,
execution, subagent, extension, MCP, LSP and ambient context capabilities are
not admitted. Knowledge is not automatically injected. On Linux, `bwrap`
adds a read-only filesystem boundary and is required; missing sandbox support
fails the run instead of downgrading it. The SDK restriction also applies
on other platforms.

### Sessions

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `NPI_DECK_IDLE_TIMEOUT_MS` | `300000` (5 min) | no | Milliseconds before an unsubscribed idle session is reaped. `0` disables reaping. |

### Storage

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `NPI_DECK_HOME` | `~/.npi-deck` | yes | The data dir. Launching environment only. |
| `NPI_DECK_DB_PATH` | `<data dir>/deck.db` | yes | SQLite database path. |
| `NPI_DECK_UPLOADS_ROOT` | `uploads/` next to the db | yes | Pasted-image store. |
| `NPI_DECK_WEB_DIST` | `apps/web/dist` once built | yes | Static web bundle dir. The launcher sets it. |

### Set by the launcher and the server

Not settings; listed so they are recognizable in `/proc/<pid>/environ`.

| Var | Set by | Notes |
|---|---|---|
| `NPI_DECK_LAUNCHER_PID`, `NPI_DECK_LAUNCHER_STARTTIME` | `npi-deck` launcher | The server shuts down when this process is gone. Without them, the restart button reports that no supervisor is present. |
| `NPI_DECK_GEN` | server, at boot | Generation marker inherited by every descendant. The next boot (and the launcher, once its server is gone) kills processes of dead generations. |
| `NPI_DECK_TELEGRAM_BRIDGE_ENTRY` | you, rarely | Override the Telegram bridge entry script. |

### Logging

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `LOG_LEVEL` | `info` | no | `debug` / `info` / `warn` / `error`. Hot-applied. |

### Telegram bridge

The bridge is a separate Bun process (`apps/bridges/telegram/`) supervised by
the deck. None of these vars are required for the deck itself.

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | _(unset)_ | bridge | From @BotFather. Sensitive. |
| `TELEGRAM_ALLOWED_USERS` | _(unset)_ | bridge | Comma-separated numeric Telegram user IDs. Required. |
| `TELEGRAM_BRIDGE_DB_PATH` | `<data dir>/telegram-bridge.db` | bridge | SQLite chat→session map. |

See [docs/telegram.md](./telegram.md) for the full bridge setup.

### Provider API keys

Read by the omp SDK directly from `process.env`. The deck Settings UI shows
them masked. Revealing a value, like Settings → Restart, requires a request
whose TCP connection comes from loopback (127.0.0.0/8 or `::1`) and whose
`Host` is `localhost`, `127.0.0.1` or `[::1]`. On a non-loopback
`NPI_DECK_HOST`, remote clients get 403 whatever `Host` they send. The same
holds through the web dev and preview servers (`vite --host 0.0.0.0`): their
proxy tells the deck the real client address in `x-npi-deck-proxy-peer`.

| Var | Sensitive? | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Claude API. |
| `OPENAI_API_KEY` | yes | OpenAI API. |
| `OPENROUTER_API_KEY` | yes | OpenRouter aggregator. |
| `GROQ_API_KEY` | yes | Groq API. |
| `GOOGLE_API_KEY` | yes | Gemini API. |
| `XAI_API_KEY` | yes | xAI / Grok API. |

If you authenticated via `omp` CLI (OAuth), the SDK reads credentials from
`~/.omp/agent/auth.db` instead of env vars. Either path works.

## Restart semantics

Vars with `Restart?: yes` need a full server restart to take effect — typically
because they affect the bind socket, the SQLite file path, or the web bundle
location. The Settings UI surfaces a "Restart server to apply" banner with a
one-click button (`POST /api/server/restart`) when you save one.

Vars with `Restart?: no` hot-apply: `LOG_LEVEL` flips the logger threshold,
`NPI_DECK_IDLE_TIMEOUT_MS` re-arms the reaper, etc.

Vars with `Restart?: bridge` mean the deck server keeps running, but the
relevant bridge process (e.g. telegram) must be restarted via Settings →
Messaging → Restart.

Vars with `Restart?: next session` apply only to sessions created **after**
the change — existing in-memory sessions keep their original values.
