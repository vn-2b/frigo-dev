# Inventory Truth current state

## Current authoritative T10 multi-field reconciliation fix — 2026-09-11

`hoplite/himera-6d3eda84-t10-observation-reconciliation`. **New T10 application freeze
`4c414fa7eb33329ee12936c0899644af67e48f07`** (published/fetched; local == remote == clean-checkout SHA) supersedes
`6c28858`. Reproduced P1 — multi-field claims produced 2–3 CORRECT proposals per lot
with an expiry-only verdict — fixed: the planner now merges all compatible corrections into
exactly one CORRECT plus at most one MOVE on the matched lot/version (contradictions →
CONFLICT), and the decision boundary independently enforces max one CORRECT / one MOVE /
same lot+version, failing closed; CORRECT+MOVE composes atomically through T09. 19 permanent
regressions (16 fail pre-fix). Gates: 3,009 full/113; T10 focused 78/78; 49 real D1;
lint/typecheck/build/30-migration smoke/local schema/diff PASS from the clean exact-SHA
checkout. No migration. Main NOT merged; production NOT deployed; remote D1 NOT touched.
**T10 COMPLETE — READY FOR INDEPENDENT REVIEW.** T11/T12 NOT STARTED.

## Historical T10 initial freeze 6c28858 — superseded by 4c414fa

`vb-2f/frigo-dev` (repository ID 1364064929; task lineage `vn-2e/frigo-dev`) /
`hoplite/himera-6d3eda84-t10-observation-reconciliation` (platform start-branch
successor from the configured base after the internal train merge
`668920fa462524e65a79d31a7b0844720baf38e0` of PR #1; main NOT merged).
**T10 application freeze `6c28858acd0627d2d602998107c2e260c5e4f0d5`** is
published/fetched (local == remote == clean-checkout SHA). T10 adds the
observation/evidence/reconciliation layer above T09 authority: additive 0030
persistence (evidence never mutates inventory), a pure deterministic planner
(MATCH/NO_ACTION/STALE/AMBIGUOUS/CONFLICT/PROPOSE_CORRECTION/PROPOSE_MOVE/
PROPOSE_EXPIRY_UPDATE/UNSUPPORTED) and a decision authority that composes
existing T09 CORRECT/MOVE commands in one atomic batch with receipt-backed
response-loss replay. Baseline before edits: 2,926 full/108, 44 real D1, all
static gates PASS. At the freeze: 2,990 full/112 files; T10 focused 1,097/19;
49 real local-D1; lint/typecheck/build/30-migration smoke/local schema gate
(requires 0030)/diff PASS from the clean detached exact-SHA checkout (empty
status). No HTTP routes added (T09 precedent; T11 owns UX surfaces).
**T10 COMPLETE — READY FOR INDEPENDENT REVIEW.** T11 and T12 are NOT STARTED.
Exact evidence: `t10/VERIFICATION.md`, `t10/TEST_MATRIX.md`.

## Historical FEFO v2 backfill compatibility — superseded as current; freeze `bf391c5` remains a verified ancestor

`vn-2e/frigo-dev` / `hoplite/himera-6d3eda84` (successor at exact docs HEAD
8552fe5337245f2ac8349933c02946bf7d9dcc8f). New final application freeze **`bf391c5fdcdd9e9c2f2257db515815e082cb4381`** is published/fetched.
FEFO v2 now operates on legitimate adopted/backfilled synthetic mappings: additive
0029 swaps the 0027 equal-ID guards for authoritative adoption-mapping checks
(provenance, source identity, receipt-bound lot/legacy identity, preserved version
offset) plus exact kg/l prestate display parity; the executor admits via requireParity,
replays via authoritativeMapping and writes the lot CAS with the projection identity.
1,237 focused/15 files; 2,926 full/108; 44 local-D1; static/build/migration/schema
PASS, repeated from a clean exact-SHA checkout with empty status. `t09/FINAL_PATCH_VERIFICATION.md`.
**READY FOR FINAL MAIN MERGE REVIEW**: no P0/P1 or known merge-blocking P2 remains.

## Historical backfill compatibility state — superseded by bf391c5

`vn-2e/frigo-dev` / `hoplite/kydonia-2785bb72`.
Final application freeze **`df73bc035c2938b6fd082c57f6bca89a82d8e443`** is published/fetched.
Real backfilled PATCH now passes: persisted `legacy_item_id` plus the exact same-household
adoption effect authenticates synthetic identity, with all live parity checks retained.
619 focused/nine files; 2,910 full/107; 42 local-D1; static/build/migration/schema
PASS, repeated from a clean exact-SHA checkout. `t09/FINAL_PATCH_VERIFICATION.md`.
**NOT READY FOR MAIN**: unchanged v2 FEFO SQL still excludes synthetic mappings;
its preflight stays fail-closed pending separate schema authorization.

## Historical PATCH parity state — superseded by df73bc0

`vn-2e/frigo-dev`, `hoplite/kydonia-2785bb72`; final application freeze
`e796f695bdb4228853992cdedc4e3cecf3437adb` is published/fetched.
Both external PATCH findings reproduced and fixed: complete semantic receipt replay
and atomic category parity (including metadata-only optimistic versions).
515 focused/six files; 2,865 full/106; 40 isolated local-D1; all static/build/local
schema/migration gates PASS. Full clean-checkout receipt: `t09/FINAL_PATCH_VERIFICATION.md`.
**NOT READY FOR MAIN**: inherited backfilled-lot PATCH refusal is a separately
scoped P1. The GLM freeze and Astra first fix below are historical, not final freezes.

## Historical evidence — all prior freeze/readiness claims below are superseded

## Current authoritative state — 2026-09-11

Repository **vn-2e/frigo-dev**. Application freeze `9bf9ac0fe7b5e0d39615f39ae5cc30f84569af2f` on `hoplite/kydonia-2785bb72` (successor of read-only
base `hoplite/kos-2a686759` at `aa44d2a2f80ea33fd4b328aba906660c0129051e`); fetched equality PASS. Atomic
receipt-backed adoption (0028) with empty-household evidence; all inventory writers
serve adopted households via the lot authority or fail closed; G concurrency and
tenancy matrix PASS. Full gates at this checkpoint: **2,837 tests / 105 files PASS** (155s), including the new 19-test adoption suite, 9-test G concurrency matrix and rewritten 14-test writer-fence suite; 38 isolated real local-D1 tests PASS; lint PASS; typecheck PASS; build PASS; 28-migration smoke PASS; local D1 schema gate PASS (0028 required).
Independent review follow-up `27427383d61930ea1b67ccbc1d69bb1cc069f931` is now the
published candidate: it fixes adopted PATCH response-loss replay and passed 2,838/105
full tests plus lint/typecheck/build/migration smoke.

## Historical recovery checkpoint (superseded)

Repository **vn-2d/frigo-dev**, writable successor **hoplite/kos-2a686759**.
Application `aa43e069edbff7843e9eb7532ff386b27be96a17` published/fetched with
equality and interrupted-F ancestry PASS. Fresh 1,347 focused / 2,808 full tests,
static/build/27-migration gates PASS. Pure adoption planning and legacy writer/retry
safety are implemented; atomic adoption and functional adapters remain F work.
A–E COMPLETE, F IN_PROGRESS, G/H NOT_STARTED; no freeze/readiness. Current authority:
`t09/CONTINUATION.md`. Previous repository names/statuses below are historical
provenance only. Next: v3 atomic adoption, adapters, G, H.

## Historical pre-transfer state

## Published E / active F — 2026-09-11

E published/fetched: `9bd1e6bc000cd2e94121469babb1a5eb63a5047f` on the authorized
successor; exact equality and frozen-D ancestry PASS. Final E: 1,172 focused,
2,659 full / 98 files, lint/typecheck/build, 27-migration replay and isolated
local-D1 schema PASS. Scoped E review has no remaining P1/P2 findings. F adoption/
writers is in progress; DEC-012 guest preflight safety first. G/H remain pending,
application not frozen and T09 not ready for independent review. The local-only
E publication/full-gate statements below are historical prepublication evidence.

## T09 continuation takeover — 2026-09-11

Current repository: green-1a/frigo-dev. Writable continuation:
hoplite/orchemenos-e002591e. Frozen T09D base: hoplite/euhesperides-d77023a5 at
811f7e8463303e010199741d66f88ab8a817212d. Last verified application: b036b257a8ad775dd6f1a445dcfdcce38a6babf1.
Ancestry and publication-first PASS: successor docs 8bf32ed4e41ed3341215c6376e0c13ef13043616
published/fetched before E. A–D complete; E locally implemented but uncommitted,
final review/publication pending; F–H pending. Internal FEFO supports one atomic
1–32-effect v2 receipt/event batch, exact g/ml/piece (kg/l normalized), bounded
JSON/1,000-lot snapshots and additive 0027 with historical v1 authority retained.
No adoption, live writer, HTTP or UI changes. Latest post-fence: 1,172 focused /
11 files (35 actual local D1 tests) and static/build/migration smoke PASS. Latest
full rerun pending; earlier 1,170 focused / 2,657 full results predate the fence.
Isolated 27-migration local D1 apply/schema gate PASS. Final full gate/review and
E commit/publish/fetch/equality are next, before F.
Exact evidence/fixes: `t09/VERIFICATION.md`; branch policy: `t09/CONTINUATION.md`.
IN_PROGRESS, not frozen/review-ready.

## Historical T09D development checkpoint — 2026-09-10

Program: Inventory Truth Layer
Current Task: T09 — Inventory Lot Engine & Event Authority
Current Phase: T09D complete and published; E–H pending
Status: IN_PROGRESS
Canonical Development Repository: vn-2b/frigo-dev (user-confirmed owner correction)
Legacy Production Repository: Tungjpstore/Frigo (user packet; not accessed)
T09 Remote Branch: hoplite/euhesperides-d77023a5
T09 Base T08 SHA: 8f8788c1a0c9e486657751ef3875a5baa5334dec
frigo-dev/main SHA at T09 start: d1b06732f8a80db4e77986df31ff28d9f04641fa
Last Verified Remote SHA: b036b257a8ad775dd6f1a445dcfdcce38a6babf1
Do Not Merge To Main: YES
Do Not Sync From Legacy Frigo: YES
Production Deployment Allowed: NO
Staging Deployment Allowed: NO
Remote D1 Allowed: NO
PayOS Allowed: NO

Publication-first and A/B checkpoints published/fetched. C adds native atomic
executor, additive 0024, receipt/event/projection coupling and local D1 proof.
Unadopted/mixed legacy households fail ADOPTION_REQUIRED; no native HTTP route
or legacy writer cutover. Latest exact verification: t09/VERIFICATION.md.
Published C checkpoint 13133b3: 507 focused, 1,994 full / 93 files,
lint/typecheck/build, 24-migration/local schema PASS; remote worktree 507 PASS.
D adds validated historical replay and 0025/0026 event/effect/poststate guards.
Final local gates: 1,031 focused, 2,518 full / 95 files, lint/typecheck/build,
26-migration/local schema PASS. Three reproduced authority findings fixed.
Published/fetched D code b036b25; exact local/remote equality PASS. Independent
fetched-source worktree: 1,031 tests and typecheck PASS, clean source.
Next: E FEFO followed by F adoption/writer migration.
No T09 completion or application-freeze claim; G/H full acceptance remains pending.
Managed setup claim failed; existing setup executed successfully via shell.
Pre-existing settings overlay preserved in local named stash; see t09/SESSION_LOG.
Legacy SHA unavailable; production deltas intentionally pending reconciliation.

## Historical T08 completion receipt (superseded current-task fields below)

Updated: 2026-09-10 UTC, final verification and authorized publication
Current Task: T08
Current Phase: T08F Verification/Handoff — complete
Status: COMPLETE
Canonical Branch: hoplite/xanthos-7d942897 (user-approved handoff/publication branch; DEC-006)
Original Local Branch: feature/t08-inventory-truth-foundation (historical, not the remote handoff)
Base Main SHA: d1b06732f8a80db4e77986df31ff28d9f04641fa
Current HEAD: fb00f46d4633c9659e812be9f86119533973a8bd (verified/published checkpoint before this docs-only completion receipt; resolve final tip with git rev-parse HEAD)
Last Code SHA: dd2ecc6f7066250dfdc5214a3d6c356e1479b61e
Last Verified SHA: fb00f46d4633c9659e812be9f86119533973a8bd (source identical to Last Code SHA)
origin/main SHA: d1b06732f8a80db4e77986df31ff28d9f04641fa
Main Has Diverged Since Base: NO (final fetch)
Do Not Merge To Main: YES
Production Deployment Allowed: NO
Remote D1 Migration Allowed: NO
Branch Pushed: YES — authorized branch, confirmed by trusted publish and fetch

## Completed

T08A–F: dependency audit; strict location/lot/quantity/money/expiry/provenance
contracts; additive 0023 schema; explicit guarded insert-only legacy backfill;
compatibility projection; diagnostic parity; cross-account Git handoff.

Fresh final-session PASS: 130 focused tests, full 1,617 tests / 89 files, lint,
typecheck, build, 23-migration clean replay, populated 0022 upgrade, local D1 schema
gate and Git diff checks. Prior local D1 apply of all 23 migrations also passed.
All code/checkpoints are preserved in the authorized published lineage. Source,
tests, schema and scripts are unchanged since dd2ecc6; later commits are docs-only.
See T08_VERIFICATION.md and VERIFICATION.md for exact evidence and corrected failures.

## In Progress

None for T08. This docs-only completion receipt is published on the same branch.

## Not Started

T09–T12; no automatic authorization to start them. No production/staging rollout,
remote D1 migration, live lot dual-write or consumer cutover.

## Known Problems / Accepted Limits

No unresolved verification or publication failure. Historical canonical-name
publication denials are resolved by the user's explicit branch substitution,
not by bypassing broker authority. Historical logs remain append-only.

Sub-milli/overflow/invalid quantities fail backfill without rounding. Raw invalid
or unknown expiry remains unpromoted. Contextual/unmapped lots do not pool blindly.
Snapshots are not live authoritative stock: legacy mutations/guest transfers cause
parity drift, never implicit lot changes. Money supports VND/JPY/USD/EUR only.

## Exact Next Action

The next account should fetch/check out `origin/hoplite/xanthos-7d942897`, read the
six handoff documents in order, then diff Last Verified SHA..HEAD. Its expected
remaining diff is documentation-only. Review the T09 prerequisites in
T08_VERIFICATION.md; wait for a separate T09 task. Do not merge/rebase main,
force-push, deploy, touch remote D1 or modify PayOS.
