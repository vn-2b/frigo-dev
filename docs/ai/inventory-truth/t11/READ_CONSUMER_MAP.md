# T11 read consumer map — inventory read authority audit (2026-09-12)

Re-audited at the hardening freeze `c15c9a8`: production UNKNOWN readers = 0,
production UNKNOWN writers = 0, no new dual-truth fallback. Per-site fences for
every remaining projection touch are enumerated in `LEGACY_READ_MAP.md`, together
with the display-unit (kg/l alias), freshness fail-closed and adopted-but-empty
decisions.

Question T11 answers deterministically: **"When any Frigo product flow asks what
inventory currently exists, what exact authority does it read?"**

Answer after T11: adopted households read **`inventory_lots` + validated authority
metadata** (retained legacy mapping, storage locations, ingredient registry,
`households.inventory_version`) through `packages/db/src/inventory-read-authority.ts`
(`readInventoryAuthority` / `readInventoryLot` / `readInventorySummary` /
`assertProjectionParity`). The compatibility projection `inventory_items` never
decides inventory truth; observations are evidence only; the event log is audit
evidence, never a second read model.

Classification legend: `AUTHORITY_LOT_READ`, `COMPATIBILITY_PROJECTION_READ`,
`OBSERVATION_EVIDENCE_READ`, `EVENT_AUDIT_READ`, `INTENTIONAL_LEGACY_READ`,
`TEST_ONLY`, `UNKNOWN`.

## Production readers

| Reader | Location | Before T11 | After T11 (this task) |
| --- | --- | --- | --- |
| `GET /api/v1/inventory` (all product surfaces) | `src/worker/routes/inventory.ts:481` → `fetchHouseholdInventoryFromDb` | `COMPATIBILITY_PROJECTION_READ` (`SELECT * FROM inventory_items`) + 1h KV cache | **`AUTHORITY_LOT_READ`** for adopted households (coherent batch, KV bypassed, fail closed); `INTENTIONAL_LEGACY_READ` preserved for not-yet-adopted households |
| Recipe suggestion & cook paths | `src/worker/routes/recipes.ts` ×5 → same funnel | `COMPATIBILITY_PROJECTION_READ` | **`AUTHORITY_LOT_READ`** via the funnel (adopted); legacy paths untouched |
| Scan confirm "updated list" reads | `src/worker/routes/scans.ts` ×4 → same funnel | `COMPATIBILITY_PROJECTION_READ` | **`AUTHORITY_LOT_READ`** via the funnel (adopted); legacy paths untouched |
| Weekly planner swap alternatives + planning reads | `src/worker/routes/week.ts` `fetchWeekInventory` → same funnel | `COMPATIBILITY_PROJECTION_READ` | **`AUTHORITY_LOT_READ`** via the funnel (adopted) |
| Notifications "expiring items" banner | `src/worker/routes/notifications.ts:15` | `COMPATIBILITY_PROJECTION_READ` (raw SELECT on `inventory_items.freshness`) | **`AUTHORITY_LOT_READ`** for adopted households: freshness recomputed from authority expiry fields; legacy SELECT kept for non-adopted |
| Legacy cooking lot-lookup (per-deduction) | `src/worker/routes/recipes.ts:398` | `COMPATIBILITY_PROJECTION_READ` | `INTENTIONAL_LEGACY_READ` — reachable **only** on the legacy path; adopted cooking diverts at the `readInventoryAuthorityMode` gate into `completeAdoptedCooking` (T09 lot authority) |
| Legacy shopping-import stock match | `src/worker/routes/week.ts:1405` | `COMPATIBILITY_PROJECTION_READ` | `INTENTIONAL_LEGACY_READ` — legacy path only; adopted imports divert at `week.ts:1358` into `completeAdoptedShoppingImport` |
| Legacy scan confirm candidate grouping | `src/worker/routes/scans.ts:993` | `COMPATIBILITY_PROJECTION_READ` | `INTENTIONAL_LEGACY_READ` for grouping only — adopted confirmations divert at `scans.ts:1138` into `confirmAdoptedScan`, which re-derives everything from `readAdoptedLotSnapshot` and writes only through T09 lot commands; the legacy pre-grouping read cannot override lot authority |
| T09 writer authority reads | `packages/db/src/inventory-lot-commands.ts` (`readMappedLotSnapshot`, `readAdoptedLotSnapshot`) | `AUTHORITY_LOT_READ` | unchanged — now also the substrate of the T11 read service |
| T10 reconciliation reads | `packages/db/src/inventory-reconciliation.ts` | `AUTHORITY_LOT_READ` + `OBSERVATION_EVIDENCE_READ` | unchanged |
| FEFO planning reads | `packages/db/src/inventory-lot-commands.ts` (FEFO snapshot) | `AUTHORITY_LOT_READ` | unchanged |
| Event-sourced receipt replay (write-side audit) | `packages/db/src/inventory-lot-commands.ts`, T09 routes | `EVENT_AUDIT_READ` | unchanged; never used to reconstruct current stock |
| Observation persistence/reads | `packages/db/src/inventory-observations.ts`, T10 routes | `OBSERVATION_EVIDENCE_READ` | unchanged — evidence, not truth |
| Adoption backfill reader | `packages/db/src/inventory-truth.ts` (`LEGACY_SELECT`) | `INTENTIONAL_LEGACY_READ` | unchanged — explicitly the migration/adoption contract source |
| Notifications / week / recipes remaining table references | searched: `JOIN inventory_items`, CTEs, raw SQL in `src/worker/**` | — | all covered above; none remain unclassified |

## Non-production readers

- `tests/**` — `TEST_ONLY`.
- Web app (`src/web/**`) consumes HTTP APIs only; no direct inventory SQL.

**Production `UNKNOWN` count: 0.**

## Identity and version semantics (documented decisions)

- **API identity**: the historical API `id` stays the id the T09 authority writes
  into `inventory_items` — the retained `legacy_item_id` for backfilled lots and
  the lot id for native lots — resolved through retained mapping evidence
  (`legacy_item_id`), **never** by assuming `lot.id === legacyItemId`. The response
  adds `lotId`, `legacyItemId`, `lotVersion`, `quantityMilli`, `canonicalUnit`,
  `expiryKind`, `estimatedExpiryDate`, `state`, `inventoryVersion` additively.
- **Version semantics** (not collapsed): `households.inventory_version` = snapshot
  freshness evidence (`inventoryVersion` in reads; T10 staleness detection);
  `inventory_lots.version` = T09 command CAS (`lotVersion`); `inventory_items.version`
  = legacy projection CAS for the legacy PATCH path (`version` in API responses,
  unchanged client semantics; mirrors `legacy_version` for backfilled lots).
- **KV cache**: adopted-household reads bypass the 1h inventory KV cache in both
  directions (no stale authority serving, no authority caching); the legacy
  non-adopted path keeps its existing cache behavior.

## No dual truth

`fetchHouseholdInventoryFromDb` branches **only** on the T09 adoption gate
(`readInventoryAuthorityMode`): `native` → authority reads that fail closed on any
error (never a fabricated empty list, never the projection, never the stale KV);
`legacy` → the pre-T11 compatibility read for households the adoption contract
says are legitimately not adopted. Reads never auto-adopt and never write.
