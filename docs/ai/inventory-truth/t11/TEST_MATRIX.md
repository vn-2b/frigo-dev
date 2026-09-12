# T11 test matrix — read authority

All rows PASS at application freeze `657201f3a12f18dd96cc96adeac0dd1d3b75e6f4`
(`tests/integration/inventory-read-authority.test.ts`, 17 tests).

| Requirement | Test | Result |
| --- | --- | --- |
| §8/§9 canonical model: lots-only content, native + backfilled mapping, deterministic order | reads adopted inventory from lots only | PASS |
| §12 mapping evidence: `legacy_item_id` retained, never equal-ID assumption | same test + single-lot resolution | PASS |
| §25 units: kg, g, l, ml, piece exact round-trip | preserves unit semantics exactly | PASS |
| §23 terminal lots excluded from current view; explicit historical view | excludes terminal lots | PASS |
| §12/§26 single-lot resolution by lotId and legacyItemId; foreign refs `LOT_NOT_FOUND` | resolves single lots | PASS |
| §26 tenancy: household B sees only B stock (isolation, not emptiness) | household-scoped | PASS |
| §22 bounds: `READ_LIMIT_EXCEEDED`, `INVALID_READ_QUERY`, valid bound | bounds results | PASS |
| §29 observation non-authority: OPEN claim 4 vs lot 10 reads 10; post-reconciliation reads 4 | unconfirmed observations never override authority | PASS |
| §31 projection tamper: lot 8 vs projection 100 → read 8 + `QUANTITY_DRIFT` | projection tampering cannot leak | PASS |
| §27 broken/duplicate mapping → `ADOPTION_REQUIRED` (gate), no fallback | fails closed on broken mapping | PASS |
| §27 tampered adoption evidence → `CORRUPT_RECEIPT`, no fallback | fails closed on tampered evidence | PASS |
| §27 corrupt lot row (ACTIVE at zero) → `CORRUPT_LOT_ROW` | fails closed on corrupt lot rows | PASS |
| §11 non-adopted → `ADOPTION_REQUIRED` | requires adoption | PASS |
| §21/§28 READ vs CORRECT: paused writer → coherent before-snapshot, never hybrid | READ vs CORRECT | PASS |
| §28 READ vs USE; READ vs T10 reconciliation (DISMISS leaves stock) | READ vs USE/T10 | PASS |
| §14/§31 `GET /inventory` adopted: authority content, tampered projection ignored, compatible ids | GET adopted | PASS |
| §14 `GET /inventory` non-adopted: legacy response shape unchanged | GET legacy | PASS |
| §10/§21 funnel: KV bypass for adopted; authority failure fails closed (`InventoryReadError`) | funnel KV/fail-closed | PASS |

Real local D1 suites (T09 44 + T10 7 = 51) continue to pass unchanged — the
read cutover does not alter writer authority.

## Regressions fixed during the task

- `week.ts` `fetchWeekInventory` was missing the actor argument after the
  funnel cutover — caught by `inventory-writer-fence` shopping-import tests,
  fixed, re-verified (15/15).
