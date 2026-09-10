# T09 controlled concurrency matrix

All PENDING. Tests must pause after snapshots and before the atomic batch, then
release a known winner before a stale contender. Assert rows, events, command
results and legacy parity, not merely rejection or Promise.all completion.

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
