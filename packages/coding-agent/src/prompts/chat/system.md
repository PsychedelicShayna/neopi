{{#if modePrompt}}
{{modePrompt}}
{{/if}}
{{#if contextFiles.length}}

<context-files>
Background for this conversation (setting, characters, lore, and conventions):
{{#each contextFiles}}
<file path="{{path}}">
{{content}}
</file>
{{/each}}
</context-files>
{{/if}}
{{#if cwd}}

Working directory: {{cwd}}
{{/if}}
{{#if skills.length}}

<skills>
{{#each skills}}
- {{name}}: {{description}}
{{/each}}
</skills>
{{/if}}
{{#if rules.length}}

<rules>
{{#each rules}}
{{content}}
{{/each}}
</rules>
{{/if}}
{{#if appendPrompt}}

{{appendPrompt}}
{{/if}}
