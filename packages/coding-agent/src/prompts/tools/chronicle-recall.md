Recall captured Chronicler atoms — self-contained memories of past sessions across every project — by descending a year → month → week → day → hour index from broad summaries to exact atoms.

Use when the user refers to earlier work, a past decision, or "that thing we did" and the current context lacks it. Nothing from this memory is preloaded; call it explicitly.

- `query`: describe the memory in any words; the index is ranked by meaning, not exact vocabulary.
- `from`/`to`: rough time bounds narrow the search (`2026-09`, `2026-09-03`, or an ISO instant).
- `hint`: an event remembered from around the same time. The tool finds that event, then inspects its temporal neighborhood for the target — use it when the target itself is vague.
- `project`/`session`: restrict to one project path substring or session id.
- `resolution` + `node`: for step-by-step narrowing, ask for `month` (or `week`, `day`, `hour`) to get candidate periods, then call again with `node=<candidate key>` and a finer resolution.

Results are canonical atoms: id, event time, project, session, the atom body, and the transcript path plus entry ids that support it. Cite atom ids when relying on them. When no atom is confident the result says so and lists candidate periods plus the single most useful follow-up (a time range or an adjacent event) — ask the user for it instead of guessing.
