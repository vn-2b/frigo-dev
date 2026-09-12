# Inventory Truth release train — change manifest `d1b0673 → d156001` (2026-09-12)

Application release candidate: **`d15600186c3e73faba011eb690ac6cd70e8d3d2d`**.
Scope of diff: `git diff d1b06732 d1560018` — **120 files, +24,242 / −185**.
No binary files. No secrets (pattern scan of added lines: 0 hits). No dependency,
lockfile, wrangler, tsconfig or vitest config changes. No generated artifacts.

## MIGRATION (8 — all additive, introduced once, never modified)

| File | Introduced | Blob identical at RC |
| --- | --- | --- |
| `0023_inventory_truth_foundation.sql` | `cdffb42` (T08) | ✅ |
| `0024_inventory_lot_commands.sql` | `13133b3` (T09c) | ✅ |
| `0025_inventory_event_authority.sql` | `b036b25` (T09d) | ✅ |
| `0026_inventory_event_poststate.sql` | `b036b25` (T09d) | ✅ |
| `0027_inventory_fefo_authority.sql` | `9bd1e6b` (T09e) | ✅ |
| `0028_inventory_adoption_authority.sql` | `9bf9ac0` (T09) | ✅ |
| `0029_inventory_fefo_backfill_compatibility.sql` | `bf391c5` (T09) | ✅ |
| `0030_inventory_observation_reconciliation.sql` | `6c28858` (T10) | ✅ |

Migrations 0001–0022 are byte-identical to main. Count = 30, no duplicate numbers.

## DOMAIN (8)
`packages/domain/src/`: `index.ts` (M, barrel exports), `inventory-truth.ts`,
`inventory-lot-commands.ts`, `inventory-fefo.ts`, `inventory-adoption.ts`,
`inventory-observations.ts`, `inventory-reconciliation.ts`,
`inventory-read-authority.ts` (all A).

## DB (7)
`packages/db/src/`: `inventory-truth.ts` (backfill), `inventory-lot-commands.ts`
(T09 command/FEFO authority + projection mirror), `inventory-adoption-executor.ts`,
`inventory-writer-fence.ts` (legacy fence + adoption gate), `inventory-observations.ts`,
`inventory-reconciliation.ts`, `inventory-read-authority.ts` (T11) — all A.

## WORKER_ROUTE (6, all M)
`inventory.ts` (adopted adapters, T11 funnel cutover), `recipes.ts` (adopted cooking
adapter; T12 replay-first fix), `scans.ts` (adopted scan confirm), `week.ts` (adopted
shopping import), `notifications.ts` (authority freshness), `auth.ts` (**T09f
`66858c5`**: removed the legacy guest→account `UPDATE … inventory_items/inventory_events
SET household_id` transfer writer; now returns `409 INVENTORY_TRANSFER_DEFERRED` —
an intentional writer-audit closure, not an unrelated product change).

## API_OTHER (3)
`src/worker/utils/inventory-authority.ts` (A — error→HTTP mapping),
`src/worker/validation/schemas.ts` (M, 1 line), `src/web/services/scans.ts` (M —
client response-loss handling for scan confirmation, T09 scan hardening).

## TEST (38)
30 new inventory suites (unit + integration + 4 real workerd/D1 `.mjs` suites +
`tests/helpers/inventory-lot-d1-worker.ts` test-only worker), 7 modified existing
suites (`auth`, `sync`, `command-route-integrity`, `recipe-foundation`,
`planner-preview` — adjusted for the guest-transfer deferral and new route
semantics).

## DOC (46)
`docs/ai/inventory-truth/**` (task packets t09–t12, verification receipts, maps),
`docs/ai/tasks/T08…`, `T09…`, parent `CURRENT_STATE/TASK_BOARD/HANDOFF`.

## CONFIG (4)
- `scripts/migration-smoke.sh`, `scripts/d1-schema-gate.sql`, `scripts/d1-schema-gate.sh`
  (M — extended to read 0023–0030 and assert the Inventory Truth tables/triggers).
- **`.hoplite/settings.json` — D (deleted from the tree at `4553b8a`, T11).**
  Main tracks this file (blob `3818a00`, setup/run scripts for the Hoplite sandbox).
  PR tooling auto-committed a workspace overlay three times (`99e4b7b`, `a3abd6d`,
  `c7e2296`); T09/T10 restored the repo blob (`09f13c4`, `ab1e983`), T11 removed
  the path instead (`4553b8a`). Consequence: a merge into main would **delete** a
  tracked platform file. Classified **P2 (release hygiene, not application
  behavior)** — see the certification report for remediation.

## OTHER (0)

## Unexpected/unrelated product changes
None beyond the documented `auth.ts` guest-transfer deferral (T09 writer audit).
