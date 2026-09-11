# T09 change manifest

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
