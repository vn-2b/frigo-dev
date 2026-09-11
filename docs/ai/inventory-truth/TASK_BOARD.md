# Inventory Truth task board

## Current authoritative T10 observations and reconciliation — 2026-09-11

T10 COMPLETE at published/fetched application freeze **`6c28858acd0627d2d602998107c2e260c5e4f0d5`**
on `hoplite/himera-6d3eda84-t10-observation-reconciliation` (successor of the train base after the
internal PR #1 merge `668920fa462524e65a79d31a7b0844720baf38e0`; main NOT merged). Source audit,
domain contracts, additive 0030 persistence, pure planner, T09-composing decision authority,
concurrency/tenancy/corruption matrix and full verification are done: 2,990 full/112 files;
T10 focused 1,097/19 files; 49 real local-D1; lint/typecheck/build/30-migration smoke/local
schema gate (requires 0030)/diff PASS, repeated from the clean detached exact-SHA checkout with
empty status. Remaining P0/P1: NONE. **T10 COMPLETE — READY FOR INDEPENDENT REVIEW.**
T11: NOT STARTED. T12: NOT STARTED. Next: independent review of PR #2; no merge of main,
no deploy, no remote D1, no PayOS. Exact evidence: `t10/VERIFICATION.md`.

## Historical FEFO v2 backfill compatibility board — superseded as current; freeze `bf391c5` remains a verified ancestor

Final FEFO backfill P1 fixed at published/fetched **`bf391c5fdcdd9e9c2f2257db515815e082cb4381`** on
`hoplite/himera-6d3eda84` (successor of kydonia at docs HEAD 8552fe5337245f2ac8349933c02946bf7d9dcc8f).
13 permanent backfilled-FEFO tests plus extended schema/D1 proofs; 1,237
focused/15 files, 2,926 full/108 and 44 real-D1 tests pass. Clean exact-SHA
full/static/build/29-migration/schema gates PASS, empty git status. Historical
migrations untouched; migration smoke now replays 0028+0029; schema gate requires
0029. Remaining P0/P1: NONE. **READY FOR FINAL MAIN MERGE REVIEW** (external review
decides the merge; this agent does not merge main). Exact evidence:
`t09/FINAL_PATCH_VERIFICATION.md`. No T10/deploy/remote D1.

## Historical backfill compatibility board — superseded by bf391c5

Backfilled manual PATCH P1 fixed at published/fetched
`df73bc035c2938b6fd082c57f6bca89a82d8e443`. 43 permanent backfill cases and 25
unchanged native PATCH cases pass; 619 focused/nine files, 2,910 full/107 and
42 real-D1 tests pass. Clean exact-SHA full/static/build/migration/schema gates PASS.
**NOT READY FOR MAIN**: inherited v2 FEFO equal-ID SQL restriction remains P1;
no migration or authority bypass made. Next: separately authorized compatibility
follow-up. Exact evidence: `t09/FINAL_PATCH_VERIFICATION.md`. No T10/merge/deploy.

## Historical PATCH parity board — superseded by df73bc0

Final application freeze `e796f695bdb4228853992cdedc4e3cecf3437adb` published on
`hoplite/kydonia-2785bb72` in `vn-2e/frigo-dev`. Targeted storage replay/category
parity findings are reproduced/fixed. 515 focused, 2,865 full, 40 real local-D1
tests and static/build/schema/migration gates PASS; clean-source receipt is in
`t09/FINAL_PATCH_VERIFICATION.md`. **NOT READY FOR MAIN** until the inherited
backfilled-lot PATCH mapping refusal is addressed in a separately authorized task.
No T10, main merge, deployment or remote database changes.

## Historical evidence — all prior freeze/readiness claims below are superseded

## Current authoritative state — 2026-09-11

Repository **vn-2e/frigo-dev**. T09F/G/H COMPLETE at application `9bf9ac0fe7b5e0d39615f39ae5cc30f84569af2f` on hoplite/kydonia-2785bb72.
Full gates at this checkpoint: **2,837 tests / 105 files PASS** (155s), including the new 19-test adoption suite, 9-test G concurrency matrix and rewritten 14-test writer-fence suite; 38 isolated real local-D1 tests PASS; lint PASS; typecheck PASS; build PASS; 28-migration smoke PASS; local D1 schema gate PASS (0028 required). Awaiting external review; T10 not started.

## Historical recovery checkpoint (superseded)

Repository **vn-2d/frigo-dev**, branch **hoplite/kos-2a686759**. Published application
`aa43e069edbff7843e9eb7532ff386b27be96a17`: adoption preparation and writer/retry
safety, not full F. A–E COMPLETE; F IN_PROGRESS; G/H NOT_STARTED. Fresh 1,347
focused / 2,808 full tests and all static/build/migration gates PASS. Next: atomic
v3 adoption authority and functional writer adapters; then G/H. Current authority:
`t09/CONTINUATION.md`. Previous repository names below are historical provenance.

## Historical pre-transfer board

## Current checkpoint — 2026-09-11

A–E complete. E `9bd1e6bc000cd2e94121469babb1a5eb63a5047f` is published/fetched
with equality/ancestry PASS. Final E 1,172 focused / 2,659 full tests and all
static/build/local migration gates PASS. F IN_PROGRESS: DEC-012 guest safety,
then explicit adoption and all writer adapters (`t09/F_ADOPTION_PLAN.md`). G/H
pending; no freeze, T09 readiness or T10. Earlier local-only E statuses below
are historical and superseded by this checkpoint.

## Current continuation — 2026-09-11

Canonical writable successor: `hoplite/orchemenos-e002591e` in `green-1a/frigo-dev`.
Frozen base and exact ancestry: `t09/CONTINUATION.md`. Successor docs
8bf32ed4e41ed3341215c6376e0c13ef13043616 published/fetched before E. A–D complete;
E locally implemented/verified, final full gate/review/publication pending; F–H open.
Latest post-fence: 1,172 focused / 11 files and static/build/migration gates PASS;
latest full rerun pending. Earlier 1,170 focused / 2,657 full results predate the fence. Exact
chronology: `t09/VERIFICATION.md`. No adoption/live writer/UI change or T10 work.

## T09 — IN_PROGRESS (green-1a/frigo-dev)

- [x] Publish authorized T09 branch at exact T08 HEAD; fetch/equality verified.
- [x] T09A — exhaustive writer audit, lifecycle decision, 130 fresh baseline tests PASS.
- [x] T09B — six deterministic command contracts; 202 new tests, 332 combined PASS.
- [x] T09C — internal native persistence/CAS, additive 0024, local D1 rollback proof.
- [x] T09D — idempotency/event/poststate authority; b036b25 published/fetched and remote-source verified.
- [ ] T09E — atomic deterministic FEFO implemented locally; final full gate/review and publication pending.
- [ ] T09F — all legacy mutation writers adapted/migrated or safely rejected.
- [ ] T09G — controlled concurrency and tenancy matrix.
- [ ] T09H — application freeze, full gates, review packet, remote-checkout proof.

Exact next action: finalize E full gate/review, commit/publish the successor, fetch and
prove local == remote before F legacy adoption/writer integration. Historical D:
1,031 focused and 2,518 full tests PASS; static/build and 26-migration local gates
PASS; fetched-source 1,031 tests and typecheck PASS. E has no published code SHA yet.
T09 is not ready for independent review.

## Historical T08 board

- [x] T08A Audit — dependency map/legacy semantics in MASTER_CONTEXT; SQL query-plan tests.
- [x] T08B Domain Contracts — e6ba715; 76 focused unit tests PASS.
- [x] T08C Persistence — cdffb42; 0023 FK/check/indexes; 23-migration replay/local D1 PASS.
- [x] T08D Legacy Backfill — dd2ecc6; retry, concurrency, stale-source rollback,
  populated upgrade, ownership transfer and preservation tests PASS.
- [x] T08E Projection/Parity — 10+6 eggs=16 and corruption diagnostics PASS.
- [x] T08F Verification/Handoff — final local gates and authorized publication PASS.
  - [x] Focused: 130 tests / 2 files PASS.
  - [x] Full: 1,617 tests / 89 files PASS.
  - [x] Lint, typecheck, build, migration smoke, local D1 apply/schema, diff checks PASS.
  - [x] Code committed; repository handoff/parent docs updated in final docs checkpoint.
  - [x] User-approved canonical handoff branch `hoplite/xanthos-7d942897` pushed;
    fb00f46 confirmed by trusted publish/fetch (DEC-006).
  - [x] Post-publication clean tree, final report T08_VERIFICATION.md and COMPLETE.

No completion tick without evidence in VERIFICATION.md. T09–T12 are not started.

Final session reran every local gate; no test coverage was waived by changing the
publication branch. Historical feature-branch denials remain in the append-only log.
