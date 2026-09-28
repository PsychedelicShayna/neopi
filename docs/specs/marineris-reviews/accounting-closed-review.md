# Independent re-review: Marineris accounting-closed candidate

**Verdict: SATISFIED at specification level for the assigned accounting scope.** The prior video double-charge blocker is closed in the normative text. ACC-01 and ACC-02 remain consistent. This is not implementation proof, a runtime result, or approval of any other reviewer's scope.

Reviewed `local://marineris-v3-astra-accounting-closed-candidate.md` and `local://marineris-backend-resolution-ledger-accounting-closed-candidate.md` against `local://marineris-final-accounting-review.md`. Ledger rows are mappings, not acceptance. No implementation, tests, services, or private configuration were inspected. The only source read was the cited video completion helper, to check the cost-only shape the contract claims to preserve. Arithmetic below is specification arithmetic.

## Prior blocker — closed

The hole was: a durable Job row could exist while its launched submit Attempt was unsettled; recovery booked the frozen Estimate through `Attempt.settled`; `jobs.complete` then added actual usage/USD through a separate completion-billed flag.

That second flag is gone. `jobs.originAttemptId` is a required unique foreign key to the submitting Attempt. `settled` is the only final-consumption latch. `requestCounted` is a same-row request marker, not a Job billing flag. `jobs.complete` returns true only when that unsettled owner is finalized, and false leaves counters, debt, holds, and broker emission untouched (§4.5, §12.8 step 3, §12.8.1, §15.4). Seal writes identity and metadata only. There is no Job completion-billed flag and no switch-path `usage.observe`.

Accepted nonterminal submit is a mode of the same step-3 transaction, committed before HTTP 202 exposes the id. It adds `requests=1` once, moves the non-request Reservation into `pendingJobHold` without a release gap, and leaves `settled=false`. It does not book tokens, USD, weight, Meter debt, or a resource observation (§12.8.1). `Budget.reserved` and Gate inflight include that hold once; the memory Reservation and the hold cannot both count (§12.7, §12.13).

Final consumption, live 5000ms force, shutdown sweep, startup recovery, and 24h expiry all enter that same Attempt transaction. The winner sets `settled=true`, removes the live or durable hold, and books usage once. A later caller gets the recorded result and cannot add, refund, or emit again (§4.2, §4.6, §12.8, §12.8.1, §12.13).

Checked paths:

- Crash after launch, before any Job row. Ordinary recovery books frozen Estimate `E` and sets `settled`. No Job exists to complete. One charge.
- Job link durable, acceptance not committed, crash, then a completed poll. Recovery counts request 1 and `E`, sets `settled`, before listeners or allowance reads. The poll charges 0, not `E+actual` (§12.8.1 race table).
- Accepted 202, then completion with actual `A`. Requests stay 1. Completion releases hold `E` and books `A` once. Total consumption is `A`, not `E+A`.
- Accepted 202, then force, shutdown, recovery, or expiry wins. That transition adds 0 requests and books `E` once. Later actual is observational only. No second charge and no refund.
- Terminal result wins before the submit callback. The owner counts request 1 and `A` once. The late callback cannot recreate a hold or another request.
- Two terminal polls, or a crash during finalization. One `settled` transition wins. Rollback keeps the hold and old counters. The committed winner is not repeated.
- Prepared `upstreamCalled=false`. No accepted-job handoff. Finalize unbilled. Zero request and zero resource charge.
- Shutdown does not have a separate hold-release loop. Detached pending jobs are final-settled through step 3 before Store close (§4.2, §12.8.1). The 5000ms path is that same transaction for still-attached work and does not drop a detached hold without it (§12.8.2). Hot reload does not expire a detached hold merely because its RequestLease finished.
- Expiry finalizes the owner through step 3 before 410 or hold removal (§12.8.1, §12.13). Until that transaction commits, the hold remains in reserved/inflight, so the deadline is not a free-headroom interval.

Pool example still holds: cap 30, used 10, launched reservations 5 and 2, remaining 13. After both recover once, used 17, reserved 0, remaining 13.

Handoff uncertainty stays honest. `upstreamCalled=true` is not provider receipt. A crash between launch commit and invocation may charge work the provider never saw. `committed` is not client receipt. Broker delivery is still not a distributed exactly-once protocol. Local "exactly once" sentences are the Attempt latch, not a receipt claim (§12.8, §26).

The cited helper `recordCompletedUsage` (`routes/video.ts:98-112`) records only a completed job with `job.usage`, writes token counts of 0, and sends `costUsd: job.usage.cost.total` under the polling request's client identity. The candidate does not preserve that writer. On the switch path it must be replaced by one step-3 finalization under the frozen submitting principal, with the cost-only observer emitted only by the winning final transition, including when every token count is 0 (§4.5, §12.8 step 4, §15.4). A supplied zero-token usage plus cost is actual consumption, not an excuse to also book the Estimate. Missing final usage and cost uses the Estimate. That is one writer, not two.

Explicit limit, not a remaining second writer: if recovery, force, shutdown, or expiry wins before the provider's actual cost arrives, the booked amount is the interrupted Estimate and the later actual is not applied. Video monetary estimates may be unpriced, so that can understate a later cost-only actual. The text says so and forbids a refund/true-up. That matches the required latch consumption. It is not `E+actual`.

## Writer inventory

§12.8.2 has 20 rows. They match the normative sections: admission and launch do not charge; chat, native, embeddings, images, speech, transcription, and System One submit outcomes to step 3 and must not also call `recordGatewayUsage` on the switch path; each MoA member/judge/helper Attempt has its own id and step 3, while `onSettlement` and session totals are not switch USD writers and the outer aggregate is not charged (§13.4); video seal, 202 handoff, completion, and poll/retrieval are the split above; force, recovery, shutdown sweep, and expiry share the latch; Meter refresh and reconciliation do not edit `requestCounted`, `settled`, holds, or token/USD buckets; window reset moves live and durable holds without settling them; policy edits cannot clear a hold or reset the latches; preview, listing, and retention are not charge writers. Ordinary non-switch gateway observers stay off `switch.db`.

No remaining switch path was found that can add usage/USD after `settled=true`.

## ACC-01 and ACC-02 — still consistent

The video hold is a reservation, not a transfer and not a new principal.

`capEff = base×norm + positiveGrants + incoming − outgoing`, and allocation changes still require `capEff≥0` (§12.5). Operator base/capacity/addition changes still reject with `409 active_transfer_conflict`. Config reload still uses `E-ACTIVE-TRANSFER` inside the publication swap and keeps the current Generation (§5.13, §5.14). Explicit removal is still previewed `support_removed` with affected revs bound. Clock expiry is still `support_expired` in `(createdAt, id)` order before reads, preview, admission, and operator preconditions. §22 still separates those codes and closures. Checked again: bases 80/20, transfer 60, add base 100 proposes donor `40−60=−20` and must reject unchanged; revoke then add is 40/10/50. A durable job hold does not clip a transfer or donate a revoked key's share. Budget removal still does not forgive an admitted hold.

Anonymous identity is still `{kind:"anonymous", id: Endpoint.id}` with no KeyRecord (§12.12). The pipeline's `{kind:"anonymous", endpoint}` is the same configured Endpoint.id. Usage, debit, and attribution still carry kind and id. Reconciliation still sums keyed confirmed, anonymous confirmed, and external to `accountingBasePct`, and calibration still samples both kinds (§14.2). A video job must copy the Attempt's frozen binding, and a poll cannot substitute the polling client (§4.5, §15.4). Checked again: base 40, anonymous debt 1, Δ 1 → base 41, debt 0, anonymous confirmed 1, external 40.

## What this does not say

No test, service, or implementation was run. SATISFIED here means the specification now has one consumption owner for the paths named above, and the prior accounting contracts were not reopened. It does not certify code, broker delivery, or the security review.
