# Contributing to npi-deck

Thanks for your interest. [Repository policy](docs/agents/policy.md) defines
branches, signed commits, pull requests, review, and promotion.

## Repo layout

```
apps/
  server/          # Bun + Hono backend that embeds @oh-my-pi/pi-coding-agent
  web/             # Vite + React + Tailwind frontend
  bridges/
    telegram/      # Standalone Bun process — long-poll Telegram bridge
packages/
  protocol/        # Dep-free shared types (REST + WS frames)
docs/              # Markdown documentation site
```

Workspaces are wired through Bun's `workspaces` field in the root `package.json`.

## Dev loop

```sh
bun install
bun run dev          # spawns server (1701) + vite (5173) in parallel
```

If you want them in separate terminals:

```sh
bun run dev:server
bun run dev:web
```

The telegram bridge only runs on demand (Settings → Messaging → Start, or `bun run dev:telegram`).

## Developing without disrupting your daily-driver deck

`bun --hot` re-evaluates `apps/server/src/index.ts` on every save and Vite
hot-reloads `apps/web/src/**` in place. That's great for the inner loop but
it also means a single working tree can't host a "production" deck you're
using and a "dev" deck you're iterating on simultaneously — every edit
bounces the deck you're chatting in.

The fix is a parallel checkout via `git worktree`, env-isolated:

```sh
# from the existing checkout
git fetch origin && git worktree add ../neodeck-wt-feature -b feat/feature origin/nightly
cd ../neodeck-wt-feature
bun install
cat > .env <<'EOF'
NPI_DECK_PORT=8889
NPI_DECK_WEB_PORT=5273
NPI_DECK_HOME=$PWD/.deck-data
NPI_DECK_BACKEND=$HOME/.npi-deck/neopi/<sha>
EOF
bun run dev      # dev deck lives at http://127.0.0.1:5273
```

The two instances now share **history only**. These env vars give you full
state separation (`NPI_DECK_HOME` moves the db, managed `.env`, uploads and
run state together; `NPI_DECK_BACKEND` points at a prepared backend tree
because the new home has no `config.toml`):

| Concern                  | prod tree            | dev worktree                     |
| ------------------------ | -------------------- | -------------------------------- |
| Server port              | `NPI_DECK_PORT=1701` | `NPI_DECK_PORT=8889`             |
| Web (Vite) port          | `5173`               | `NPI_DECK_WEB_PORT=5273`         |
| Deck data dir            | `~/.npi-deck`        | `NPI_DECK_HOME=.deck-data`       |
| OAuth credentials + sessions | `~/.omp/agent/`  | same by default; set `PI_CODING_AGENT_DIR` to isolate when testing the OAuth flow itself |

Leave `PI_CODING_AGENT_DIR` unset for routine dev so you don't re-login to Claude /
Codex on every dev iteration. Set it to a fresh dir only when the change
under test touches `auth.db` and you need to repeatedly clear the
no-credentials state.

Open a PR into `nightly`; after it merges, remove the worktree and local branch
as described in the repository policy. Promotion to `main` belongs to the owner.

### What survives vs. dies on restart

Survives on disk: tasks, inbox, routines, run history, session transcripts,
auth credentials, settings.

Dies on server restart: in-flight WS streams, in-progress agent turns,
in-memory session caches, half-completed OAuth flows (the SDK's loopback
listener is the recipient — losing the process loses the listener).

That's exactly why the worktree pattern matters: your "I'm using it right
now" deck only restarts when **you** decide to merge and bounce it.

## Code quality

- `bun run typecheck` must pass before opening a PR.
- `bun run --filter '@npi-deck/web' build` must build clean.
- New REST routes go through `packages/protocol` types — no `any` at the wire.
- New SDK touchpoints go through `apps/server/src/bridge` — the route layer
  must not import `@oh-my-pi/pi-coding-agent` directly.
- WS broadcast frames go through `apps/server/src/broadcast-bus.ts`.
- Deck slash commands live in `apps/server/src/deck-slash-commands.ts`.

## Testing changes

Bun test runs across server + web + protocol workspaces:

```sh
bun test                  # all workspaces
cd apps/server && bun test
cd apps/web && bun test
```

Coverage is partial — heavy on the bridge layer (plan-mode, queue shadow,
todo synthesis, ext-ui dialogs, reducer event handling) and DB layer
(tasks, routines, notifications, deck-action steps). UI components +
routes are still primarily verified end-to-end via:

1. `bun run typecheck` across every workspace.
2. Isolated browser smoke through `scripts/browser-smoke.ts` against a separate
   deck instance with private state and a separate port (see below).
3. API smokes — small curl scripts under `.logs/` (gitignored).

Choose free, unused deck and debugging ports; the following ports are examples.

```sh
SMOKE_HOME="$(mktemp -d /tmp/neodeck-browser-smoke-XXXXXX)"
bun scripts/browser-smoke.ts --home "$SMOKE_HOME" --timeout 180 -- \
  /absolute/path/to/chromium --user-data-dir="$SMOKE_HOME/profile" \
  --remote-debugging-port=19999 http://127.0.0.1:18999
```

The wrapper requires a dedicated temporary home and private browser profile.
Use private `HOME`, `NPI_DECK_HOME` and `PI_CODING_AGENT_DIR` for the separate
deck too; never smoke against the daily-driver service. The wrapper runs
Chromium/Electron under `timeout` + `xvfb-run -a`, with mandatory
`--password-store=basic` and no inherited `DBUS_SESSION_BUS_ADDRESS`,
`XDG_CURRENT_DESKTOP`, `XDG_SESSION_DESKTOP` or `DESKTOP_SESSION`.
Display, Wayland and credential variables are not inherited; HOME and all
XDG paths are private. Conflicting password-store or display overrides fail.
Never use display `:0` or Xephyr; there is no fallback if Xvfb fails.

Before interacting, verify the actual child's `/proc/<pid>/cmdline` contains
the mandatory flag and `/proc/<pid>/environ` lacks the four bus/desktop keys,
uses the private paths, and has a non-`:0` display. Afterward terminate the
entire process tree, including detached crash handlers and Xvfb, and verify
with `pgrep` for the private profile, debugging port and Xvfb display. The
wrapper also checks its process group and private crash handlers on exit,
timeout and interruption.

When you add a feature with non-trivial state, ship at least the
bridge-side test alongside it. Reducer cases want a unit test apiece —
look at `apps/web/src/lib/reducer.test.ts` for the pattern.

## Style

- TypeScript strict mode is on. No `// @ts-ignore` without a justification comment.
- Tailwind tokens through the theme system (`rgb(var(--token) / <alpha-value>)`).
  Do not introduce raw hex colors outside `apps/web/src/styles.css`.
- React: function components, hooks. No class components, no HOCs.
- Server: Hono + Bun. No Express.

## Commits

Follow [commit policy](docs/agents/policy.md#commits): Conventional Commits,
descriptive prose, actual-model attribution, verified signatures, and one logical
change per commit. Follow [review mechanics](docs/agents/pr-review-bots.md) before
requesting a scoped Code Review or merging.

## Filing issues

If you hit a bug, a minimal repro plus your `bun --version`, OS, deck commit
(`git rev-parse --short HEAD`) and NeoPi backend commit (Settings → Backend)
is all we need.

## License

By contributing you agree that your contributions are licensed under the MIT
license (see [LICENSE](./LICENSE)).
