# Inventory Truth task board

## Current continuation — 2026-09-11

Canonical writable successor: `hoplite/orchemenos-e002591e` in `green-1a/frigo-dev`.
Frozen base and exact ancestry: `t09/CONTINUATION.md`. A–D remain complete;
E–H below remain open. Fresh baseline: 1,031 tests and typecheck PASS.
Next: successor publication proof, then atomic multi-effect FEFO; no T10.

## T09 — IN_PROGRESS (vn-2b/frigo-dev)

- [x] Publish authorized T09 branch at exact T08 HEAD; fetch/equality verified.
- [x] T09A — exhaustive writer audit, lifecycle decision, 130 fresh baseline tests PASS.
- [x] T09B — six deterministic command contracts; 202 new tests, 332 combined PASS.
- [x] T09C — internal native persistence/CAS, additive 0024, local D1 rollback proof.
- [x] T09D — idempotency/event/poststate authority; b036b25 published/fetched and remote-source verified.
- [ ] T09E — deterministic FEFO allocations.
- [ ] T09F — all legacy mutation writers adapted/migrated or safely rejected.
- [ ] T09G — controlled concurrency and tenancy matrix.
- [ ] T09H — application freeze, full gates, review packet, remote-checkout proof.

Exact next action: E FEFO from published D b036b25 before legacy adoption/writer
integration. D: 1,031 focused and 2,518 full tests PASS; static/build and 26-migration
local gates PASS. Remote-source 1,031 tests and typecheck PASS.
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
