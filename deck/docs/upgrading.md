# Upgrading npi-deck

How to update your install, what changed, what might break, and how to roll back if you need to. Most upgrades are non-breaking — read this only when something behaves differently than you expected, or before jumping more than one minor version.

- [The general upgrade procedure](#the-general-upgrade-procedure)
- [Per-version notes](#per-version-notes)
  - [0.7.0-dev — from omp-deck to npi-deck](#070-dev--from-omp-deck-to-npi-deck)
  - [0.6.0 — first-run onboarding, provider clarity, reliability fixes](#060--first-run-onboarding-provider-clarity-reliability-fixes)
  - [0.5.0 — cross-platform CI, Linux container, Mac/Linux launcher](#050--cross-platform-ci-linux-container-maclinux-launcher)
- [Rolling back](#rolling-back)
- [Reporting upgrade issues](#reporting-upgrade-issues)

---

## The general upgrade procedure

npi-deck never auto-updates, never checks for updates, and never replaces user-edited files. Moving legacy omp-deck state (`~/.omp-deck`, `~/.config/omp-deck`) into `~/.npi-deck` is opt-in: `bun scripts/migrate-omp-deck.ts` only reports what it would do until you pass `--apply`. SQLite schema migrations are different: they run automatically on the first boot of a newer deck (see below). Upgrades are an explicit `git pull` you run in your checkout, followed by a launcher restart. There is no npm package, Docker image, or Windows launcher.

```sh
cd /path/to/neopi
git pull
bun install --frozen-lockfile
bun deck/scripts/native-addon.ts --native-dir /path/to/matching-neopi-checkout
# Or after ./build.sh: bun deck/scripts/native-addon.ts --built
# stop the running launcher (Ctrl-C), then:
NPI_DECK_BACKEND="$PWD" deck/bin/npi-deck
```

Install at the NeoPi repository root so the shared lockfile governs every workspace. Restage the native addon when its inputs change. The launcher rebuilds changed web sources. Existing deck data and backend configuration are not moved automatically; see [install.md](./install.md).

The deck:

- Re-uses your existing `~/.npi-deck/` data dir (deck.db, managed `.env`, uploads, onboarding flag).
- Re-uses your existing `~/.omp/agent/` (auth credentials, sessions, skills, extensions).
- Applies any new SQLite migrations on first boot — idempotent, additive only (we never drop columns).
- Installs no starter skills or extensions unless you opt in to them (Settings → Starters, `NPI_DECK_STARTERS`), and never overwrites a file by the same name.

To check what version you have running:

```sh
git -C /path/to/your/npi-deck/checkout rev-parse --short HEAD
# or hit the local health endpoint (reports version + buildSha):
curl http://127.0.0.1:1701/api/health
```

---

## Per-version notes

### 0.7.0-dev — from omp-deck to npi-deck

Unreleased. npi-deck is a hard fork of omp-deck and drops every upstream distribution path. See [CHANGELOG.md](../CHANGELOG.md#unreleased) for the full list.

- **No npm package.** `omp-deck` from npm, its `omp-deck` CLI shim and its in-app "update available" pill are gone. Remove the global `omp-deck` package with the package manager you installed it with, then install from a checkout as in [install.md](./install.md).
- **No Docker image and no Windows launcher.** `Dockerfile`, `docker-compose.yml`, `Start-OMP-Deck.cmd` and the `scripts/*.ps1` helpers were deleted. The `npi-deck` launcher (systemd user service, or `--no-systemd`) is the only supported way to run the deck.
- **NeoPi and the deck share a checkout.** The `deck/` subtree uses root workspace packages and the root lockfile. Runtime selection still uses `NPI_DECK_BACKEND` or `config.toml`. Native staging is separate from selecting a backend.
- **New data dir and env names.** Deck state lives in `~/.npi-deck`, and every `OMP_DECK_*` variable is now `NPI_DECK_*`. Old `~/.omp-deck` data is not read; `bun scripts/migrate-omp-deck.ts` copies it over, renaming the env keys, when you pass `--apply` (without it, the script is a dry run). Stop the deck before applying. The script leaves the old dirs in place and never overwrites deck state (a database or its WAL, uploads, `.env`, …) in `~/.npi-deck`: files byte-identical to the migrated copy are skipped, so an interrupted run can be retried, and anything else makes `--apply` refuse. `--force` moves the differing files into a new `~/.npi-deck/.omp-deck-migration-replaced/<timestamp>-<random>/` directory and installs the legacy copy in their place; files the migration would not write stay where they are. Once a migration has completed, a plain `--apply` rerun is refused, and `--apply --force` re-checks the deck home against the legacy source, changing nothing when they already match. A deck home that reaches the legacy dirs through a symlink, or contains them, is refused, and no file is written through a symlinked directory inside the deck home.

---

### 0.6.0 — first-run onboarding, provider clarity, reliability fixes

Released 2026-05-29. See [CHANGELOG.md](../CHANGELOG.md#060--2026-05-29--first-run-onboarding--provider-clarity--reliability-fixes) for the full list.

**TL;DR:** non-breaking for everyone who already has a working install.

#### What you might notice on first boot

- **Existing users see no behavior change at startup.** The new onboarding wizard auto-detects "this is a returning user" by checking for an existing session OR a welcome task that's been moved out of backlog. If either is true, it silently writes a completion flag at `~/.npi-deck/onboarding.json` so the wizard never triggers. Your first boot of v0.6.0 will write this flag — that's the entire migration.
- **Model picker has a new `subscription` badge** on Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, Cursor, Perplexity Pro/Max, and recognized coding-plan providers. Visual change only; no behavior change.
- **Placeholder API keys now hide their providers from the picker.** If you have an obvious placeholder in your env (e.g. `OPENAI_API_KEY=sk-your-XXXXhere` from a tutorial), models from that provider stop appearing in the default picker view (toggle "show unauth" to see them with a `no auth` badge). This is a fix for a confusing failure mode where clicking the model sent the placeholder to the provider's API and got back a 401. **Action:** if a model disappeared and you didn't expect it, your env value matches one of these placeholder patterns; replace with a real key.
- **OAuth flows now time out at 5 minutes** server-side. Previously a stuck flow (e.g. Ollama waiting on endpoint input from a closed modal) could block subsequent OAuth attempts forever with "already in progress." Now it auto-cleans.
- **`process.execPath` fallback** on child-process spawn. Only matters if you've reinstalled Bun via a different installer between deck boots — the deck now falls back to a fresh `Bun.which("bun")` lookup instead of `ENOENT`-ing.

#### What needs your attention

Nothing required. But if you want to:

- **Try the new onboarding wizard yourself** (after settling silently), navigate manually to `http://127.0.0.1:1701/onboarding`. The "Skip setup" link in the top right exits without changes.
- **Get the wizard back for a real first-run test**, delete `~/.npi-deck/onboarding.json` (or `$NPI_DECK_HOME/onboarding.json`) AND make sure your seed welcome task (T-1) is still in backlog AND you have zero persisted sessions. Then refresh.

#### What did NOT change

- Your SQLite schema, env file, auth credentials, kb root, routine config, inbox, sessions — all untouched.
- The `omp` CLI's behavior. The deck embeds the SDK in-process; the CLI is independent.
- Existing URLs, slash commands, settings keys, env vars.

---

### 0.5.0 — cross-platform CI, Linux container, Mac/Linux launcher

Released 2026-05-28. Two Linux bugs were fixed that affected anyone running on Linux (especially via Docker) prior to this release. Nothing else user-facing changed.

The Docker image this note refers to no longer exists; see the 0.7.0-dev note above.

---

## Rolling back

If a new version breaks something for you, downgrade to the previous one and file an issue.

```sh
git checkout <previous-commit-or-tag>
bun install --frozen-lockfile --ignore-scripts
bun deck/scripts/native-addon.ts --native-dir /path/to/matching-neopi-checkout
# stop the running launcher (Ctrl-C), then:
NPI_DECK_BACKEND="$PWD" deck/bin/npi-deck
```

When rolling back to a checkout before the subtree move, follow that checkout's own install guide. Do not remove its existing backend worktrees or configuration.

**SQLite migrations are forward-only.** Rolling back the checkout doesn't roll back the schema. In practice this hasn't caused user-visible problems because every migration we ship is additive (adding columns or tables, never removing or renaming), so an older deck just ignores the newer fields. If you're worried, snapshot `~/.npi-deck/deck.db` before upgrading.

For the onboarding flag specifically (introduced in 0.6.0): an older deck will ignore the flag file entirely. Safe to leave in place if you roll back.

---

## Reporting upgrade issues

If an upgrade broke something for you:

1. Roll back to the previous version (see above) so you're unblocked.
2. File an issue at <https://github.com/PsychedelicShayna/neopi/issues> with the `npi-deck` label and:
   - the version you came from + version you went to
   - your OS + Bun version (`bun --version`)
   - the relevant log excerpt (`journalctl --user -u npi-deck` under the launcher, or the terminal where the deck is running)
   - what you expected vs what you saw

Small repro cases get fixed fastest.
