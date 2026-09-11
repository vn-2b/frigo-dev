# T09 change manifest

## Current FEFO v2 backfill application — bf391c5fdcdd9e9c2f2257db515815e082cb4381

- `migrations/0029_inventory_fefo_backfill_compatibility.sql` (new, additive):
  drops and recreates only `trg_inventory_commands_fefo_authority_insert` and
  `trg_inventory_events_command_fefo_authority_insert`. Every retained guard is
  byte-identical to 0027 except: (1) the equal-ID terms are replaced by an
  authoritative mapping check — LEGACY_BACKFILL provenance, `source_id =
  legacy_item_id`, and the immutable adoption receipt binding household/actor/
  source version, `lotId`/`legacyItemId`, `after.householdId`/`createdAt`/
  `sourceType`/`sourceId`, `after.version <= l.version` and a preserved
  `version - legacy_version` offset; (2) prestate projection parity accepts the
  exact kg/l display aliases requireParity reconciles. The replacement checks are
  separate shallow trigger statements so D1's expression-depth limit (100) is met;
  the first attempt nested them inline and real D1 aborted every receipt insert
  with `Expression tree is too large`, which is why the restructure exists.
- `packages/db/src/inventory-lot-commands.ts`: FEFO admission is requireParity's
  authoritative mapping (the explicit equal-ID TS guard is removed, mirroring v1);
  `replayFefo` authenticates each effect via `authoritativeMapping(after,
  effect.legacyItemId, receipt.adoptedMappings)` instead of `legacyItemId ===
  after.id`; the FEFO lot CAS binds `legacy_item_id` with the mapped projection
  identity (`lotWrite(db, effect, effect.legacyItemId)`).
- `tests/integration/inventory-backfilled-fefo.test.ts` (new, 13 tests): real
  adoption fixtures covering single-lot, multi-lot, mixed native/synthetic with a
  kg display row, terminal/partial depletion, version-offset chain across
  FEFO/CORRECT/MOVE plus replay-after-later-writes, exact replay, changed-intent
  and changed-version same-key conflicts, distinct-key stale snapshot, lost
  response recovery, foreign actor/household isolation, four drift fail-closed
  cases, FEFO-vs-FEFO/CORRECT/DISCARD/MOVE races and a multi-lot allocation race.
- `tests/integration/inventory-backfilled-patch.test.ts`: the previously
  fail-closed v2 FEFO admission case now asserts the fixed success path with
  durable lot/projection/event identity.
- `tests/integration/inventory-fefo-schema.test.ts`: 0029 upgrade replay preserves
  all five 0027 v1/v2 trigger objects, v1 replay and native v2 still pass; a
  captured synthetic FEFO batch commits under 0029, is rejected without the
  adoption receipt, and is rejected when projection parity leaves the exact kg/l
  aliases.
- `tests/integration/inventory-lot-d1.test.mjs`: two real local-D1 workerd tests —
  adopted multi-lot FEFO with durable identity and replay, and a multi-lot
  backfilled FEFO race with one authority outcome (44 tests total).
- `tests/integration/inventory-truth.test.ts`, `tests/integration/recipe-foundation.test.ts`,
  `tests/e2e/planner-preview.test.mjs`: migration-head assertions extended to the
  29th migration.
- `scripts/migration-smoke.sh`: replays 0028 (previously missing) and 0029 and
  asserts the adoption table/triggers; `scripts/d1-schema-gate.sql` requires 0029.
- No route, adoption executor, 0023-0028 migration, auth, PayOS, other writer,
  production config or settings-overlay changes. Bounded caller audit: no HTTP
  route constructs v2 FEFO inputs; adopted cooking uses synthetic-compatible v1
  single-lot USE commands, so no route change was required.

## Historical backfill PATCH application — superseded by bf391c5

- `packages/db/src/inventory-lot-commands.ts`: bounded exact adoption mapping witness;
  preserve live parity; use projection identity in lot CAS and event insertion;
  authenticate replay mapping; advance mapped projection in composition. Retain the
  separately constrained v2 FEFO equal-ID boundary explicitly.
- `tests/integration/inventory-backfilled-patch.test.ts`: 43 permanent real-adoption
  cases, including T08-prepopulated adoption, PATCH matrix, rollback/replay, tenant
  and drift attacks, shared v1 commands and unchanged FEFO fail-closed behavior.
- `tests/helpers/inventory-lot-d1-worker.ts`: test-only authorized adoption endpoint.
- `tests/integration/inventory-lot-d1.test.mjs`: two actual D1 synthetic-mapping
  category-only/combined cases; total 42 tests.
- No application route, adoption executor, schema/migration, auth, other writer,
  production config or settings-overlay changes. Full evidence: `FINAL_PATCH_VERIFICATION.md`.

## Historical PATCH parity application — e796f695bdb4228853992cdedc4e3cecf3437adb

- `src/worker/routes/inventory.ts`: compare the complete normalized PATCH fingerprint
  including presence and version; hash bounded per-operation keys; validate both
  CORRECT/MOVE receipts; return retained results rather than mutable current rows.
- `packages/db/src/inventory-lot-commands.ts`: opt-in manual PATCH envelope in existing
  immutable native receipts, carrying projection metadata/result and request fingerprint;
  category/freshness in guarded writes, metadata-only revision advancement, full projection
  poststate guard. Ordinary native v1/v2 command/event semantics are unchanged.
- `tests/integration/inventory-patch-parity.test.ts`: 25 durable-state PATCH cases.
- `tests/helpers/inventory-lot-d1-worker.ts` and `tests/integration/inventory-lot-d1.test.mjs`:
  two targeted workerd/D1 cases; suite grows from 38 to 40.
- No migrations, adoption executor, scan/shopping/cook, payments or settings changes.
- Verification/status and inherited mapping blocker: `FINAL_PATCH_VERIFICATION.md`.

## Historical application manifests (superseded)

## T09F/T09G/T09H application 9bf9ac0fe7b5e0d39615f39ae5cc30f84569af2f

- `migrations/0028_inventory_adoption_authority.sql`: additive
  `inventory_adoption_receipts` (UNIQUE household, byte-bounded receipt) with
  immutable update/delete triggers; no 0023–0027 change.
- `packages/db/src/inventory-adoption-executor.ts`: atomic receipt-backed adoption
  — independent snapshot/authority read, pure plan validation, one fenced batch
  (CAS bump, receipt, missing locations, missing snapshots, mapping/terminal
  updates, poststate fence), projection-compatibility preflight, replay/conflict.
- `packages/db/src/inventory-lot-commands.ts`: snapshot gains activation evidence
  and household timestamps; executor admission requires receipt-backed adoption for
  LEGACY_BACKFILL provenance; requireParity accepts exact kg/l display aliases and
  adoption-evidenced provenance; prepare/compose/recover/execute split for single
  and FEFO commands; shared-snapshot composition (one household CAS, evolving lots);
  readAdoptedLotSnapshot + replayLotCommandReceipt adapter boundaries.
- `packages/db/src/inventory-writer-fence.ts`: authority-active predicate now
  includes adoption receipts (empty adopted households fence legacy writers);
  readInventoryAuthorityMode.
- `packages/db/src/inventory-truth.ts`: backfill refuses adopted households.
- `src/worker/utils/inventory-authority.ts`: route-layer failure/expiry mapping.
- `routes/inventory.ts`: POST /inventory/adopt (explicit authorized adoption),
  manual create/edit(composed CORRECT+MOVE)/discard adapters.
- `routes/scans.ts`: adopted confirmation composes CREATE/CORRECT commands with
  reviewed draft writes and the completion-last status flip in one batch.
- `routes/week.ts`: adopted shopping import composes lot commands with
  lease-guarded run/import bookkeeping, durable command completion last.
- `routes/recipes.ts`: adopted cooking plans FEFO-ordered multi-lot USE commands
  against one shared snapshot with the cooked_meals row in one atomic batch.
- New tests: `inventory-adoption.test.ts` (19), `inventory-concurrency.test.ts` (9);
  rewritten `inventory-writer-fence.test.ts` (14) for the adapter contract;
  migration-count/upgrade fixtures updated to the 28-migration chain;
  schema gate requires 0028.

## Transferred-repository F safety application aa43e06 (partial F)

- `packages/domain/src/inventory-adoption.ts`: pure bounded adoption preparation;
  no executor or activation.
- `packages/db/src/inventory-writer-fence.ts`: mapped-authority refusal and
  optional source-conditioned whole-stock revision fence in the writer batch.
- Worker `routes/{inventory,scans,week,recipes}.ts`: scoped fence integration;
  shopping acquisition fingerprint and durable response/lease replay recovery.
- `src/web/services/scans.ts`: original confirmation recovery after fetch/body
  transport failure; no shared HTTP, payment or authentication change.
- New `tests/unit/inventory-adoption.test.ts`, integration
  `{inventory-writer-fence,scan-response-loss,shopping-command-race}.test.ts`;
  extended local-D1 worker/test, sync and command-route fake coverage.
- Current authority, state, plan, writer map and evidence documents updated;
  old repository names preserved as historical provenance. No migration, dependency,
  production configuration or native v1/v2 executor changes in this checkpoint.

No actual adoption or functional mapped-household adapter yet; F/G/H incomplete.

## F safety checkpoint after published E (not full F completion)

- `src/worker/routes/auth.ts`: remove guest-only non-atomic ownership/cache
  transfer and false success flag; explicit valid-OTP preflight deferral before
  account/OTP/session mutations. No other authentication or payment policy changed.
- `src/worker/validation/schemas.ts`: comment clarifies retained deferred request
  contract; schema validation is unchanged.
- `tests/integration/inventory-guest-transfer.test.ts`: 25 real SQLite/Hono cases
  proving no transfer side effects and ordinary verification/reset controls.
- `tests/unit/sync.test.ts`: deferred HTTP error preserves guest outbox/scope;
  historical successful-server response compatibility stays tested.
- `tests/unit/auth.test.ts`: rename legacy JWT claim tests so they no longer
  pretend to authorize a live transfer; cryptographic expectations unchanged.
- `F_ADOPTION_PLAN.md`, DEC-012 and status/evidence docs record remaining F work.

Native persistence/migrations 0023–0027 are unchanged in this F safety checkpoint.

## T09E local implementation (uncommitted; final review/publication pending)

| Classification | Files | E change |
| --- | --- | --- |
| DOMAIN | packages/domain/src/inventory-fefo.ts | Exact canonical-unit parsing, bounded snapshot/effects, deterministic FEFO planner |
| PERSISTENCE | packages/db/src/inventory-lot-commands.ts | One atomic 1–32-effect USE batch, strict v2 replay/event bijection, snapshot/CAS/completion fences; fingerprint mode bound to result envelope before payload comparison |
| MIGRATION | migrations/0027_inventory_fefo_authority.sql | Additive v2 receipt prestate/envelope and event poststate authority; retain v1 predicates |
| TEST | tests/unit/inventory-fefo.test.ts | 20 parser, bounds, unit, tie-order and exact allocation tests |
| TEST | tests/integration/inventory-fefo.test.ts | 34 atomicity/replay/collision/tenancy/limit/race tests |
| TEST | tests/integration/inventory-fefo-schema.test.ts | 76 SQL/upgrade tests at post-replay-fix gate; 77 after ordered-receipt fence regression |
| TEST | tests/integration/inventory-lot-d1.test.mjs; tests/helpers/inventory-lot-d1-worker.ts | 35 actual local D1 tests total, including multi-effect rollback, ordered-receipt rejection and 32-effect maximum (34 before ordered-receipt regression) |
| TEST/GATES | tests/integration/inventory-truth.test.ts; tests/integration/recipe-foundation.test.ts; tests/e2e/planner-preview.test.mjs; scripts/migration-smoke.sh; scripts/d1-schema-gate.sql; scripts/d1-schema-gate.sh | Assert actual 0027/27 lineage and FEFO authority guards; no UI implementation change |

Exact gate chronology is in VERIFICATION.md. No migration-file duplicates in the
active migrations directory; ignored diagnostic artifacts are not migrations.
No historical adoption, live writer/HTTP/read cutover or F–H completion claim.

## Historical T09E single-effect audit (811f7e8 application tree)

| Assumption | Classification / E action |
| --- | --- |
| domain `inventory-lot-commands.ts`: USE/DISCARD `lotId`/`expectedVersion`, `SingleLotCommandPlan` | SAFE SINGLE-LOT PATH; reuse pure per-lot planning inside one new FEFO plan, never loop executor calls |
| db `inventory-lot-commands.ts`: `ReceiptResult.effects.max(1)`, result `lotId`/`version` | SAFE V1 ONLY; MUST ADD bounded versioned multi-effect receipt contract rather than weaken historical replay |
| same module: `replay` binds `result.lotId`/`version`, `receipt.events[0]` | SAFE V1 ONLY; MUST ADD v2 bijection, ordinal/order, count, intent, full before/after/delta/version verification |
| same module: `eventMetadata` one-entry allocation | SAFE PER-EFFECT V1 SHAPE; v2 adds schema/mode/ordinal/effectCount and retains full effect snapshots |
| same module: executor one projection/CAS/event | MUST ADD one multi-effect batch with per-participant guards and final cardinality/poststate fence |
| migration 0025: `$.effects[0]`, array length 1, singular result/fingerprint identity | HISTORICAL IMMUTABLE FILE; additive 0027 retains v1 trigger predicates and separately dispatches strict v2 authority |
| migration 0026: written-stock check for `$.effects[0]` only | HISTORICAL IMMUTABLE FILE; additive v2 per-effect full persisted poststate binding required |
| migration 0024 unique `(command_id, inventory_item_id)` event index | SAFE MULTI-LOT; already permits N distinct effect events and forbids repeated effect events |
| existing native command/event/schema/D1 test helpers using `effects[0]`, one event | HISTORICAL / SINGLE-LOT TEST ONLY; preserve as regressions and add distinct multi-effect coverage |

All live routes are still T09F work; no E HTTP exposure or legacy writer cutover.
The audit reserved 0027; the local E implementation above now uses that number.

## Historical T09B–D manifest (retained milestones)

| Classification | Files | Reason |
| --- | --- | --- |
| DOMAIN | packages/domain/src/inventory-lot-commands.ts | Six validated pure command planners, exact quantities, lifecycle, CAS expectations and bounded correction |
| PERSISTENCE | packages/db/src/inventory-lot-commands.ts | Internal native command executor; membership, snapshot/revision/CAS, receipt, event and exact legacy projection in one batch |
| MIGRATION | migrations/0024_inventory_lot_commands.sql | Additive receipts, projection identity, revision fence and mapped-lot/event protection; no automatic adoption |
| MIGRATION | migrations/0025_inventory_event_authority.sql | Bind new native event envelope, delta, reason and metadata to exactly one declared receipt effect; retain historical evidence |
| MIGRATION | migrations/0026_inventory_event_poststate.sql | Bind declared after snapshot to actual lot and core legacy projection at event insert; preserve already locally applied 0025 |
| TEST | tests/integration/inventory-lot-authority.test.ts | 306 exhaustive fingerprint/replay/no-op/tenancy/rollback and retained-corruption tests, including paired historical evidence |
| TEST | tests/integration/inventory-event-authority.test.ts | 196 SQL event-injection and paired receipt/event/poststate rejection tests; valid reordered JSON controls |
| TEST | tests/integration/inventory-lot-commands.test.ts | Native command parity, replay, failure rollback and controlled races |
| TEST | tests/integration/inventory-lot-schema.test.ts | Populated T08 upgrade, schema constraints, REPLACE bypasses, ownership and query plans |
| TEST | tests/integration/inventory-lot-d1.test.mjs | Real isolated workerd/D1 replay, RETURNING, late CAS rollback and actual executor replay |
| TEST | tests/helpers/inventory-lot-d1-worker.ts | Token-guarded test-only local Worker; never imported by production |
| TEST | tests/integration/inventory-truth.test.ts | Update latest migration/count to actual 0024/24 lineage only |
| TEST | tests/integration/recipe-foundation.test.ts | Update exact latest migration assertion only |
| TEST | tests/e2e/planner-preview.test.mjs | Update exact latest migration assertion only |
| TEST | scripts/migration-smoke.sh | Include additive 0024 and assert command/mapping/revision guards |
| TEST | scripts/d1-schema-gate.sql | Require 0024 table, columns and all safety triggers |
| TEST | scripts/d1-schema-gate.sh | Update success label to match verified 0024 scope |
| TEST | tests/unit/inventory-lot-commands.test.ts | 202 command contract, tenancy, timestamp, quantity and lifecycle checks |
| DOCUMENTATION | docs/ai/inventory-truth/t09/*.md | Publication-first cross-account review packet |
| DOCUMENTATION | docs/ai/tasks/T09-inventory-lot-engine.md | Active task boundaries and completion gates |
| DOCUMENTATION | docs/ai/inventory-truth/{MASTER_CONTEXT,CURRENT_STATE,TASK_BOARD,DECISIONS,VERIFICATION,SESSION_LOG}.md | Development identity, phase, decisions and evidence |
| DOCUMENTATION | docs/ai/{CURRENT_STATE,TASK_BOARD,HANDOFF}.md | Current program handoff, preserving historical release evidence |

API/SERVICE, LEGACY ADAPTER, SCAN, SHOPPING and COOK: no changes yet. No native
engine is exposed by HTTP. Existing live writers remain pending T09F integration.

D updates the native repository with strict retained result/receipt/event replay
validation (CORRUPT_RECEIPT), preserving later-stock-independent historical replay.
The test-only Worker adds a pre-write barrier; actual D1 coverage grows to 25 tests.
Schema tests grow to 26 with populated 0024 -> 0025 -> 0026 byte-preservation proof.
Latest-migration assertions and local schema/smoke gates now require 0026/26;
earlier 0024/24 entries above describe the C checkpoint, not current chain length.
