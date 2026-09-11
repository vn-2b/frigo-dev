# T10 test matrix

All rows PASS at application freeze `4c414fa7eb33329ee12936c0899644af67e48f07` (composition fix; `6c28858` historical).
Suites add `tests/integration/inventory-reconciliation-composition.test.ts` (19).

## Multi-field composition regressions (fix freeze)

| Requirement | Test | Result |
| --- | --- | --- |
| quantity + expiry → exactly 1 CORRECT | pure matrix | PASS |
| quantity + openedAt → exactly 1 CORRECT | pure matrix | PASS |
| expiry + openedAt → exactly 1 CORRECT (PROPOSE_CORRECTION) | pure matrix | PASS |
| quantity + expiry + openedAt → exactly 1 CORRECT | pure matrix | PASS |
| quantity + storage → 1 CORRECT + 1 MOVE | pure matrix | PASS |
| expiry + storage → 1 CORRECT + 1 MOVE (PROPOSE_CORRECTION, documented) | pure matrix | PASS |
| quantity + expiry + storage → 1 CORRECT + 1 MOVE | pure matrix | PASS |
| all four → 1 CORRECT + 1 MOVE | pure matrix | PASS |
| merged changes object carries every field | pure matrix `toEqual` | PASS |
| no duplicate CORRECT / MOVE; same lotId + version | `invariant()` on every case | PASS |
| single-dimension verdicts preserved | dedicated test | PASS |
| zero-quantity merge never fabricates terminalState | pure + db tests | PASS |
| boundary: two CORRECT / two MOVE / cross-lot / version mismatch / split CORRECTs / type mismatch | INVALID_DECISION; split-valid → OBSERVATION_STALE; zero mutation | PASS |
| native lot: one T09 CORRECT + one MOVE, version +2, exact replay, 4 altered-field conflicts, new key → NOT_OPEN | execution test | PASS |
| backfilled synthetic lot: same + projection coherent (no equal-ID assumption) | execution test | PASS |
| merged CORRECT-only = one T09 command, one expectedVersion | execution test | PASS |
| races: multi-field reconcile vs CORRECT / MOVE / FEFO | one winner, no partial correction, zero decision rows/receipts | PASS |

Historical matrix (unchanged, still PASS):
Suites: `tests/unit/inventory-observations.test.ts` (33),
`tests/integration/inventory-observations.test.ts` (22),
`tests/integration/inventory-observation-concurrency.test.ts` (4),
`tests/integration/inventory-observation-d1.test.mjs` (5, real workerd D1).

## T10D/T10E required unit tests

| Requirement | Test | Result |
| --- | --- | --- |
| Observation schemas | accepts complete input; requires ≥1 claim; requires subject identity; pairs quantity/unit and expiry/date; bounds sourceRef/note; rejects NUL | PASS |
| Confidence/evidence state | UNKNOWN/ESTIMATED cannot claim quantity; ESTIMATED evidence couples to ESTIMATED expiry kind only | PASS |
| Fingerprint/idempotency | deterministic across recordings; changes with semantics; identity repeats stable; timestamp-independent | PASS |
| Exact quantity comparison | 2 kg = 2000 g = 2,000,000 milli; 1.5 kg vs 2 kg proposal without rounding | PASS |
| Unit compatibility | pack vs pack comparable; pack vs g UNSUPPORTED (INCOMPATIBLE_UNIT) | PASS |
| Lot candidate matching | explicit lot id; retained legacy mapping; ingredient candidates; missing lot STALE; terminal lot STALE | PASS |
| Ambiguous candidate detection | two candidates → AMBIGUOUS; two unit-compatible → AMBIGUOUS | PASS |
| Expiry precedence | observed==confirmed MATCH; differing observed expiry → PROPOSE_EXPIRY_UPDATE; ESTIMATED vs confirmed → CONFLICT (authority retained); estimate upgrade when dates equal; ESTIMATED vs estimate mismatch → CONFLICT | PASS |
| Reconciliation classification | MATCH / PROPOSE_CORRECTION / PROPOSE_MOVE / PROPOSE_EXPIRY_UPDATE / CONFLICT / STALE / UNSUPPORTED / NO_ACTION all exercised | PASS |
| Stale observation detection | INVENTORY_VERSION_DRIFT; REFERENCED_LOT_TERMINAL; non-open → NO_ACTION | PASS |
| Unsupported evidence | name-only → IDENTITY_UNKNOWN; known ingredient, no stock → NO_MATCHING_LOT (no fabricated creation); pack→g INCOMPATIBLE_UNIT | PASS |
| Mixed-claim composition | quantity+storage → one CORRECT + one MOVE, same expectedVersion | PASS |
| Batch bound | 33 observations → OBSERVATION_BATCH_TOO_LARGE | PASS |

## Required integration tests

| Requirement | Test | Result |
| --- | --- | --- |
| Persist observation | records claim + household-authoritative inventory version | PASS |
| Replay same observation | replayed=true, single row | PASS |
| Conflicting same-key observation | IDEMPOTENCY_CONFLICT, single row | PASS |
| Unrepresentable quantity | UNREPRESENTABLE_QUANTITY, no row | PASS |
| Household isolation | household-scoped reads; foreign lot/projection reference aborts; foreign read → NOT_FOUND | PASS |
| Corruption | immutability triggers block SQL tampering; guard-dropped corruption → CORRUPT_OBSERVATION; duplicate identity/lifecycle/deletes abort; impossible unit CHECK aborts | PASS |
| Observation → MATCH | planner through db | PASS |
| Observation → CORRECT proposal | planner through db | PASS |
| Observation → MOVE proposal | planner through db | PASS |
| Confirm decision through T09 command | lot 10→8 piece via T09 CORRECT receipt+events; observation RECONCILED v2; decision APPLIED with command_id | PASS |
| MOVE decision through T09 | storage_location_id updated via T09 MOVE | PASS |
| Exact decision replay (response loss) | replayed=true; facts byte-identical; single decision row | PASS |
| Altered decision replay conflict | IDEMPOTENCY_CONFLICT; stock unchanged | PASS |
| Stale version | T09 USE after observe → OBSERVATION_STALE; nothing changed | PASS |
| Rollback on T09 failure | injected batch failure → all facts identical; clean retry works | PASS |
| T09 CAS abort | winner CORRECT commits while decision batch paused → decision fails closed, zero decision rows, observation OPEN | PASS |
| DISMISS | no stock mutation (lots/commands byte-identical), observation RECONCILED | PASS |
| Tenancy | foreign actor → OBSERVATION_NOT_FOUND (no leak); foreign observation + foreign lot proposal → fail closed on T09 | PASS |
| Backfilled synthetic lot | backfill → adopt → observation by legacyItemId → planner resolves synthetic lot → CORRECT applies (version 3 chain) | PASS |
| Native equal-ID lot | MATCH + DISMISS path | PASS |
| Missing observation / wrong version / invalid shapes | OBSERVATION_NOT_FOUND / OBSERVATION_VERSION_CONFLICT / INVALID_DECISION / OBSERVATION_NOT_ACTIONABLE | PASS |
| Snapshot reader household-scoped | foreign lot never appears | PASS |

## Concurrency matrix (controlled races)

| Race | Winner | Contender outcome | Result |
| --- | --- | --- | --- |
| reconcile / reconcile same observation, same key | first decision applies (8,000 milli, v2) | batch aborts; single decision row; later exact retry replays | PASS |
| reconcile / reconcile different decisions | first applies | contender aborts (observation not OPEN); exactly one decision | PASS |
| reconcile / FEFO USE | FEFO consumes 4 pieces once (6,000 milli, v2) | decision rolls back; zero decision rows; observation OPEN; no orphan events | PASS |
| reconcile / CORRECT | winner CORRECT 9 pieces | contender fails closed; no lost update | PASS |
| reconcile / MOVE | winner MOVE to FREEZER | contender fails closed; no lost update | PASS |

## Real D1 (isolated workerd/local D1, no remote binding)

| Requirement | Test | Result |
| --- | --- | --- |
| 0030 schema under real D1 | full migration replay through 0030; observation persists | PASS |
| One real atomic batch | decision → lot 8,000/v2, observation RECONCILED v2, decision row with command_id | PASS |
| Response loss + altered key | replay exact; altered → IDEMPOTENCY_CONFLICT 409 | PASS |
| Trigger battery | duplicate identity, evidence immutability, delete retention, lifecycle, decision guard (wrong version), command-household link — all abort | PASS |
| Cross-household | foreign lot reference → 'household mismatch' abort; same-household valid; delete retention | PASS |

## Migration/infrastructure assertions

- `tests/integration/inventory-truth.test.ts`: replays all 30 migrations, head = 0030 — PASS
- `tests/integration/recipe-foundation.test.ts` + `tests/e2e/planner-preview.test.mjs`: migration-head = 0030 — PASS
- `scripts/migration-smoke.sh`: 30 migrations + T10 object asserts + observation/dismissal behavioral smoke — PASS
- `scripts/d1-schema-gate.sql`: requires 0030, both T10 tables, all 8 T10 triggers — PASS
