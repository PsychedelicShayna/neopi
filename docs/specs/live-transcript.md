# Experimental transcript-aware live mode

[Issue #816](https://github.com/PsychedelicShayna/neopi/issues/816). Start or stop a call with `/live-transcript`.

Reference: [OpenAI Codex 1145028](https://github.com/openai/codex/tree/1145028/codex-rs). Its Frameless Bidi parser assembles interleaved input and output deltas in `codex-api/src/endpoint/realtime_websocket/methods.rs`. The provider's `delegation.created` text becomes the input, with the active transcript providing a fallback. Core renders the handoff as escaped user text in `core/src/context/realtime_delegation.rs`. Transcript presentation runs on its own event stream.

The experiment follows that assembly and wire format in TypeScript. Assistant completion does not consume non-addressed user speech, so continuity does not depend on classifying a reply as a backchannel. The existing NeoPi controller still owns delegation delivery and explicit direct-address routing. The transcript snapshot retires on accepted delivery so a rejected handoff can retry. Reasoning and progress narration are disabled on this command.

Like Codex, the experiment can flush completed transcript chunks once the active transcript exceeds 4 KiB and flushes the remaining tail on stop. NeoPi queues that context for the next turn without starting work. Codex has its own child-history transport and can initiate a terminal tail-flush turn.

The experiment retains NeoPi's audio transport, interruption policy, eligibility gates, and delivery settings. Test the same voice interaction in both clients before calling them equivalent.

## Status-line audio meter

See [Live audio meter](../settings.md#live-audio-meter) for layout and template settings.
