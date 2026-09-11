# T09 — Inventory Lot Engine & Event Authority

## Current authoritative final targeted PATCH packet

`vn-2e/frigo-dev` / `hoplite/kydonia-2785bb72`.
Final application freeze: **`e796f695bdb4228853992cdedc4e3cecf3437adb`**.
Read [FINAL_PATCH_VERIFICATION.md](FINAL_PATCH_VERIFICATION.md) for both reproduced
and fixed PATCH findings, full clean-source verification, and the inherited P1
backfilled-lot mapping blocker. Recommendation: **NOT READY FOR MAIN**. No merge,
deployment or T10. All prior freezes/readiness claims below are historical.

## Historical evidence (superseded)

## Current authoritative state

**Current canonical repository: vn-2e/frigo-dev.** Published continuation:
`hoplite/kydonia-2785bb72`, successor of read-only `hoplite/kos-2a686759`.
Application freeze: `9bf9ac0fe7b5e0d39615f39ae5cc30f84569af2f` on `hoplite/kydonia-2785bb72` (successor of the
read-only base `hoplite/kos-2a686759` at `aa44d2a2f80ea33fd4b328aba906660c0129051e`); equality PASS. T09F/G/H
COMPLETE: 2,837 tests / 105 files PASS (155s), 38 isolated real local-D1 tests, lint, typecheck, build, 28-migration smoke and local D1 schema gate PASS. Awaiting external review; do not start T10. [CONTINUATION.md](CONTINUATION.md) is current authority and
[F_ADOPTION_PLAN.md](F_ADOPTION_PLAN.md) retains implementation provenance.
The previous repository references and chronology below are historical provenance.

## Historical pre-transfer state

**Historical checkpoint:** E published/fetched at `9bd1e6bc000cd2e94121469babb1a5eb63a5047f`,
equality/ancestry PASS; 1,172 focused / 2,659 full tests and all E gates PASS.
F in progress per [F_ADOPTION_PLAN.md](F_ADOPTION_PLAN.md), G/H pending. No freeze
or final independent-review readiness. Prepublication statements below are historical.

Current branch authority: [CONTINUATION.md](CONTINUATION.md). On 2026-09-11 the
user authorized writable successor `hoplite/orchemenos-e002591e` from frozen
T09D base `811f7e8463303e010199741d66f88ab8a817212d`. Current remote/provider
identity is `green-1a/frigo-dev`. Earlier owner/branch statements below are history.

Current status: IN_PROGRESS. A–D complete; E internal atomic multi-effect FEFO
implemented locally, final full gate/review/publication pending; F–H not complete.
Published successor docs: `8bf32ed4e41ed3341215c6376e0c13ef13043616`; E code is
uncommitted. Latest post-fence: 1,172 focused / 11 files and static/build/migration
gates PASS; latest full rerun pending. Earlier full PASS predates this fence;
see VERIFICATION.md for chronology. No application freeze or
independent-review readiness; no adoption/live writer/HTTP/UI changes.

Historical repository identity: `vn-2b/frigo-dev`
(user confirmed 2026-09-10; initial packet's owner was outdated).
Legacy production repository: `Tungjpstore/Frigo` as identified by the user;
older T08 docs record `vn-2c/Frigo`. Neither legacy identity is accessed or modified.

Start with REVIEW_INDEX.md, SESSION_LOG.md and VERIFICATION.md, then the parent
MASTER_CONTEXT.md, CURRENT_STATE.md, TASK_BOARD.md and DECISIONS.md.
The active task contract is `../../tasks/T09-inventory-lot-engine.md`.

No main integration, legacy synchronization, staging/production deployment,
remote D1, PayOS, read cutover or T10 implementation is authorized.
