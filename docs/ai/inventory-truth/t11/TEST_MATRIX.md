# T11 test matrix — read authority

All rows PASS at application freeze `c15c9a81fc4367b3506a7e2693798ebe1424b0a9` (`657201f` historical).
Suites: `tests/integration/inventory-read-authority.test.ts` (28) and
`tests/integration/inventory-read-authority-d1.test.mjs` (11, real workerd/D1).

## Hardening rows (new freeze)

| Requirement | Test | Result |
| --- | --- | --- |
| adopted-but-empty: receipt + zero lots → native, `[]`, no legacy/KV/auto-adoption | integration | PASS |
| adopted-but-empty: HTTP `GET /inventory` → 200 `{ items: [] }` | integration (Hono) | PASS |
| adopted-but-empty: real D1 mode/authority/funnel/no side effects | real D1 B | PASS |
| adopted household whose only lot became terminal → current `[]`, history DISCARDED/0 | integration + real D1 B2 | PASS |
| READ vs MOVE (before location/version, after new, never mixed) | integration + real D1 E2 | PASS |
| READ vs DISCARD (ACTIVE before, excluded after, history DISCARDED/0) | integration + real D1 E3 | PASS |
| READ vs FEFO (multi-lot; coherent before OR after; no cross-lot hybrid) | integration + real D1 E4 | PASS |
| READ vs CORRECT on real D1 | real D1 E | PASS |
| `activeCount` reflects filtered summary | integration | PASS |
| legacy 2 kg → 2 000 000 milli/g → API 2 kg; 1.5 l → 1 500 000/ml → 1.5 l; native 500 g → 500 g | integration + real D1 C | PASS |
| projection `999 kg` / malformed `bag` cannot alter authority or presentation | integration | PASS |
| `displayQuantity` never crosses semantic families | unit-style | PASS |
| `computeReadFreshness` deterministic; 6 invalid inputs never `fresh`; NaN clock rejected | unit-style | PASS |
| corrupt authoritative expiry in a lot row fails the read closed | integration | PASS |
| real D1: adopted native read, no legacy/KV fallback | real D1 A | PASS |
| real D1: synthetic LEGACY_BACKFILL mapping, API identity | real D1 C | PASS |
| real D1: projection quantity + storage drift immunity + parity diagnostics | real D1 D | PASS |
| real D1: tenancy (`LOT_NOT_FOUND` for foreign lot/legacy id) | real D1 F | PASS |
| real D1: non-adopted → `ADOPTION_REQUIRED` for authority, legacy funnel preserved | real D1 G | PASS |

Original rows (first freeze, still PASS):

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
