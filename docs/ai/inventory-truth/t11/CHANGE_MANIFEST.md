# T11 change manifest

## Claim: canonical inventory read authority (freeze `657201f`)

| File | Change |
| --- | --- |
| `packages/domain/src/inventory-read-authority.ts` | New — `InventoryReadItem` canonical read model + query/result/diagnostic types; UNKNOWN≠ZERO, ESTIMATED≠CONFIRMED preserved |
| `packages/domain/src/index.ts` | Barrel export for the read model |
| `packages/db/src/inventory-read-authority.ts` | New — `readInventoryAuthority` / `readInventoryLot` / `readInventorySummary` / `assertProjectionParity`, `InventoryReadAuthorityError` taxonomy; single-batch coherent snapshots over `readAdoptedLotSnapshot`; fail-closed corruption handling; bounded (1000) |
| `packages/db/src/inventory-lot-commands.ts` | Export `exactLegacyQuantity`, `authoritativeMapping`, `MappedLotSnapshot` for reuse (no behavior change) |
| `src/worker/routes/inventory.ts` | `fetchHouseholdInventoryFromDb` cutover: adopted households read authority (KV bypassed, fail closed); legacy households unchanged; `inventoryReadItemToApi` API-compatible projection; `actorId` read option |
| `src/worker/routes/recipes.ts`, `src/worker/routes/scans.ts` | Thread `actorId` through authority-backed funnel reads |
| `src/worker/routes/week.ts` | Thread `actorId` through `fetchWeekInventory` (authority reads) |
| `src/worker/routes/notifications.ts` | Expiring-items banner derives freshness from authority for adopted households; legacy SELECT kept for non-adopted |
| `tests/integration/inventory-read-authority.test.ts` | New — 17 tests (see TEST_MATRIX) |
| `docs/ai/inventory-truth/t11/*` | READ_CONSUMER_MAP, TEST_MATRIX, VERIFICATION, CHANGE_MANIFEST, CONTINUATION, README |

No migration (count stays 30); no writer-authority changes; no PayOS/payment
touch; no legacy table deletion; T12 NOT STARTED.

## Corrective commits on the published branch

- `c7e2296` — platform PR tooling auto-commit of the untracked
  `.hoplite/settings.json` workspace overlay (known pitfall from T10).
- `4553b8a` — corrective removal of the overlay from the branch tree; the
  workspace file remains byte-for-byte (SHA-256 `6d8f5b45…`). Branch tree
  identical to the freeze for all product paths.
