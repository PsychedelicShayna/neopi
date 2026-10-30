Generate target: {{target}}

## Current definition

```json
{{{definition}}}
```

{{#if baseDefinitions}}
## Selected base definitions

Use only these selected references. Keep the current definition's pre-set values and fill its remaining fields from the selected definitions and the request.

{{#each baseDefinitions}}
### {{name}}

```json
{{{definition}}}
```

{{/each}}
{{/if}}
{{#if comment}}
## Operator's comment

{{{comment}}}
{{/if}}
