# T12 final authority map — one closed system (2026-09-12)

Final classification of every production inventory path after the T12
closed-loop task. Re-audited at the runtime-verification freeze `d156001` (fresh
grep: same fenced reader/writer set; UNKNOWN = 0; route-level and real-D1 proofs
added for the adopted shopping, cook and GET /inventory funnels). Base: T11 freeze `c15c9a8` + T12 closed-loop integration.
Architecture: external evidence → observation (T10) → reconciliation (T10) →
T09 command authority → `inventory_lots` → T11 read authority → product
consumers. **UNKNOWN production readers = 0. UNKNOWN production writers = 0.**
Re-audit 2026-09-12 (final release review, D2): one production reader — the
flag-gated meal-planning snapshot — had been left out of this map; it is now
classified `SAFE_DEFERRED` below with an explicit cutover condition
(`MEAL_PLANNER_AUTHORITY_CUTOVER`). The count of 0 UNKNOWN holds only with that
row present.

## Read classification (every production reader of stock)

| Path | Classification | Notes |
| --- | --- | --- |
| `GET /inventory` via `fetchHouseholdInventoryFromDb` (native branch) | `READ_AUTHORITY` | `readInventoryAuthority`; KV bypassed; fail-closed (`InventoryReadError`), never fabricated empty reads |
| `fetchHouseholdInventoryFromDb` (legacy branch) | `LEGACY_COMPATIBILITY` | Non-adopted households only, behind `readInventoryAuthorityMode`; removal condition = universal adoption |
| Recipes ingredient context (`recipes.ts` → shared funnel) | `READ_AUTHORITY` (adopted) | Uses `fetchHouseholdInventoryFromDb`; proof: `inventory-closed-loop.test.ts` (500 g authority beats 5 kg tampered projection; 300 g after USE) |
| Weekly planner stock read (`week.ts` `fetchWeekInventory` → shared funnel) | `READ_AUTHORITY` (adopted) | Regeneration sees new authority state (closed-loop test); no stale KV/projection |
| Scans list/current-inventory reads (`scans.ts` → shared funnel) | `READ_AUTHORITY` (adopted) | Scan-confirm candidates re-derive from `readAdoptedLotSnapshot` for adopted households |
| Scan confirm candidate grouping (legacy path) | `LEGACY_COMPATIBILITY` | Non-adopted confirmations only; adopted confirmations write T09 commands only; removal = universal adoption |
| Recipe cook deduction lookup (legacy raw row) | `LEGACY_COMPATIBILITY` | Native diversion at `recipes.ts:346` into `completeAdoptedCooking`; cannot mutate truth on adopted households |
| Week shopping-import match (legacy raw row) | `LEGACY_COMPATIBILITY` | Native diversion at `week.ts:1358` into `completeAdoptedShoppingImport` |
| Notifications expiry logic | `READ_AUTHORITY` (adopted) | Freshness recomputed from authority (`computeReadFreshness`); projection tamper cannot fabricate reminders; terminal lots silent (closed-loop test) |
| `readInventoryLot` / `readInventorySummary` / `assertProjectionParity` | `READ_AUTHORITY` | Single-lot / summary / diagnostic views over the same snapshot substrate |
| `inventory.ts` POST id-preflight (`GET inventory_items` by id) | `LEGACY_COMPATIBILITY` | Identity/tenancy guard only; reads no stock content; adopted creates divert to native adapter |
| `GET_INVENTORY_ITEM` preflights (legacy PATCH/DELETE) | `LEGACY_COMPATIBILITY` | Adopted PATCH/DELETE divert to native adapters |
| `readMappedLotSnapshot` legacy rows (T09 substrate) | `READ_AUTHORITY` input | Projection rows used for parity + retained unit label (label honored only while the row agrees with authority); never for quantity/state |
| `inventory_events` reads (audit/history) | `OBSERVATION_ONLY` / audit | Event log is audit evidence, never a read model |
| **Flag-gated meal-planning snapshot** — `packages/db/src/meal-planning-snapshot.ts:198–202` (`loadMealPlanningSnapshot`, `SELECT … FROM inventory_items WHERE household_id = ?`), consumed by `src/worker/services/meal-planning.ts` for every `/meal-planning/*` route (`src/worker/routes/meal-planning.ts`) | **`SAFE_DEFERRED`** | Reads the compatibility projection `inventory_items` (quantity/unit/freshness/expiry/storage) for planner ranking and shopping suggestions with **no adoption gate**: adopted households are reachable **if** `MEAL_PLANNER_ENABLED === 'true'`. Currently flag-gated/off (`MEAL_PLANNER_ENABLED` is not bound in `wrangler.jsonc`; routes return 404 `MEAL_PLANNER_DISABLED`). Read-only — never writes stock. For adopted households the rows are the T09 same-batch mirror, so they are normally coherent, but this reader is **not canonical authority and not drift-immune** (a tampered projection would be ranked as if true). Pre-existing on main, untouched by T08–T12. **Removal condition — `MEAL_PLANNER_AUTHORITY_CUTOVER`:** before `MEAL_PLANNER_ENABLED` can be enabled for adopted households, `loadMealPlanningSnapshot` inventory reads must be routed through the T11 Inventory Read Authority (`readInventoryAuthority` / `fetchHouseholdInventoryFromDb`) or an equivalent canonical authority adapter; the projection read may remain only for non-adopted households behind the same `readInventoryAuthorityMode` gate used by every other consumer. |
| Ad-hoc scripts/tests | `TEST_ONLY` | Excluded from production classification |

## Write classification (every production stock writer)

| Path | Classification | Notes |
| --- | --- | --- |
| `executeInventoryLotCommand` / `executeInventoryFefoCommand` | `COMMAND_AUTHORITY` | The only stock writer (T09); lot CAS + write-guard + command receipts + events + atomic projection mirror |
| `completeAdoptedCooking` / `completeAdoptedShoppingImport` / `confirmAdoptedScan` / adopted manual PATCH/CREATE/DISCARD adapters | `COMMAND_AUTHORITY` adapters | Route-level adapters into T09 commands for adopted households |
| `recordInventoryObservation` | `OBSERVATION_ONLY` | Never mutates stock (permanent regression: OPEN observation 7 vs lot 10 → read stays 10) |
| `confirmReconciliationDecision` | `RECONCILIATION_ADAPTER` | Accepted decisions compose into T09 commands only; DISMISS writes no stock command; claim-fence ensures exactly-once (closed-loop E2E test) |
| `executeInventoryAdoption` | `COMMAND_AUTHORITY` (controlled) | Explicit, receipted adoption; reads never adopt |
| Legacy writers (`inventory.ts:645/843/1022`, `recipes.ts:484`, `scans.ts:1148/1171`, `week.ts:1440/1463`, `SQL.INSERT/UPDATE/DELETE_INVENTORY_ITEM`) | `LEGACY_COMPATIBILITY` | Behind `runLegacyInventoryBatch` (T09 fence aborts under native authority) + native diversions; cannot mutate truth for adopted households |
| T09 projection mirror inside command batches | `COMMAND_AUTHORITY` | Same-batch projection coherence; drift triggers writer refuse (`DRIFT_DETECTED`) |

## SAFE_DEFERRED entries

1. **Meal-planning snapshot projection read** (`meal-planning-snapshot.ts:198–202`)
   — why: pre-existing T02–T04 planner input, never cut over because the feature
   is flag-gated off; reach: adopted households only if `MEAL_PLANNER_ENABLED`
   is turned on; truth risk: ranking could trust a drifted projection (no
   silent stock mutation is possible — read-only); removal:
   `MEAL_PLANNER_AUTHORITY_CUTOVER` (route the snapshot's inventory read through
   T11 authority for adopted households) **must land before the flag is enabled**.

## LEGACY_COMPATIBILITY entries — why / reach / removal / truth risk

1. **Legacy household read + 1h KV** — serves not-yet-adopted households.
   Adopted households cannot reach it (authority branch first, KV bypassed).
   Removal: universal adoption cutover. Cannot mutate truth.
2. **Legacy scan candidate grouping** — non-adopted confirmations. Adopted
   confirmations divert before grouping. Removal: universal adoption.
   Mutates truth only through the fenced legacy batch (aborted under native).
3. **Legacy cook deduction lookup** — non-adopted cooking. Adopted cooking
   diverts at `recipes.ts:346`. Removal: universal adoption. Cannot mutate
   truth on adopted households.
4. **Legacy week import match** — non-adopted imports. Adopted imports divert
   at `week.ts:1358`. Removal: universal adoption. Fenced as above.
5. **POST id-preflight / PATCH/DELETE preflights** — identity/tenancy guards
   and legacy row preflights. Adopted mutations divert to native adapters.
   Removal: when legacy PATCH/DELETE routes retire. Cannot mutate truth.
6. **Legacy fenced writers** — non-adopted stock edits. `runLegacyInventoryBatch`
   aborts whenever native authority is active. Removal: universal adoption.
   Cannot mutate truth for adopted households (proven by writer-fence suites).

## Semantics preserved (verified by permanent regressions)

- UNKNOWN ≠ ZERO, ESTIMATED ≠ CONFIRMED, OBSERVED ≠ VERIFIED, projection ≠
  authority, terminal ≠ active stock.
- Adopted + valid receipt + zero lots → native mode → `[]` (never legacy
  fallback because the result is empty; never auto-adoption during reads).
- Authority is `(quantityMilli, canonicalUnit)`; display uses only exact,
  agreement-gated kg↔g / l↔ml aliases; count/contextual units never convert.
- Invalid authoritative expiry fails closed (`CORRUPT_LOT_ROW`), never "fresh".
- Adoption remains explicit/controlled; T12 adds no auto-adoption path.

## Cache audit (§31)

- **Adopted current inventory: never cached.** `readInventoryAuthority` reads
  D1 directly; the funnel's native branch bypasses KV in both directions
  (proven: stale KV neither served nor written — real-D1 `/funnel` and
  integration tests).
- **Non-adopted legacy read only:** KV key `inv_${householdId}` (tenant-scoped),
  1h TTL, written only on the legacy branch; invalidated on legacy writes
  (`kv.delete` in `inventory.ts` legacy mutation paths).
- **What can never be cached:** authority reads, parity diagnostics, adopted
  notification freshness, scan-confirm candidate derivation, reconciliation
  snapshots. All of these must observe the latest committed D1 state.
- KV failure on the legacy branch degrades to a direct D1 read; KV failure
  cannot affect adopted households (bypassed before any KV call).
