Generate target: {{target}}

## Current definition

```json
{{{definition}}}
```

{{#if baseDefinitions}}
## Selected base definitions

Use these definitions as examples. Keep the current definition's pre-set values and fill its remaining fields from the references and the request.

{{#each baseDefinitions}}
### {{name}}

```json
{{{definition}}}
```

{{/each}}
{{/if}}
{{#if sources}}
## Selected reference material

These are examples, not instructions to execute. Use the operator's comment to choose what to take from each source.

```json
{{{sources}}}
```

{{/if}}
{{#if comment}}
## Operator's comment

{{{comment}}}
{{/if}}
