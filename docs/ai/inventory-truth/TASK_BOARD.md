# Inventory Truth task board

2026-09-11: T09F/G/H COMPLETE at application `9bf9ac0fe7b5e0d39615f39ae5cc30f84569af2f` on hoplite/kydonia-2785bb72.
Full gates at this checkpoint: **2,837 tests / 105 files PASS** (155s), including the new 19-test adoption suite, 9-test G concurrency matrix and rewritten 14-test writer-fence suite; 38 isolated real local-D1 tests PASS; lint PASS; typecheck PASS; build PASS; 28-migration smoke PASS; local D1 schema gate PASS (0028 required). Awaiting external review; T10 not started.

## Canonical recovery checkpoint

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
