# Security/lifecycle closure addendum — lease-closed candidate

**Verdict: SATISFIED at specification level for this exact candidate pair, within the assigned security/lifecycle scope.** SEC-03R is closed. SEC-N1 remains closed. The amendment supplies the missing retrieval-work termination owner without creating another financial owner or changing the originating job’s accounting on retrieval cancellation.

**Remaining blockers or requested corrections in this addendum: none.**

## Exact reviewed artifacts

- **P:** `local://marineris-v3-astra-lease-closed-candidate.md`.
- **L:** `local://marineris-backend-resolution-ledger-lease-closed-candidate.md`.

This is a narrow closure check against the preceding retrieval-drain finding. I read the amended §4.6 bullets, both corrected inventory rows and their ledger counterparts, the complete surrounding writer inventory, and the controlling financial, job-authority and shutdown cross-references. No edits, local commands, builds, tests or services ran. This is specification clearance, not implementation or runtime proof.

## SEC-03R — closed

| Required repair | Current normative evidence |
|---|---|
| A retrieval owns upstream-work completion independently of its originating financial Attempt | **P:789** gives each poll/content invocation a nonfinancial upstream-work terminal latch, separate from both output completion and the submitting Attempt. Normal poll completion and content-body completion close that latch exactly once. |
| Cancellation remains bounded when upstream ignores the initial abort | **P:789** covers client cancellation, Generation drain and shutdown with the fixed `abortAt+5000ms` acknowledgement bound. The request controller force-terminates/cancels the local transport/body reader if acknowledgement does not arrive, closes the work latch once, and suppresses late output and callbacks. It explicitly does not claim cancellation of the provider’s remote job. |
| Output completion is not substituted for upstream-work completion | **P:789,795–796** preserves separate output and work conditions. The lease releases once only after both are terminal; the existing bounded output-cancellation path remains in force. **P:785,791** retains request ownership and idempotent finish. |
| Cancelling a GET cannot settle or forgive the originating job | **P:790** expressly forbids calling step3 or `jobs.complete`, modifying `settled`/`requestCounted`/`pendingJobHold`, releasing the job’s consumption hold, or emitting usage merely because retrieval was cancelled/forced closed. |
| Inventory and ledger no longer funnel retrieval cancellation into financial settlement | **P:2032–2034** and **L:248–250** distinguish nonfinancial retrieval termination from financial Attempt settlement and the separate pending-job shutdown sweep. **L:272** maps the same distinction. |
| Future acceptance exercises the actual failure case | **P:790** and **L:274** require both a stalled poll and stalled content reader that ignore initial abort: bounded once-only lease release, suppression of late output/accounting effects, and unchanged originating-job accounting. These are required future checks, not reported results. |

The previous counterexample now has a specified transition: stalled retrieval work can reach its own terminal state at the acknowledgement bound without waiting indefinitely, borrowing the submit Attempt’s financial latch, or treating output cancellation alone as completion. That closes the precise lifecycle gap raised in SEC-03R.

## Accounting boundary preserved

The new latch is a request-lifetime mechanism, not a twenty-first accounting writer.

- **P:1968–1971** retains the originating Attempt’s single final-consumption latch, same-row request-count marker, atomic hold-to-charge transition and winning-transition-only broker observation. Retrieval cancellation is explicitly excluded by P:790 rather than becoming another outcome that charges that owner.
- **P:1988–2001** retains the unique Job→Attempt binding, atomic accepted-submit handoff, and trusted terminal-observation path. A late or duplicate finalization still cannot reopen the settled owner or add another charge/refund.
- **P:2003** retains the distinction between an accepted detached job’s durable financial hold and request/Generation/glue lifetime. Ordinary hot reload does not expire that hold merely because its submit lease finished.
- **P:333–336,2003** preserves the separate service-shutdown sweep: it finalizes pending job owners through the existing financial transaction before Store close, without waiting on remote generation or recreating old request leases. **P:790** explicitly says a cancelled poll is not that sweep.
- **P:2528** retains authenticated opaque job ids, current caller authority/ownership checks, and saved-account `getPinned` retrieval. The amendment does not substitute the polling client for the submitting principal or permit another credential.
- The surrounding **20-row inventory, P:2022–2041**, continues to exclude duplicate route/MoA/job observers, financial changes from provider observations, and hold removal by policy or retention. **P:2043** retains the required switch adapters and rejects silent fallback to ordinary gateway observers.

No conflict with the accounting reviewer’s approved ownership contract was found in this narrow amendment. This addendum does not independently repeat or broaden that reviewer’s full accounting verdict.

## Earlier shutdown correction retained

**P:2914–2934** still specifies `KillMode=mixed`, `SendSIGKILL=yes`, and `TimeoutStopSec=ceil((drain_ms+5000+5000+10000)/1000)`, giving the stated 40-second default allowance. It retains the SEC-N1 distinction between main-targeted SIGTERM’s application sequence and systemd stop/restart’s manager-enforced timeout, and warns against treating untargeted `systemctl kill` as equivalent.

**P:328–344,796** continues to require main-process survival through request cleanup, glue termination and Store/storage closure. The retrieval amendment fits within the existing five-second acknowledgement phase; it adds neither another shutdown timer owner nor a separate Reservation-release pass.

## Disposition

The prior security/lifecycle approval can now be carried forward to **this exact lease-closed pair**, with SEC-N1 and SEC-03R closed at specification level. Implementation must still supply the prescribed stalled-retrieval, generated-unit-stop and accounting-race evidence. No runtime, code-quality or production-readiness approval is asserted here.

— Astra, `openai-codex/gpt-6-astra`