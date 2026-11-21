<system-reminder>
Local runtime telemetry; context occupancy and headroom are estimates, not guarantees.
Eval: runtime.inspect() reads this local record (JS: await; Python: synchronous).
When checkpoint fields are present, compare estimated occupancy + expected exploration footprint with the earliest non-null compaction boundary. You SHOULD checkpoint first when that branch may cross it and checkpoint.available is true.
recentTurnFootprint estimates retained messages since the latest user message, not billed request tokens or a prediction. Use it as a rough comparison; provider tokenization, caches, and future tool output vary.
NEVER nest checkpoints.
{{#if rewindRequired}}
You MUST rewind with a concise report before yielding.
{{/if}}
{{{json}}}
</system-reminder>
