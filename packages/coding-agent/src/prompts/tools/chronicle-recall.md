Recall captured Chronicler atoms — self-contained memories of past sessions — by meaning. The default scope is the current session. Use `scope: "all"` to search across sessions and projects.

Use when the user refers to earlier work, a past decision, or "that thing we did" and the current context lacks it. Nothing from this memory is preloaded; call it explicitly.

- `query`: describe the memory in any words; the index is ranked by meaning, not exact vocabulary.
- `from`/`to`: rough time bounds narrow the search (`2026-09`, `2026-09-03`, or an ISO instant).
- `hint`: an event remembered from around the same time. The tool finds that event, then inspects its temporal neighborhood for the target — use it when the target itself is vague.
- `scope`: `current` (default) or `all`; `session`/`sessions` select one id or a list. Supplying `session`, `sessions`, or `keywords` also widens beyond the default current session. Explicit `scope: "current"` keeps keyword matching local.
- `project`: case-insensitive project path substring. Combine with `scope: "all"` to search that project across sessions.
- `session`/`sessions`: one session id/prefix or a list of ids/prefixes. An empty list selects nothing.
- `keywords`: deterministic literal match over raw transcripts before recall. Supports AND, OR, parentheses, and quoted phrases; AND binds before OR. Terms may occur on different transcript lines. Case-insensitive unless `keywordCaseSensitive: true`. Example: `(daemon AND tmux) OR "session hub"`.
- `resolution` + `node`: for step-by-step narrowing, ask for `month` (or `week`, `day`, `hour`) to get candidate periods, then call again with `node=<candidate key>` and a finer resolution.

Chronicle recall runs as a cancellable background job and returns the job handle immediately. Findings are delivered automatically when the search finishes; cancel it by writing to `proc://<jobId>/kill`.

Results are canonical atoms: id, event time, project, session, the atom body, and the transcript path plus entry ids that support it. Cite atom ids when relying on them. When no atom is confident the result says so and lists candidate periods plus the single most useful follow-up (a time range or an adjacent event) — ask the user for it instead of guessing.

Examples:
- Across sessions: `{"query":"why the daemon was restarted","scope":"all"}`
- Selected sessions: `{"query":"the routing decision","sessions":["a1a1a1a1","b2b2b2b2"]}`
- Transcript candidates first: `{"query":"the routing decision","keywords":"(daemon AND tmux) OR \"session hub\"","from":"2026-09","project":"neopi"}`

Only captured, indexed atoms can be recalled. A stale or partial index is not evidence that other sessions lack the memory; request `npi chronicle index` to refresh the cross-session view.
