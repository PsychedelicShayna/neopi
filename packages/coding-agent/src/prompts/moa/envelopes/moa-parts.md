{{#if x.output}}
<output from="{{from.id}}">
{{x.output}}
</output>
{{/if}}
{{#if x.input}}
<input to="{{from.id}}">
{{x.input}}
</input>
{{/if}}
{{#if x.reasoning}}
<reasoning from="{{from.id}}">
{{x.reasoning}}
</reasoning>
{{/if}}
{{#if x.tool_trace}}
<tool-trace from="{{from.id}}">
{{x.tool_trace}}
</tool-trace>
{{/if}}
{{#if x.transcript}}
<transcript>
{{x.transcript}}
</transcript>
{{/if}}
