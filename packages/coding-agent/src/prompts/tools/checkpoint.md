Context checkpoint: before exploratory work; later `rewind`, retaining only concise report.

Use for investigations with many intermediate tool calls (`read`/`grep`/`glob`/`lsp`/etc.) to minimize subsequent context cost.

Context-pressure telemetry available? Compare estimated occupancy + expected excursion tokens with speculationStartsAtTokens, or thresholdTokens when speculation is off. You SHOULD checkpoint before an excursion likely to cross that boundary, only when checkpoint.available is true.
Illustrative estimates: 136K used of 200K, speculation at 144K, recent turn footprint 12K. A similar next excursion may cross 144K; checkpoint first. At 40K used, a 4K excursion is well below that boundary; pressure alone does not justify checkpointing.
Footprints and occupancy are estimates, not exact capacity guarantees. Missing telemetry? Use the investigation's expected intermediate context cost.

Rules:
- Active checkpoint and `rewind` available? MUST `rewind` before yielding.
- NEVER `checkpoint` while another checkpoint active.
- Subagents: disabled by default. Enable: agent-definition `tools:` frontmatter lists `checkpoint` or `rewind`; sister tool auto-included; requires `checkpoint.enabled` setting.

Typical flow:
1. `checkpoint(goal: …)`
2. Exploratory work
3. `rewind(report: …)` with concise findings

After `rewind`: intermediate checkpoint messages removed from active context; replaced by report.
