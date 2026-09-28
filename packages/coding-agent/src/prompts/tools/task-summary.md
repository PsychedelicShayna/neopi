<task-result id="{{id}}" agent="{{agentName}}" status="{{status}}" duration="{{duration}}">
{{#if meta}}<meta lines="{{meta.lineCount}}" size="{{meta.charSize}}" />{{/if}}
{{#if abortReason}}
<abort-reason>{{abortReason}}{{#if resumable}} — the agent is still live with its full context; message it via `write agent://{{id}}` to resume instead of redoing the work.{{/if}}</abort-reason>
{{/if}}
{{#if error}}
<error>{{error}}</error>
{{/if}}
{{#if effortPolicy}}
<effort-policy model="{{effortPolicy.model}}" requested="{{effortPolicy.requested}}" origin="{{effortPolicy.origin}}" rule="{{effortPolicy.rule}}">
<supported>{{effortPolicy.supported}}</supported>
<permitted>{{effortPolicy.permitted}}</permitted>
<alternatives>{{effortPolicy.alternatives}}</alternatives>
</effort-policy>
{{/if}}
{{#if truncated}}
<preview full-output="agent://{{id}}">
{{preview}}
</preview>
{{else}}
<output>
{{preview}}
</output>
{{/if}}
{{#if mergeSummary}}
<merge-summary>
{{mergeSummary}}
</merge-summary>
{{/if}}
</task-result>
