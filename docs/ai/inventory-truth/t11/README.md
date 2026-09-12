# T11 — Inventory Read Authority & Projection Cutover

Task packet: make the T09/T10 Inventory Truth Layer the canonical READ authority
for inventory-dependent product flows while preserving bounded legacy
compatibility and proving no consumer can silently read stale/divergent
inventory state.

## Canonical answer (the T11 question)

"When any Frigo product flow asks what inventory currently exists, what exact
authority does it read?"

- **Adopted households**: `inventory_lots` + validated authority metadata
  (retained legacy mapping, storage locations, ingredient registry,
  `households.inventory_version`) through
  `packages/db/src/inventory-read-authority.ts`. The compatibility projection
  `inventory_items` never decides inventory truth. Single-batch coherent
  snapshots; corruption fails closed; no dual-truth fallback.
- **Not-yet-adopted households**: the documented legacy compatibility read
  behind the T09 adoption gate (`readInventoryAuthorityMode`), unchanged.
- Reads never auto-adopt and never write.

## Documents

- `READ_CONSUMER_MAP.md` — repository-wide read consumer audit (production
  `UNKNOWN = 0`), classification table, identity/version semantics decisions,
  no-dual-truth contract.
- `TEST_MATRIX.md` — the 17-test read-authority suite mapped to requirements.
- `VERIFICATION.md` — freeze SHA, gate receipts, clean-checkout proof.
- `CHANGE_MANIFEST.md` — exact file changes.
- `CONTINUATION.md` — durable state for the next agent (T12 NOT STARTED).

## Deliverables (spec section → where)

| Spec | Delivered |
| --- | --- |
| §7 consumer audit | `docs/ai/inventory-truth/t11/READ_CONSUMER_MAP.md` |
| §8 canonical read model | `InventoryReadItem` (`packages/domain/src/inventory-read-authority.ts`) |
| §9 read service | `readInventoryAuthority` / `readInventoryLot` / `readInventorySummary` (`packages/db/src/inventory-read-authority.ts`): household-scoped, deterministic order, bounded (1000-lot justified FEFO bound), zod-validated rows, corruption fails closed, native + backfilled mapping, explicit terminal handling |
| §10 no dual truth | Adopted reads never consult the projection or stale KV on failure — fail closed |
| §11 pre/post adoption boundary | Explicit `readInventoryAuthorityMode` gate in the read funnel; non-adopted keeps legacy behavior; reads never write |
| §12 backfilled mapping | Retained `legacy_item_id` evidence; native equal-ID, synthetic LEGACY_BACKFILL, and mixed households all tested |
| §13 parity/drift | `assertProjectionParity` (bounded, diagnostic, never repairs): missing projection, quantity/unit/storage/version/expiry/opened/identity/terminal drift, mapping corruption |
| §14 HTTP read routes | `GET /inventory` serves authority content for adopted households with API-compatible identity (`id` = the id the T09 authority writes into `inventory_items`); additive authority fields |
| §15–19 consumer cutover | All inventory consumers route through `fetchHouseholdInventoryFromDb`, which is authority-backed for adopted households (recipes, scans list reads, weekly planner, notifications freshness); legacy-only raw reads documented behind authority-mode gates; AI context receives the same authority-derived rows |
| §20 version semantics | Not collapsed: `inventoryVersion` (snapshot freshness), `lotVersion` (T09 CAS), `version` (legacy projection CAS) documented in READ_CONSUMER_MAP |
| §21 consistent snapshot | One D1 batch per read (`readAdoptedLotSnapshot` substrate); READ vs CORRECT race test proves before/after coherence, never a hybrid |
| §22 bounds | `MAX_READ_AUTHORITY_LOTS = 1000` (justified FEFO bound); deterministic ordering; `READ_LIMIT_EXCEEDED` / `INVALID_READ_QUERY` |
| §23 terminal lots | Current views exclude CONSUMED/DISCARDED; explicit `includeTerminal` historical view; zero-quantity invariant enforced |
| §24 expiry semantics | `expiryAt` / `estimatedExpiryAt` / `expiryKind` preserved distinctly; UNKNOWN≠ZERO, ESTIMATED≠CONFIRMED |
| §25 unit semantics | Canonical g/ml/piece/pack/bunch/slice; kg/l round-trip exactness tested |
| §26 tenancy | Household fencing on every read; cross-tenant lot/legacy references → `LOT_NOT_FOUND` (no existence leak) |
| §27 corruption matrix | Corrupt lot row, broken mapping, duplicate mapping, tampered adoption evidence, invalid limits — deterministic domain errors, never projection fallback |
| §28 read/write races | READ vs CORRECT barrier test (coherent before/after), READ vs USE, READ vs T10 reconciliation |
| §29 observations non-authoritative | Permanent regression: OPEN observation claiming 4 vs lot 10 reads 10 until reconciliation commits |
| §31 projection not a cache fallback | Tampered projection (100) never leaks: read returns authority 8 (+ parity diagnostic) |
| §32 adoption gate | `readInventoryAuthorityMode` reused as the explicit gate; `ADOPTION_REQUIRED` for non-adopted authority reads |

## Note on the task packet

The packet text arrived truncated mid-§32; the visible requirements (§0–31 plus
the §32 adoption gate) were implemented in full, and the established train
conventions (freeze + docs + report format) were followed for completion.
