<irc>
Incoming IRC message from agent `{{from}}`{{#if replyTo}} (reply to {{replyTo}}){{/if}}{{#if progress}} (progress; its reply follows later){{/if}}:

{{message}}

{{#if interrupting}}Sent while waiting/working. Active interruptible wait stopped early for immediate reading.{{/if}}

{{#unless progress}}If response expected, reply via `irc` (`op: "send", to: "{{from}}", message: "…"`) or `write` (`path: "agent://{{from}}"`, `content: "…"`), whichever is available. {{#if relayOnStop}}Otherwise what you `yield` or say last this turn is delivered to `{{from}}` when you stop.{{else}}You may finish your current step first. No one replies on your behalf.{{/if}} A progress note uses `progress: true` or `agent://{{from}}?progress`, so `{{from}}` keeps waiting for the answer.{{/unless}}
</irc>
