Persistent bash 5.3.
cwd will reset after each turn, don't rely on cd{{#if hasPty}}; `pty` = interactive{{/if}}.
Internal URIs work as paths for builtins/coreutils, redirects, globs.
In-process builtins, ahead of PATH: {{join builtins ", "}}.
{{#if asyncEnabled}}
`async` defers finite results but keeps the deadline (default {{defaultTimeoutSec}}s); `timeout: 0` for watchers and long jobs.
`notify` (regex; implies `async`) sends each matching output line as a follow-up while the job runs, ahead of its result. Match only lines you'd act on: too many matches switch it off.
{{/if}}
Don't trunc output by habit, result will be summarized and saved as an artifact.
{{#if hasLaunch}}
Long-lived services:
- unique name; ready requires name; no async/timeout; pty defaults true.
- ready needs log regex or port (both if given); host defaults localhost, ready.timeout 30s.
- `notify` (regex) sends each matching output line as a follow-up while the service runs.
{{/if}}
{{#if autoBackgroundEnabled}}
Non-`pty` calls still running after {{autoBackgroundSeconds}}s (or 1s before `timeout`, if sooner) usually move to background job `bg_N` and keep running to `timeout`.
No backgrounding when the client terminal runs the command or the job cap is reached.
The result arrives automatically as a follow-up message. NEVER poll.
{{/if}}
{{#if hasClientTerminal}}
Non-`pty` commands run in the ACP client's terminal environment. Launcher restoration metadata is not available there; NEVER source `$OMP_HOST_ENV_FILE` in a client terminal. For local host-environment restoration, use `pty: true` and the POSIX recipe below.
{{/if}}
Local tool shells disable editors and credential prompts, but retain the host `TERM`. `OMP_HOST_EDITOR`, `OMP_HOST_VISUAL`, `OMP_HOST_SSH_ASKPASS`, `OMP_HOST_SUDO_ASKPASS`, and `OMP_HOST_TERM` expose launcher values when present.
{{#if hasClientTerminal}}For local `pty: true` commands only: {{/if}}For POSIX shells only, before starting a tmux server/pane or sibling TUI, use a subshell: `( set -- "$SHELL"; . "$OMP_HOST_ENV_FILE"; "$1" -lc '<launch command>' )`. Capture the resolved POSIX shell before sourcing because restoration may unset a synthetic `SHELL` absent from the launcher. This recipe is not for cmd.exe or PowerShell: they cannot source this POSIX file and must not receive `-lc`; use a POSIX shell for this restoration workflow. The private 0600 POSIX file restores the original launcher environment, including unsetting tool-only overrides. Do not print or share it: it may contain credentials. It is removed when this npi process exits. This does not repair an already-poisoned tmux server's environment.
Capture precedes profile bootstrap without loading profile dotenv; profile-derived runtime variables are not launcher values. When the runtime cannot read the pre-dotenv launch environment, values matching project dotenv files are excluded conservatively from the snapshot.
After an abnormal exit, the next local tool launch prunes abandoned snapshots; OS-backed owner leases preserve snapshots still in use by live npi processes.
Git repository-location variables are excluded from restoration so sibling tools discover their own working directory's repository.
Restoration also removes variables added only by the centralized shell environment, including a synthetic `GPG_TTY` and coding-agent markers when absent from the launcher.
Injected `OMP_HOST_*` metadata is cleared during restoration when the launcher did not supply it, so siblings do not inherit this process's temporary snapshot path.
Per-command caller, direnv, and runtime-added environment names are passed separately as validated `OMP_HOST_OVERLAY_KEYS`; restoration clears variables absent from the launcher before exporting launcher values and removes that metadata too.
The central process-environment safety filter also excludes malloc stack-logging diagnostics from authoritative snapshots; restoration does not re-enable them in siblings.
