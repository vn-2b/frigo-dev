# T12 final writer map — mutation classification (2026-09-12)

Every production path capable of changing stock. **UNKNOWN writers = 0.**
All adopted-household mutations resolve to T09 command authority; no new
`inventory_items` writer was introduced by T08–T12.

| Route/service | Command type | Authority adapter | Idempotency key source | CAS/version source | Event output | Projection update | Tenant fence | Retry semantics |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `POST /inventory` (adopted) | `CREATE` | adopted manual create adapter → `executeInventoryLotCommand` | client-generated `body.id` (`create-*` client key) | lot create (no prior version) | T09 event per command | same-batch mirror | household-scoped SQL + id ownership guard | exact replay → replayed receipt; altered key → `IDEMPOTENCY_CONFLICT` |
| `PATCH /inventory/:id` (adopted) | `CORRECT`/`MOVE` | adopted manual adapter (T09) | client request key | `expectedVersion` from client read | T09 events | same-batch mirror | household scope + lot scope | replay/conflict per T09 receipt semantics |
| `DELETE /inventory/:id` (adopted) | `DISCARD` | adopted manual adapter | client request key | `expectedVersion` | T09 event | same-batch mirror | household scope | replay/conflict per T09 |
| Cooking completion (adopted) | `USE`/FEFO | `completeAdoptedCooking` | cook action id | `expectedVersion` per consumed lot | T09 events | same-batch mirror | household scope | response-loss retry replays; never double-consumes |
| Scan confirm (adopted) | `CREATE`/`USE`/`DISCARD` per confirmation | `confirmAdoptedScan` (re-derives from `readAdoptedLotSnapshot`) | scan/confirmation id | snapshot versions | T09 events | same-batch mirror | household scope | duplicate scan same key → replay; changed payload → `IDEMPOTENCY_CONFLICT` |
| Shopping import (adopted) | `CREATE` (+leases) | `completeAdoptedShoppingImport` | import/receipt id | create semantics | T09 events | same-batch mirror | household scope | idempotent retry never double-adds (closed-loop test); lease/race protections intact |
| T10 accepted reconciliation | `CORRECT`/`MOVE` (composed ≤1+≤1) | `confirmReconciliationDecision` → `composeInventoryLotCommands` | `decisionKey` (`#CORRECT`/`#MOVE` suffixed) | `expectedVersion` read at compose; claim fence on observation | T09 command events + decision receipt (exactly once) | same-batch mirror | household scope + observation scope | exact replay → replayed; altered proposals same key → `IDEMPOTENCY_CONFLICT`; concurrent loser → claim-guard rollback (closed-loop E2E test) |
| Adoption execution | backfill/mapping | `executeInventoryAdoption` (explicit, controlled) | adoption request | snapshot `inventory_version` | adoption receipt | initial projection | household scope | receipted; re-adoption replays |
| Legacy writers (non-adopted) | legacy add/edit/delete | `runLegacyInventoryBatch` fenced | client id / request | `inventory_items.version` CAS | legacy events | direct (non-adopted only) | household scope + fence abort under native authority | unchanged legacy semantics |

## Verified invariants across the loop

- One stock writer: T09 command authority (with its route adapters). Everything
  else either observes, fences, or adapts into it.
- Every mutation emits events; the event log is audit evidence only.
- CAS/stale errors (`STALE_SNAPSHOT`, `STALE_VERSION`, `OBSERVATION_VERSION_CONFLICT`)
  never leak raw SQLite/D1 errors to API clients.
- Deterministic race coverage (barriers, no sleeps): READ vs CORRECT/MOVE/USE/
  DISCARD/FEFO/T10 (T11 suites + closed-loop suite), reconciliation vs
  reconciliation and vs DISMISS (T10 fence), reconciliation vs manual CORRECT
  (T12 closed-loop), scan/lease races (T09 writer-fence suites).
- Reads during multi-statement mutations see a legal BEFORE or AFTER state
  (single D1 batch = one transaction; proven on real workerd/D1 in T11).
