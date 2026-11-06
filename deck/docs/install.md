# Installing npi-deck

npi-deck is the web cockpit for NeoPi, a fork of
[`oh-my-pi`](https://github.com/can1357/oh-my-pi) (`omp`).

NeoDeck lives in the NeoPi repository under `deck/`. One root workspace and
`bun.lock` supply both applications. The backend picker and launcher still
support configured NeoPi source trees. Nothing switches an existing installation
or changes its state until you choose to run the new checkout.

From a NeoPi checkout:

```sh
bun install --frozen-lockfile
# Reuse an addon from a checkout with matching native inputs:
bun deck/scripts/native-addon.ts --native-dir /path/to/matching-neopi-checkout
# Or after ./build.sh: bun deck/scripts/native-addon.ts --built
NPI_DECK_BACKEND="$PWD" bun --cwd=deck run dev
```

For a supervised deployment, build the web bundle with
`bun --cwd=deck/apps/web run build`, then run
`NPI_DECK_BACKEND="$PWD" deck/bin/npi-deck`. This override pins the launch to
the repository root. To switch from Settings, register source trees in
`config.toml` and omit the override.

- [Prerequisites](#prerequisites)
- [NeoPi backend tree](#neopi-backend-tree)
- [config.toml](#configtoml)
- [The npi-deck launcher](#the-npi-deck-launcher)
- [Sign in to a provider](#sign-in-to-a-provider)
- [Verifying the install](#verifying-the-install)
- [Where state lives](#where-state-lives)
- [Development servers](#development-servers)
- [Uninstall / clean slate](#uninstall--clean-slate)
- [Troubleshooting](#troubleshooting)

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| [Bun](https://bun.sh) | satisfies root `packages/utils/package.json` | Runs NeoPi, the deck and the web build. |
| Git | any recent | Identifies backend source trees. |
| A NeoPi checkout | includes `deck/` | Supplies workspace packages directly. |
| A prebuilt `pi_natives` addon | matching native inputs, platform and CPU variant | `deck/scripts/native-addon.ts --native-dir` stages and records it. Otherwise build with `./build.sh`, then record with `--built`. |
| A systemd user manager | — | The launcher runs the server as a user service. Without one, pass `--no-systemd`; `setpriv` (util-linux) is then used when present. |
| A modern browser | recent Chrome / Edge / Firefox / Safari | Renders the deck. WebSocket support is required. |

You do **not** need Node.js — Bun runs everything.

## NeoPi backend tree

The server and Telegram bridge typecheck directly against NeoPi's workspace
packages. `deck/tsconfig.base.json` extends the repository's base configuration,
including its ambient asset types. There is no generated TypeScript configuration
or separate backend worktree to prepare.

Run `bun deck/scripts/native-addon.ts --native-dir <matching-checkout>` from
the repository root to stage a reusable addon. Repeat `--native-dir` to search
several checkouts. The script does not install dependencies, create worktrees,
write deck configuration or build native code.
It links the donor by default; pass `--copy` for an independent copy.

Native-input fingerprints, release stamps or legacy sentinels, platform,
CPU variant and addon SHA-256 checks are unchanged. A recorded donor is
preferred. An unrecorded donor with matching sources is marked `derived`,
meaning source equality was observed but the build was not. Unrecorded bytes
inside the target tree cannot vouch for themselves.

After a fresh build or staging the current CI native artifact, `--built`
explicitly attests that those bytes came from this tree. Do not use it to
bless an old or unknown addon. Records live at
`node_modules/.npi-deck/native-addon.json`. They detect stale or swapped
addons but are local bookkeeping, not authentication.

Check the runtime SDK contract without sending provider requests:

```sh
NPI_DECK_BACKEND="$PWD" bun deck/apps/server/src/backend/contract.ts
```

## config.toml

`~/.npi-deck/config.toml` lists backend source trees and names the one the deck
loads when `NPI_DECK_BACKEND` is unset. For example:

```toml
activeBackend = "workspace"

[[backends]]
id = "workspace"
kind = "source"
path = "/home/you/repos/neopi"
```

- `kind = "source"` is the only kind the deck loads; `kind = "gateway"` is reserved
  and cannot be selected.
- `activeBackend` names a registered tree. **Settings → Backend** changes it.
- `NPI_DECK_BACKEND` (a backend id from `config.toml`, or an absolute tree
  path) overrides `activeBackend` for the whole launch, including the source
  shown in Settings; remove it and restart the launcher to switch from the UI.

The deck reads and writes native TOML only. If only `config.yml` or
`config.yaml` exists, the first read imports it to `config.toml` atomically,
keeps its file permissions, and leaves the YAML byte-for-byte unchanged.
When both exist, TOML wins and a paths-only warning identifies the ignored
legacy sibling. Backend-picker edits retain unrelated TOML comments.

The server imports NeoPi from the selected tree at startup. If no backend is
configured, the deck still starts: kanban, inbox, routine editing and settings
remain available. Agent-backed endpoints return HTTP 503 with
`backend_unavailable`. Open **Settings → Backend** to choose a prepared source
tree. The picker runs an isolated preflight (Bun engine, dependencies, native
addon version sentinel and recorded fingerprint, required SDK exports, and the
sha256 of the addon the native loader actually loaded, which can be a
fallback candidate) before switching. It reports the tree's commit and version.
A missing record, changed native inputs or different addon bytes fail preflight
until a matching addon is staged and recorded again.

A normal switch refuses while work is active, listing live sessions and
prompts without changing the running backend. **Force —
abort all work** stops them before restarting the worker through the launcher.
The worker rolls back to the previous backend if the candidate cannot start;
if the previous backend also fails, it starts without a backend. Browser tabs
reconnect to the new worker generation without replaying prompts queued while
offline. Existing transcripts remain available for explicit resume. The
backend picker requires the `npi-deck` launcher, not a directly started
server process.

## The npi-deck launcher

`bin/npi-deck` is how the deck runs. Link it into your `PATH` once; the link
resolves back to the checkout, so it works from any cwd:

```sh
ln -s "$PWD/deck/bin/npi-deck" ~/.local/bin/npi-deck
npi-deck [--port N] [--host H] [--unit NAME] [--rebuild] [--no-systemd]
```

What it does:

- Builds the web bundle (`apps/web/dist`) when it is missing or older than
  its sources (`--rebuild` forces it), and serves it from the server.
- Refuses to start a second instance. The lock is `~/.npi-deck/run/launcher.lock`
  (a lock left by a dead launcher is taken over), and a unit that is already
  active is refused too.
- Runs the server as the transient systemd user service `npi-deck.service` in
  `neopi-deck.slice` (under `neopi.slice`), with `KillMode=control-group`.
  When the server exits for any reason, `kill -9` and OOM included, systemd
  kills everything left in the unit's cgroup: MCP servers, shells, routine
  steps, setsid'd daemons. The launcher follows the unit's journal in the
  foreground.
- Ctrl-C (or SIGTERM/SIGHUP) on the launcher stops the unit. If the launcher
  itself is killed, the server notices within a second (it watches
  `NPI_DECK_LAUNCHER_PID`) and shuts down. A hung shutdown is forced after
  three seconds so systemd can empty the unit's cgroup within five seconds.
- Settings → Restart makes the server exit with the reserved status 75;
  systemd restarts it on exactly that status (`RestartForceExitStatus`) and
  clears the cgroup between generations. Force-switching a backend uses the
  same restart status. Both restarts force worker exit after three seconds if
  active work blocks teardown; systemd then kills remaining processes in the
  old cgroup. It gives up after 5 starts in 60 s. A server started with
  `bun run dev` or `bun run start` has no supervisor, so its restart button
  reports that instead.
- Configuration problems that a restart cannot fix (a server dependency that
  does not resolve, a failed web build, a backend whose native addon has no
  record) exit with status 78 (`EX_CONFIG`) and one message naming the fix. The
  launcher's unit sets `RestartPreventExitStatus=78`, so systemd stops instead
  of looping; a hand-written unit needs the same line. Dependencies are checked
  by resolving them from `apps/server`, so the hoisted root `node_modules` of a
  NeoPi checkout is enough and `deck/node_modules` is not required.
- The native addon record (`node_modules/.npi-deck/native-addon.json`) is an
  attestation the launcher never writes. `./build.sh` writes it after it builds
  or verifies the addon, and
  `bun deck/scripts/native-addon.ts --native-dir <checkout>` records an addon
  reused from another checkout. `bun install` or a clean deletes it; the
  launcher then refuses to start and names that command.

Without a systemd user manager the launcher refuses to start unless given
`--no-systemd`. Then the server is a direct child, run under
`setpriv --pdeathsig KILL` in its own process group, so it dies with the
launcher. When the server exits, the launcher kills its process group and
every process that still carries its generation marker (`NPI_DECK_GEN`).
Descendants of a server whose launcher was also killed are cleaned up at the
next start.

Server child processes carry a per-spawn group marker. Group cleanup checks
the original leader or a marked descendant before signaling its process group,
so a recycled group ID cannot target an unrelated process. Blocking git and
preflight probes use the same parent-death protection. The generation sweep
remains the fallback for descendants that leave their original group.

Status and logs: `systemctl --user status npi-deck`,
`journalctl --user -u npi-deck`, `systemd-cgls --user-unit npi-deck.service`.

At launch the deck copies any missing starter skills and extensions into the
NeoPi agent dir. **Settings → Starters** (or `NPI_DECK_INSTALL_STARTER_SKILLS`
/ `NPI_DECK_INSTALL_STARTER_EXTENSIONS` set to `0`) turns that off.

## Sign in to a provider

NeoPi keeps sessions and credentials in `~/.omp/agent/`. If you already use
`omp` or NeoPi in a terminal on this machine, the deck picks that directory up
and needs no new sign-in; your existing sessions appear in the sidebar.

Otherwise, sign in from the deck:

- **Subscription / OAuth** (Claude Pro / Max, ChatGPT Plus / Pro, …) —
  Settings → Providers → *Sign in*. The token is written to
  `~/.omp/agent/auth.db`.
- **API key** (Anthropic / OpenAI / OpenRouter / Google / …) — Settings → Env,
  paste the key. It is saved to the deck's managed `.env`.

On a fresh machine you'll see a single "Welcome to NPI deck" task in the
kanban. Read it for a quick tour of the deck.

## Verifying the install

A quick smoke list:

1. **Health endpoint**: `curl http://127.0.0.1:1701/api/health` returns `{"ok":true,...}`.
2. **Web bundle**: opening <http://127.0.0.1:1701> shows the chat view (or
   the kanban — there's no auth, so any route works).
3. **Backend**: Settings → Backend shows the selected repository root and its
   actual commit and version.
4. **First session**: click "+ new session" in the sidebar, send any prompt.
   You should see streaming text within a couple of seconds.
5. **Settings**: navigate to `/settings`. The Env section lists
   `NPI_DECK_HOST`, `NPI_DECK_PORT`, `OMP_MODEL`, provider keys (masked), etc.

If any of those fail, see [troubleshooting](#troubleshooting) below.

## Where state lives

Deck state lives in `~/.npi-deck` (`NPI_DECK_HOME` overrides; it is read from
the environment that starts the deck, not from the managed `.env` inside it):

- **Backend selection**: `config.toml`. Existing legacy backend worktrees are not deleted.
- **Kanban, routines, inbox**: `deck.db` (`NPI_DECK_DB_PATH` overrides), with
  pasted images under `uploads/`.
- **Managed env file and audit log**: `.env` and `env-audit.log`.
- **Telegram bridge mapping DB**: `telegram-bridge.db` (only created when the
  bridge runs).
- **Run state**: `run/` (launcher lock, generation and owned-process
  journals).

Nothing is read from the old `~/.omp-deck` or `~/.config/omp-deck` dirs; to
bring their state over, run `bun scripts/migrate-omp-deck.ts` (see
[upgrading.md](./upgrading.md#070-dev--from-omp-deck-to-npi-deck)).

Elsewhere:

- **NeoPi session/auth data**: `~/.omp/agent/` (NeoPi's `getAgentDir()`; `PI_CODING_AGENT_DIR` overrides).
- **Marketplace state**: `~/.omp/plugins/installed_plugins.json` and
  `~/.omp/plugins/marketplaces.json` (managed by the SDK).

## Development servers

`bun run dev` runs the server on :1701 with `bun --hot` and the Vite app with
hot reload on :5173 (open the latter). It is for working on the deck, not for
running it: nothing supervises that server, so Settings → Restart and the
backend picker's switch do not work, and processes it spawns are not confined
to a cgroup. It loads the same `config.toml` backend. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for running a dev deck beside your
everyday one.

## Uninstall / clean slate

To wipe deck state while preserving NeoPi's own data:

```sh
# Stop the deck first (Ctrl-C in the launcher's terminal)
rm ~/.local/bin/npi-deck                    # the launcher link
rm -rf ~/.npi-deck/                         # all deck state, including backend trees
git -C /path/to/neopi worktree prune        # forget the removed backend worktrees
```

`rm -rf ~/.omp/` additionally drops every NeoPi session and credential, for
the deck and any NeoPi CLI on the machine alike.

## Troubleshooting

**`bun install` fails on a network error.** Bun caches packages globally;
retry usually succeeds. If you're behind a corporate proxy, set
`BUN_INSTALL_CACHE_DIR` and `HTTPS_PROXY`.

**Native addon preflight fails.** Restage an addon from a checkout with matching
native inputs using `deck/scripts/native-addon.ts --native-dir`. If none matches,
build this tree with `./build.sh`, then record the fresh addon with `--built`.

**Port 1701 is already in use.** Pass `npi-deck --port 1702` (or any free
port).

**`no systemd user manager is reachable`.** The launcher found no systemd
user manager to run the service under. `npi-deck --no-systemd` runs the
server as a direct child instead, without cgroup containment.

**No models appear in the model picker.** Open Settings → Env and confirm
at least one of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / etc. is set. If you
signed in through OAuth, the provider entries surface via the SDK's auth
store rather than env vars — switching to the deck-managed env doesn't break
that.

**Marketplace is empty.** Click "Add" on the suggested
`anthropics/claude-plugins-official` card. The deck shells out to git under
the hood, so git must be installed.

**The kanban is empty and there's no welcome task.** That means `tasks` had
rows once — the welcome seed only fires against a truly empty table. Run
`/task add <title>` in chat, or click + on the Backlog column.
