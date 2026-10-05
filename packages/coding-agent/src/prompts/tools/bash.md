Persistent shell: one fact command/pipeline; dependencies use `&&`.
{{#if hasEval}}Scripts/heredocs/`$(…)`/complex pipelines → `eval`.{{else}}Scripts/heredocs/`$(…)`/complex flow → dedicated tool or checked-in script.{{/if}}
`cwd`, not `cd`; `pty` only interactive.
Internal URIs work as paths for builtins/coreutils, redirects, globs.
{{#if asyncEnabled}}`async` defers finite results; timeout unchanged.{{/if}}
No `head`/`tail`/redirection; output trunc by default, full result at `artifact://<id>`.
{{#if hasLaunch}}Long-lived services: unique name; ready requires name; no async/timeout; pty defaults true. ready needs log regex or port (both if given); host defaults 127.0.0.1, ready.timeout 30s.{{/if}}
{{#if autoBackgroundEnabled}}Background results follow; NEVER poll; foreground wait unchanged.{{/if}}
Tool shells disable editors and credential prompts, but retain the host `TERM`. `OMP_HOST_EDITOR`, `OMP_HOST_VISUAL`, `OMP_HOST_SSH_ASKPASS`, `OMP_HOST_SUDO_ASKPASS`, and `OMP_HOST_TERM` expose launcher values when present.
Before starting a tmux server/pane or sibling TUI, use a subshell: `( . "$OMP_HOST_ENV_FILE"; "$SHELL" -lc '<launch command>' )`. The private 0600 POSIX file restores the original launcher environment, including unsetting tool-only overrides. Do not print or share it: it may contain credentials. It is removed when this npi process exits. This does not repair an already-poisoned tmux server's environment.
When the runtime cannot read the pre-dotenv launch environment, values matching project dotenv files are excluded conservatively from the snapshot.
After an abnormal exit, the next local tool launch prunes abandoned snapshots; OS-backed owner leases preserve snapshots still in use by live npi processes.
Git repository-location variables are excluded from restoration so sibling tools discover their own working directory's repository.
