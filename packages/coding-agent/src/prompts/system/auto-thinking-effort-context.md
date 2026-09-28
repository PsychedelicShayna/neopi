{{#if diary}}Committed diary:
{{#each diary}}### {{#if carry}}Carry{{else}}{{title}}{{/if}}
{{{body}}}{{#unless @last}}

{{/unless}}{{/each}}

{{/if}}{{#if history}}Uncovered active-branch transcript:
{{{history}}}

{{/if}}Current request:
{{{request}}}