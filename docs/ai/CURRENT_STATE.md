# Frigo current state — isolated T09 development

## Current authoritative state — T10 multi-field reconciliation fix, 2026-09-11

Branch `hoplite/himera-6d3eda84-t10-observation-reconciliation`.
**New T10 application freeze: `4c414fa7eb33329ee12936c0899644af67e48f07`** — `fix(t10): compose multi-field
reconciliation commands atomically` — published/fetched, local == remote ==
clean-checkout SHA; the previous freeze `6c28858` is superseded (historical ancestor).
Reproduced P1: the planner collected per-dimension proposals independently, so one
lot could receive 2–3 CORRECT proposals (quantity/expiry/openedAt) plus a MOVE, mixed
claims took an expiry-only verdict, and split CORRECTs shared the `<decisionKey>#CORRECT`
client key (idempotency/CAS hazard). Fix: `composeProposals` merges all compatible
CORRECT changes into exactly one CORRECT plus at most one MOVE bound to the matched
lot/version (contradictions → CONFLICT `PROPOSAL_COMPOSITION_CONFLICT`); the decision
boundary independently enforces max one CORRECT / one MOVE / same lot+version / type
consistency and fails closed; CORRECT+MOVE composes through T09 `useCurrentLotVersion`
atomically. 19 permanent regressions (16 fail pre-fix). Gates: full 3,009/3,009 across
113 files; T10 focused 78/78; real local D1 49/49; lint/typecheck/build/30-migration
smoke/local schema/diff PASS — repeated from the clean detached exact-SHA checkout.
No migration; 0023–0030 untouched. Main NOT merged. Production NOT deployed. Remote D1
NOT touched. **T10 COMPLETE — READY FOR INDEPENDENT REVIEW.** T11/T12 NOT STARTED.

## Historical T10 state — initial freeze 6c28858 (superseded by 4c414fa)

Repository `vb-2f/frigo-dev` (repository ID 1364064929; task lineage `vn-2e/frigo-dev`).
Branch `hoplite/himera-6d3eda84-t10-observation-reconciliation`, the platform-verified
successor created from the configured train base after PR #1 merged the frozen T09
branch internally (train merge `668920fa462524e65a79d31a7b0844720baf38e0`; main
`d1b06732f8a80db4e77986df31ff28d9f04641fa` is untouched and NOT merged).
**T10 application freeze: `6c28858acd0627d2d602998107c2e260c5e4f0d5`** —
`feat(t10): add inventory observation reconciliation authority` — published/fetched
with local == remote == clean-checkout equality. T10 adds the observation/evidence/
reconciliation layer above T09 authority without any second stock writer: additive
`0030` observation/decision persistence (evidence never mutates inventory), a pure
deterministic planner (MATCH / NO_ACTION / STALE / AMBIGUOUS / CONFLICT /
PROPOSE_CORRECTION / PROPOSE_MOVE / PROPOSE_EXPIRY_UPDATE / UNSUPPORTED) with exact
milli quantities, name-matching refusal, contextual-unit refusal and confirmed-expiry
precedence, and a decision authority that composes existing T09 CORRECT/MOVE commands
in one atomic batch with receipt-backed response-loss replay and IDEMPOTENCY_CONFLICT
on altered semantics. Baseline before edits: 2,926/108 full, 44 real D1, all static
gates PASS. At the freeze: 2,990 full/112 files; T10 focused 1,097/19 files; real
local-D1 49/49; lint/typecheck/build/30-migration smoke/local schema gate (requires
0030)/diff PASS — all repeated from the clean detached exact-remote-SHA checkout with
empty status. No HTTP routes added (T09 precedent; T11 owns UX surfaces).
**T10 COMPLETE — READY FOR INDEPENDENT REVIEW.** T11 and T12 are NOT STARTED.
Exact evidence: `inventory-truth/t10/VERIFICATION.md`, `inventory-truth/t10/TEST_MATRIX.md`.

## Historical T09 state — FEFO v2 backfill compatibility (superseded as current; freeze remains a verified ancestor)

Repository `vn-2e/frigo-dev` (live origin `vb-2f/frigo-dev`, same lineage), branch
`hoplite/himera-6d3eda84`, the platform-verified successor checked out at the exact
previous docs HEAD `8552fe5337245f2ac8349933c02946bf7d9dcc8f` (`hoplite/kydonia-2785bb72` tip unchanged there).
**New final T09 application freeze: `bf391c5fdcdd9e9c2f2257db515815e082cb4381`** — `fix(t09): support backfilled
mappings in fefo authority` — published/fetched with local/remote equality PASS.
The last remaining P1 is fixed: FEFO v2 now serves legitimate adopted/backfilled
synthetic lot mappings. Equal-ID authority was replaced, not bypassed: additive
`0029_inventory_fefo_backfill_compatibility.sql` recreates only the two v2 FEFO
triggers so a lot acts under its legacy projection identity only when LEGACY_BACKFILL
provenance, source identity and the immutable adoption receipt prove the mapping with
a preserved version offset; prestate parity accepts the exact kg/l display aliases;
poststate guards stay strict and native equal-ID lots pass unchanged. P1 reproduced
first (13/13 new tests fail DRIFT_DETECTED on the pre-fix tree, zero mutation).
Fresh PASS: 1,237 focused/15 files (59.52s); 2,926 full/108 (118.20s); 44 real
local-D1; lint/typecheck/build/29-migration smoke/local schema/diff. Clean detached
exact-remote-SHA checkout repeated every gate: 2,926/108 (119.10s), 44 D1, empty
git status. NO GITHUB CI STATUS for the branch. No route invokes v2 FEFO; the adopted
cook path already uses synthetic-compatible v1 commands. Verdict: **READY FOR FINAL
MAIN MERGE REVIEW** (main not merged by this agent). Exact evidence:
`inventory-truth/t09/FINAL_PATCH_VERIFICATION.md`.

## Historical backfill compatibility state — superseded by bf391c5

Repository `vn-2e/frigo-dev`, branch `hoplite/kydonia-2785bb72`.
Final backfill compatibility application freeze: **`df73bc035c2938b6fd082c57f6bca89a82d8e443`**.
The inherited backfilled PATCH P1 is reproduced and fixed without migrations:
synthetic lot IDs are authenticated by the immutable mapping and exact household
adoption witness. Projection CAS, event IDs, replay and composition retain both identities.
Fresh PASS: 619 focused/nine files; 2,910 full/107; 42 isolated real local-D1;
all lint/typecheck/build/migration/local-schema/diff gates. Exact fetched SHA also
passed frozen install, full 2,910/107, all gates and 42 D1 tests in a clean worktree.
**NOT READY FOR MAIN**: the bounded shared-caller check found v2 FEFO still rejects
synthetic mappings in unchanged 0027 SQL. Its fail-closed boundary is preserved;
further compatibility needs separately authorized schema work, not a guard bypass.
Exact evidence and next action: `inventory-truth/t09/FINAL_PATCH_VERIFICATION.md`.

## Historical PATCH parity checkpoint — superseded by df73bc0

Repository `vn-2e/frigo-dev`, branch `hoplite/kydonia-2785bb72`.
New final application freeze: `e796f695bdb4228853992cdedc4e3cecf3437adb` (published/fetched equality).
External final review's storage replay and category parity defects were reproduced
and fixed. Complete normalized request presence/value is retained in native receipts;
CORRECT/MOVE/category commit atomically; historical response replay no longer reads
today's stock. Native commands without PATCH metadata are unchanged.
Fresh gates: 515 focused / six files, 2,865 full / 106 files, 40 isolated local-D1,
lint/typecheck/build/28-migration smoke/local schema/diff PASS.
Recommendation: **NOT READY FOR MAIN**. An inherited P1 remains: PATCH of an
adopted backfilled legacy lot rejects its legitimate distinct mapping with
`500 DRIFT_DETECTED`. No adoption/migration fix was attempted in this narrow task.
Exact clean-source evidence, historical SHAs and next action:
`inventory-truth/t09/FINAL_PATCH_VERIFICATION.md`.

## Historical evidence — all prior freeze/readiness claims below are superseded

## T09 F/G/H complete — 2026-09-11

Independent review follow-up `27427383d61930ea1b67ccbc1d69bb1cc069f931` is published on the same branch. It restores exact adopted PATCH response-loss replay before legacy version preflight, rejects altered key reuse, and retains normal CAS for a distinct key. Fresh full verification: 2,838 tests / 105 files PASS (165.25s), lint/typecheck/build and 28-migration smoke PASS.

T09F = COMPLETE, T09G = COMPLETE, T09H = COMPLETE (freeze + evidence). Application
freeze SHA: `9bf9ac0fe7b5e0d39615f39ae5cc30f84569af2f`, published/fetched on **hoplite/kydonia-2785bb72** with exact
local/remote equality; branch base `hoplite/kos-2a686759` is the platform read-only
configured base at `aa44d2a2f80ea33fd4b328aba906660c0129051e` and refused publication, so the verified successor
continues that exact lineage (same pattern as the prior transfer). A–E unchanged.
Full gates at this checkpoint: **2,837 tests / 105 files PASS** (155s), including the new 19-test adoption suite, 9-test G concurrency matrix and rewritten 14-test writer-fence suite; 38 isolated real local-D1 tests PASS; lint PASS; typecheck PASS; build PASS; 28-migration smoke PASS; local D1 schema gate PASS (0028 required).
Adoption: atomic receipt-backed `executeInventoryAdoption` (migration 0028), empty-household
activation evidence, executor-owned snapshot/authority validation, projection-compatibility
preflight. Every inventory writer now serves adopted households through the lot authority
(manual create/edit/discard, scan confirm, shopping import, cook) and fails closed with
`INVENTORY_AUTHORITY_REQUIRED` when mappings are incomplete; DEC-012 remains SAFE-DEFERRED.
G matrix: USE/USE, USE/DISCARD, USE/CORRECT, DISCARD/DISCARD, MOVE/MOVE, OPEN/OPEN,
FEFO/FEFO, receipt replay, duplicate event identity, household isolation, cross-tenant
identities, adoption races and stale-legacy-post-activation all pass with property sweeps.
Not authorized/started: main merge, deployment, remote D1, PayOS, T10. Independent
review readiness: READY FOR EXTERNAL ASTRA REVIEW (reviewer decides next steps).

## Historical continuation record — 2026-09-11 (superseded)

Latest verified/published application: `aa43e069edbff7843e9eb7532ff386b27be96a17`.
Same task, A–E COMPLETE; F IN_PROGRESS; G/H NOT_STARTED. F now has pure adoption
preparation, in-transaction legacy writer refusal for mapped households, scan/
shopping stock-revision fences, shopping claim/lease/response-loss recovery, and
server-scan confirmation recovery without duplicate manual additions. DEC-012 is
unchanged. No adoption activation or functional mapped-household adapters yet.
Fresh gates: **1,347 focused / 19 files**, **2,808 full / 103 files**, 38 actual
isolated local-D1 tests within those gates, lint/typecheck/27-migration smoke/build
and diff/protected-path checks PASS. Two scoped independent-review P2 findings
were fixed/retested; no remaining P1/P2 in this partial increment. Full F still
requires retained scan-intent validation, atomic adoption and all writer adapters.
Next: additive v3 atomic adoption authority, then functional adapters, G and H.
Detailed evidence/failures: `inventory-truth/t09/VERIFICATION.md`.

Canonical repository: **vn-2d/frigo-dev**. Writable successor:
**hoplite/kos-2a686759**, directly from verified interrupted F
`66858c5296b38715e4bfca77fca5eefe5adadf5a` on read-only prior continuation
`hoplite/orchemenos-e002591e`. Transfer/ancestry PASS; baseline 2,685 tests / 99
files, typecheck/lint/27-migration smoke/build PASS. At takeover: 18 ahead / 0
behind unchanged origin/main. Exact authority/evidence: `inventory-truth/t09/CONTINUATION.md`.
Earlier repository references are historical provenance only.

The following pre-transfer chronology is historical. Continuation was based on frozen T09D remote
811f7e8463303e010199741d66f88ab8a817212d. Successor documentation checkpoint
8bf32ed4e41ed3341215c6376e0c13ef13043616 was published/fetched before E code.
A–E complete; E published as `9bd1e6bc000cd2e94121469babb1a5eb63a5047f`.
Fetch/equality/ancestry PASS. F is in progress; G–H pending.
E adds deterministic 1–32-effect atomic FEFO, version-2 receipts/events and additive
0027; v1 authority and migrations 0023–0026 remain intact. No adoption, live writer,
HTTP or UI cutover. Latest post-fence gates: 1,172 focused / 11 files (35 actual
local D1 tests), 2,659 full / 98 files, lint/typecheck/build and migration smoke
PASS. Scoped independent E review has no remaining P1/P2 findings. Earlier
1,170 focused / 2,657 full results predate the ordered-receipt fence.
F first safety change implemented: DEC-012 guest transfers explicitly reject
before OTP/account/session or data mutation. Guest/auth/outbox focused 143 PASS;
full 2,685 / 99 files and lint/typecheck/build/27-migration smoke PASS. General
adoption and manual/scan/shopping/cook adapters remain next per
`inventory-truth/t09/F_ADOPTION_PLAN.md`. Full F completion is not claimed.
Exact chronology, limits and corrected failures: `inventory-truth/t09/VERIFICATION.md`.
See `inventory-truth/t09/CONTINUATION.md` for exact branch authority, checks,
publication restriction and preserved pre-existing settings overlay. All protected
surfaces untouched; no application freeze or independent-review readiness.

## Historical T09D checkpoint — 2026-09-10

Program: Inventory Truth Layer. Canonical repository: vn-2b/frigo-dev (user
confirmed). Branch: hoplite/euhesperides-d77023a5. Exact T08 base:
8f8788c1a0c9e486657751ef3875a5baa5334dec. Main anchor: d1b06732f8a80db4e77986df31ff28d9f04641fa.
Publication-first and A/B checkpoints published/fetched. T09C now implements
internal native command persistence with membership, CAS/revision fence, immutable
receipt/event and exact legacy projection; additive 0024 and actual local D1
rollback/executor tests. No HTTP exposure, historical adoption or old writer cutover.
Mixed legacy households fail closed with ADOPTION_REQUIRED. Full/native gates and
corrected findings are recorded in inventory-truth/t09/VERIFICATION.md.
Published C checkpoint 13133b3: 507 focused, 1,994 full / 93 files PASS;
lint/typecheck/build, 24-migration/local schema PASS; remote-source worktree 507 PASS.
T09D now validates retained receipt/event evidence, binds new events to declared
effects and actual written stock (additive 0025/0026), and rejects paired evidence
corruption. Final D gates: 1,031 focused / 2,518 full tests (95 files), lint,
typecheck, build, 26-migration replay/local schema PASS. D code checkpoint
b036b257a8ad775dd6f1a445dcfdcce38a6babf1 published/fetched with exact equality;
separate fetched-source worktree: 1,031 tests and typecheck PASS, clean tree.
Next: E FEFO and F legacy adoption/writer integration.
T09 remains IN_PROGRESS; no application freeze or independent-review readiness.
No main, legacy Frigo, production/staging, remote D1 or PayOS changes; no T10.
The release/T08 sections below are historical evidence, not current work authority.

## T08 COMPLETE — authorized publication (2026-09-10)

Repository `vn-2c/Frigo`. The user explicitly approved publication on
`hoplite/xanthos-7d942897` instead of the blocked original feature name (DEC-006).
That branch is now the canonical cross-account handoff; publish and fetch confirmed
`fb00f46d4633c9659e812be9f86119533973a8bd`, followed by this docs-only completion
receipt. Last code: `dd2ecc6f7066250dfdc5214a3d6c356e1479b61e`.
Base/final fetched main: `d1b06732f8a80db4e77986df31ff28d9f04641fa`, unchanged.

Implemented additive 0023 storage/lot schema, strict quantity/money/expiry/source
contracts, guarded insert-only legacy backfill, compatibility projection/parity.
No legacy API/read/write path cutover. Fresh final-session **130 focused tests**,
**1,617 full tests / 89 files**, lint/typecheck/build, 23-migration replay/local
schema and diff checks PASS. Prior sandbox-local D1 apply passed 23/23. Early
failures and publication denial are resolved and preserved in the evidence log.
No source/test/schema change since dd2ecc6; later commits are documentation-only.

Next action: next account checks out `origin/hoplite/xanthos-7d942897`, reads the
handoff and final report, and waits for a separately authorized T09 task. No T09
implementation, main integration or deployment is implied by T08 completion.

Read `inventory-truth/MASTER_CONTEXT.md`, `CURRENT_STATE.md`, `TASK_BOARD.md`,
`DECISIONS.md`, `VERIFICATION.md`, `SESSION_LOG.md` and
`inventory-truth/T08_VERIFICATION.md` and `tasks/T08-inventory-truth-foundation.md`
for exact evidence, final Git anchors, limitations and T09 prerequisites.
Main, production/staging, remote D1, PayOS and release operations untouched.

## Preserved T01–T07 release snapshot (not T08 deployment evidence)

## Release status

- T01-T07: COMPLETE.
- T01: **COMPLETE**
- T02: **COMPLETE**
- T03: **COMPLETE**
- T04: **COMPLETE**
- T05: **COMPLETE**
- T06A: **COMPLETE**
- T06B: **COMPLETE**
- T07: **COMPLETE**
- Release Integration: **COMPLETE**
- Release Publication: **COMPLETE**
- Main Integration: **COMPLETE**
- Main CI: **PASS**

## Authoritative source

- GitHub source of truth: main.
- PRODUCTION_APPLICATION_BASE_SHA:
  `23ef51d6ec12a5a3e319a2d941dca39d2775cb9d`.
- PRE_CLEANUP_MAIN_HEAD: `41d2de6bc76331322cc63e8038432b0b02f60da1`.
- APPLICATION INTEGRATION: complete in main at `23ef51d6ec12a5a3e319a2d941dca39d2775cb9d`.
- Verified application SHA: `0b20061e7dc7405df68b18a18da4166e09494ecd`.
- Verified release head: `0420807968538f61b669569d064c404f67032174`.
- Main head before this correction: `41d2de6bc76331322cc63e8038432b0b02f60da1`.
- The main merge tree is source-equivalent to the verified release head.
- Every change after the application base is documentation-only.

## Verification snapshot

| Gate | Result |
| --- | --- |
| Full suite | 1,487 tests / 87 files PASS |
| Focused T02-T07 | 819 tests / 40 files PASS |
| Clean D1 | 22 / 22 migrations PASS |
| Upgrade sanity | 0020 -> 0022 PASS |
| Existing data | 776 rows / 58 tables preserved |
| Browser | 264 assertions / 36 phases PASS |
| Payment-adjacent | 82 tests / 7 files PASS |
| Main CI | 34396319671 SUCCESS |
| Previous final-head CI | 34405307196 SUCCESS |

These are preserved release gates and were not rerun for this docs-only
reconciliation.

## Deployment and production boundary

- Previous release deploy workflow `34396457582`: **SUCCESS**.
- Previous docs-cleanup deploy workflow `34405457796`: **SUCCESS**.
- Release packaging completed.
- Staging was not provisioned; no staging deployment occurred.
- Production deployment: NOT PERFORMED.
- Production local reconciliation: NOT STARTED.
- Production DB migration: NOT PERFORMED.
- Planner rollout: NOT STARTED.
- Checked-in planner/UI/AI defaults remain under the existing rollout policy;
  live production values were not inspected.

## PR #8 metadata

PR #8 METADATA:

Authoritative GitHub state: `MERGED`, `isDraft=false`,
`mergedAt=2026-09-09T19:38:59Z`, `closedAt=2026-09-09T19:38:59Z`,
`mergeCommit=23ef51d6ec12a5a3e319a2d941dca39d2775cb9d`, base `main`, head
`hoplite/kirrha-5f4057f0` at `0420807968538f61b669569d064c404f67032174`.

Application integration and PR metadata are separate facts: application
integration is complete in main at `23ef51d`; PR #8 was already merged and was
not reopened, re-merged or modified.

## Kirrha archival state

Kirrha is two commits ahead of current main and differs in four `docs/ai/` files
only. There are no application differences on that historical branch that are
absent from main. Do not merge or revert kirrha.

## Protected areas

PayOS/payment code untouched.

No real payment performed.

## Next task

Next task: PRODUCTION-LOCAL RECONCILIATION

Production local reconciliation: NOT STARTED. Snapshot and compare the
currently running production-local source against the frozen GitHub main source
before any production update. Do not deploy, migrate production D1 or enable
planner flags in this bookkeeping task.

Record the new post-merge main SHA in the final operator receipt; the
pre-cleanup main head is `41d2de6bc76331322cc63e8038432b0b02f60da1`.
