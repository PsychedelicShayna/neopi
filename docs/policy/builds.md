# Builds, tags, and promotion

## Installed binaries

| Binary | Source | Trigger | Install path |
| --- | --- | --- | --- |
| `npi-latest` | merged `nightly` sha | automatic belt job after every merge into `nightly` | `~/.local/lib/npi-latest/npi` |
| `npi-nightly` | `nightly` | owner says "build nightly" | `~/.local/lib/npi-nightly/npi` |
| `npi` (stable) | `neopi` after promotion | owner's word | `~/.local/bin/npi` |

The artifact keeps basename `npi`; follow AGENTS.md › Binary install.

## Nightly build runbook

```sh
git fetch origin --tags
SHA=<merged nightly sha>
WT=<repo-parent>/neopi-wt-build-$SHA
git worktree add --detach "$WT" "$SHA"
cd "$WT"
git config core.hooksPath .githooks
bun install --frozen-lockfile
./build.sh
TAG=<install tag from the section below>
git tag "$TAG" "$SHA"
git push origin "$TAG"
export NPI_DEST="$HOME/.local/lib/npi-latest/npi"   # npi-nightly: $HOME/.local/lib/npi-nightly/npi
./install.sh
"$NPI_DEST" --version
```

Remove the build worktree afterward (`git worktree remove "$WT"`). Update a local `neopi` or `nightly` checkout only with `git fetch origin && git reset --hard origin/<branch>`, as the workspace AGENTS.md specifies.

## Install tags

Tag at every install:

```text
nightly-v<upstream-version>-<YYYY-MM-DD>-<last-merged-PR#>-g<shortsha>
```

Example: `nightly-v18.4.10-2026-10-06-241-gac09c70`. Push it to origin. Embed the identical string in `npi --version` output so an offline copy identifies itself without GitHub access.

OPEN implementation gap: `build.sh` currently requires `--version` to report exactly `npi/<version>`.

## Promotion

1. The owner runs a nightly build for a while and says `promote <tag>`.
2. Create `promote/<tag>` from that TAG, not nightly head:

   ```sh
   git fetch origin --tags
   git worktree add "<repo-parent>/neopi-wt-promote-<tag>" -b "promote/<tag>" "<tag>"
   ```

3. Open a PR into `neopi` titled `Promote <tag> to neopi`, with label `sentinel-review-requested`.
4. Build the body as a grouped change list (`feat`, `fix`, `docs`, `ci`, `upstream-sync`) from PR titles, PR bodies, and commit messages between the previous promotion tag and this tag. Deduplicate entries and cross-check the previous promotion PR so errors do not compound. Link each entry to its PR and `Fixes #N`.
5. Run the [sentinel panel](review-bots.md#sentinel). Scope the [Codex request](review-bots.md#codex) to "our fork's issues, not upstream ghosts".
6. The owner merges. Commits merged into `nightly` after the tag wait for the next promotion.
