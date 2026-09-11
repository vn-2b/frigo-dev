# T10 invariant matrix

Every T10 hard invariant with its enforcement point and test evidence. All rows
PASS at application freeze `6c28858acd0627d2d602998107c2e260c5e4f0d5`.

| # | Invariant | Enforcement | Evidence (test) |
| --- | --- | --- | --- |
| 1 | UNKNOWN != ZERO | Domain schema: `UNKNOWN`/`ESTIMATED` evidence cannot carry a quantity claim; planner treats ESTIMATED quantity as CONFLICT evidence, never a fix | unit: `enforces categorical evidence semantics…`; `treats an estimated quantity as conflict evidence…` |
| 2 | ESTIMATED != CONFIRMED | Evidence enum categorical; expiry precedence: ESTIMATED claim vs confirmed lot expiry → CONFLICT, authority retained; confirmed expiry only replaced by explicit decision | unit expiry precedence block (4 tests); integration: planner classification |
| 3 | OBSERVED != VERIFIED | Distinct categorical states; `VERIFIED` reserved for evidence cross-checked against immutable T09 receipts; no source auto-elevates | unit schema tests; TEST_MATRIX classification |
| 4 | Observation != inventory mutation | Migration 0030 contains no trigger writing inventory; db observation layer only INSERT/SELECT on `inventory_observations` | smoke: object/behavioral asserts; integration: dismissal test asserts lots/commands byte-identical |
| 5 | Evidence != truth | Planner classifies; every stock change requires an explicit confirmed decision (CORRECT/MOVE/DISMISS) composed through T09 | integration: decision authority block |
| 6 | No fabricated certainty (no fake 0.87 confidence) | Only 5 categorical evidence states exist; no float confidence field anywhere | unit schema tests |
| 7 | T09 authority is the only stock writer | `confirmReconciliationDecision` composes `composeInventoryLotCommands` (CORRECT/MOVE); all stock effects carry T09 receipts/events; no second ledger | integration: confirms CORRECT/MOVE through T09 (receipt `client_key`, `inventory_events` rows); concurrency F1–F5 |
| 8 | Deterministic identity/replay idempotency | Identity = (household, sourceType, sourceRef) + canonical semantic fingerprint; UNIQUE constraint + immutable-insert trigger; same payload replays, altered payload → IDEMPOTENCY_CONFLICT | unit fingerprint tests; integration replay/conflict tests; D1 tests |
| 9 | Identity never timestamp-based | Fingerprint excludes recording time; two recordings of identical evidence share identity | unit: `never derives identity from a timestamp` |
| 10 | Exact quantity semantics; no rounding | `toLotQuantity` exact milli normalization; sub-milli claims rejected `UNREPRESENTABLE_QUANTITY`; comparison by exact integer milli equality | unit exact-quantity tests; integration: unrepresentable rejection |
| 11 | No contextual unit conversion | pack/bunch/slice comparable only against same-canonical-unit lots; pack vs g → UNSUPPORTED/INCOMPATIBLE_UNIT | unit: contextual unit tests |
| 12 | Descending-authority matching; never name-only | Planner: explicit lotId > retained legacyItemId (from lots table mapping, never inferred) > canonical ingredient candidates; raw-name-only → UNSUPPORTED/IDENTITY_UNKNOWN | unit candidate matching block |
| 13 | AMBIGUOUS on multiple candidates; no guessing | >1 compatible candidate (or unit-compatible candidate) → AMBIGUOUS, no proposal | unit AMBIGUOUS tests |
| 14 | STALE detection, no silent overwrite | Observation records household `authoritative_inventory_version` read from the household at record time; version drift → STALE_OBSERVATION; terminal lot → STALE; decision confirm re-plans and rejects drift (`OBSERVATION_STALE`) | unit staleness tests; integration stale test (T09 USE after observe); D1 guard test |
| 15 | Decision authority explicit + idempotent | Decision input schema (decisionKey, observationId, expectedObservationVersion, decisionType, proposals); UNIQUE(household, decision_key); fingerprint replay | integration response-loss + altered-key tests |
| 16 | Atomicity: decision + T09 mutation + receipt linkage one batch | Decision INSERT + observation UPDATE appended to composed T09 statements; single `db.batch`; decision-guard trigger aborts if observation not OPEN at expected version; CORRECT/MOVE decisions REQUIRE command receipt (`A stock-affecting decision requires its command receipt`) | integration rollback + CAS-abort tests; D1 trigger tests |
| 17 | Never mark APPLIED if command did not commit | Decision row and status RECONCILED live in the same atomic batch as the T09 command; batch failure rolls back everything | integration rollback/CAS tests; D1 batch test |
| 18 | Household tenancy, fail closed | Observation lot/projection household triggers; decision membership check (`authorizedHousehold`); foreign observation id → NOT_FOUND (no existence leak); foreign lot reference → abort | integration tenancy test; D1 cross-household test |
| 19 | Corruption fails closed, no silent repair | SQL-level evidence mutation blocked by immutability triggers; guard-dropped corruption → CORRUPT_OBSERVATION/CORRUPT_DECISION_RECEIPT; invalid transitions abort | integration corruption tests; D1 trigger battery |
| 20 | Bounded payloads and scans | sourceRef ≤200, note ≤1000, fingerprint/result_json byte CHECKs, observation batch ≤32, list limit ≤100, snapshot lots ≤1000 (LIMIT 1001 + explicit failure) | unit batch-bound test; integration INVALID_LIMIT; schema CHECKs |
| 21 | Read path unchanged (no observation-derived reads) | No read query reads `inventory_observations`; observation readers are household-scoped and T10-only | CHANGE_MANIFEST file audit; code inspection |
| 22 | Additive migration only; 0023–0029 immutable | 0030 only CREATEs; `git diff` of historical migrations empty | VERIFICATION migration receipts |
| 23 | Protected areas untouched | No PayOS/billing/checkout/payment file in the change manifest | CHANGE_MANIFEST |
