# T11 legacy read/write map — compatibility projection boundaries (2026-09-12)

Complements `READ_CONSUMER_MAP.md`: this file enumerates every remaining
production touch of the compatibility projection `inventory_items` and states
why each is legitimate under the T09/T11 contracts.

## Remaining production READS of `inventory_items`

| Location | Purpose | Gate that keeps it legacy-only | Classification |
| --- | --- | --- | --- |
| `src/worker/routes/inventory.ts` (`fetchHouseholdInventoryFromDb`, legacy branch) | Legacy household list read + 1h KV cache | `readInventoryAuthorityMode(...) === 'legacy'` — adopted households take the authority branch first (KV bypassed) | `INTENTIONAL_LEGACY_READ` |
| `src/worker/routes/inventory.ts:604` | POST idempotency: refuse reuse of a client id owned by another household | Identity/tenancy pre-check only — reads no stock content; adopted creates divert to `adoptManualInventoryCreate` | `INTENTIONAL_LEGACY_READ` (identity guard) |
| `src/worker/routes/inventory.ts` `GET_INVENTORY_ITEM` uses | Legacy PATCH/DELETE preflight | PATCH/DELETE divert to native adapters at `readInventoryAuthorityMode === 'native'` | `INTENTIONAL_LEGACY_READ` |
| `src/worker/routes/recipes.ts:398` | Legacy cooking per-deduction lot lookup | `recipes.ts:346` native diversion into `completeAdoptedCooking` (T09 FEFO/USE) | `INTENTIONAL_LEGACY_READ` |
| `src/worker/routes/scans.ts:993` | Legacy scan-confirm candidate grouping | `scans.ts:1138` native diversion into `confirmAdoptedScan` (re-derives from `readAdoptedLotSnapshot`; writes only T09 commands) | `INTENTIONAL_LEGACY_READ` |
| `src/worker/routes/week.ts:1405` | Legacy shopping-import stock match | `week.ts:1358` native diversion into `completeAdoptedShoppingImport` | `INTENTIONAL_LEGACY_READ` |
| `src/worker/routes/notifications.ts:26` | Legacy expiring-items banner | `readInventoryAuthorityMode === 'native'` branch reads authority first | `INTENTIONAL_LEGACY_READ` |
| `packages/db/src/inventory-truth.ts` (`LEGACY_SELECT`) | Adoption backfill source | The migration/adoption contract itself | `INTENTIONAL_LEGACY_READ` |
| `packages/db/src/inventory-lot-commands.ts` (`readMappedLotSnapshot` legacy rows) | Parity check of the projection against authority | Authority reads content from lots; projection rows used for parity + retained display unit label only | `AUTHORITY_LOT_READ` (parity input) |

**Production UNKNOWN readers: 0.**

## Production WRITES of `inventory_items` (T11 hardening adds none)

| Location | Kind | Fence |
| --- | --- | --- |
| `packages/db/src/inventory-lot-commands.ts:429,433` | T09 authority projection mirror (UPDATE/INSERT in the same atomic batch as the lot write) | The T09 writer itself |
| `src/worker/routes/inventory.ts:645` (create), `:843` (patch), `:1022` (delete) | Legacy writers | `runLegacyInventoryBatch` (T09 writer fence aborts when native authority is active) + native diversions |
| `src/worker/routes/recipes.ts:484` | Legacy cook deduction | `runLegacyInventoryBatch` at `:524`; native diversion at `:346` |
| `src/worker/routes/scans.ts:1148,1171` | Legacy scan confirm | `runLegacyInventoryBatch` at `:1231`; native diversion at `:1138` |
| `src/worker/routes/week.ts:1440,1463` | Legacy shopping import | `runLegacyInventoryBatch` at `:1579`; native diversion at `:1358` |
| `packages/db/src/queries.ts:7-9` | SQL constants | Only used via the fenced legacy paths above |

**Production UNKNOWN writers: 0.** No direct inventory SQL writes were
introduced by T11 or its hardening fix.

## Display-unit compatibility decision (Finding E)

Authority is always `(quantityMilli, canonicalUnit)`. Presentation (`quantity`,
`unit` in `InventoryReadItem` and the API row) uses the **retained legacy
display alias** only when all of the following hold:

1. the alias is one of the exact mass/volume aliases `kg→g`, `l→ml`;
2. the retained projection row supplies that unit *label* (never its quantity);
3. the alias quantity round-trips exactly to `quantityMilli` through the same
   `toLotQuantity` conversion the T09 projection writer uses.

Otherwise presentation is canonical (`g`/`ml`/`piece`/`pack`/`bunch`/`slice`).
Count/contextual units never convert (`pack→g`, `bunch→piece`, `slice→g` are
impossible by construction). Projection corruption (`999 kg`, `bag`) cannot
alter authority or presentation quantity: the read shows `2 kg` / `2000 g`
respectively, never `999`.

## Freshness hardening decision (Finding F)

`computeReadFreshness(expiry, state, now)` (domain) is deterministic and
injectable. Invalid or impossible authoritative expiry dates throw; the read
service maps that to `CORRUPT_LOT_ROW`. An invalid date can never decay to
`fresh`. The T09 snapshot schema (`z.string().date()`) rejects impossible dates
one layer earlier (`DRIFT_DETECTED`); both layers fail closed.

## Adopted-but-empty contract (Finding B)

Adoption gate = `EXISTS mapped lot OR EXISTS adoption receipt`. A household with
a valid receipt and zero lots is **native**: authority reads return `[]`, the
funnel returns `[]`, `GET /inventory` → `200 { items: [] }`; the legacy
projection and the KV cache are never consulted, and reading never adopts or
writes. If stale projection rows exist without lots, admission fails closed
(`ADOPTION_REQUIRED`) rather than serving them.
