# T09 controlled concurrency matrix

## COMPLETE — 2026-09-11 (9bf9ac0fe7b5e0d39615f39ae5cc30f84569af2f)

Controlled barrier races (pause after snapshot, release a known winner before a
stale contender) pass for every row below plus the adoption races. Evidence:
`tests/integration/inventory-concurrency.test.ts` (9 tests) with the native/fefo
writer suites and the adoption suite's G11/G12 cases. Property sweeps assert no
negative stock, no duplicate effects, monotonic versions, projection parity and
receipt/event agreement.

| Race | Required result | Status |
| --- | --- | --- |
| USE / USE | Winner consumes 7 of 10; contender stale; no negative stock | PASS |
| USE / DISCARD | Stale discard loses without evidence/projection drift | PASS |
| USE / CORRECT | Stale correction never overwrites consumption | PASS |
| DISCARD / DISCARD | Single terminal effect, one DISCARD event | PASS |
| MOVE / MOVE | Winner location preserved; contender stale | PASS |
| OPEN / OPEN | Deterministic no-op replay, no duplicate open effect | PASS |
| CORRECT / CORRECT | Stale correction loses | PASS (E native suites) |
| FEFO / FEFO | 6 of overlapping lots allocated once; no negative/duplicate | PASS |
| Same idempotency key | One durable effect/event set (E same-key suites) | PASS |
| Different keys | Household CAS still protects shared stock | PASS |
| G11 legacy vs adoption / two adoptions | One authority transition wins; loser replays/conflicts safely | PASS |
| G12 stale legacy after activation | Fence refuses inside the batch; zero drift | PASS |
| G7 duplicate event identity | Schema gate rejects duplicate receipt/event identity | PASS |
| G8/G9 isolation | Concurrent households independent; foreign lot/location/receipt rejected | PASS |

Full T09 matrix remains PENDING. C native tests already exercise controlled
USE/USE, USE/DISCARD, USE/CORRECT, same/different-key CREATE/mutation, membership
revocation, candidate phantom and location-change fences. Other pairs and multi-lot
FEFO remain required in E/G; this is not a full concurrency PASS.
Tests must pause after snapshots and before the atomic batch, then
release a known winner before a stale contender. Assert rows, events, command
results and legacy parity, not merely rejection or Promise.all completion.

D additionally verifies known-winner same-key races for all six native commands
and receipt-only OPEN/MOVE/CORRECT no-ops, including changed payload and actor
conflicts. Actual local D1 has 14 controlled same-key cases across CREATE/USE/
DISCARD/OPEN/MOVE/CORRECT/already-open OPEN, plus retained-state assertions and
poststate/late-event rollback. Receipt corruption recovery is covered at collision
and response-loss boundaries. This completes D's native idempotency scope, not
the distinct-key lifecycle pairs, FEFO or all-writer G acceptance below.

| Race | Required result | Status |
| --- | --- | --- |
| USE / USE | 10 eggs, use 7 twice: no negative stock or 14 consumed | PENDING |
| USE / DISCARD | One stale CAS loses without evidence/projection drift | PENDING |
| USE / CORRECT | Stale correction never overwrites consumption | PENDING |
| DISCARD / DISCARD | No duplicate discarded quantity | PENDING |
| MOVE / MOVE | Winner location preserved | PENDING |
| OPEN / OPEN | Deterministic no-op/replay, no duplicate open effect | PENDING |
| CORRECT / CORRECT | Stale correction loses | PENDING |
| FEFO / FEFO | Lots 2+8, competing use 6: never consume 12 | PENDING |
| Same idempotency key | At most one durable effect and event set | PENDING |
| Different keys | CAS still protects shared stock | PENDING |
