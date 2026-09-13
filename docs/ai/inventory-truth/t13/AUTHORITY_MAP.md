# T13 authority map — writer and reader audit

Scope: everything T13 adds or changes. T08–T12 classifications are unchanged
and remain authoritative in `../t12/FINAL_AUTHORITY_MAP.md`.

## Writer audit

**Question:** does T13 create a second thing that can change stock?

**Answer:** no. T13 adds exactly one new write statement, and it writes
evidence, not stock.

### Every SQL write statement added by T13

| Target table | Count | Kind | Classification |
| --- | --- | --- | --- |
| `inventory_observations` | 1 new statement | Guarded `INSERT` | **Evidence.** Not stock. |
| `scan_items` | `INSERT` / `UPDATE` | Scan draft + review state | **Evidence.** Not stock. |
| `scans` | `INSERT` | Scan header | **Evidence.** Not stock. |
| `inventory_lots` | **0** | — | Unchanged: T09 only. |
| `inventory_items` | **0** | — | Unchanged: T09 projection only. |
| `inventory_events` | **0** | — | Unchanged: T09 only. |

Verification command:

```
git diff -U0 -- packages src scripts | grep '^+' \
  | grep -oE "(INSERT INTO|UPDATE|DELETE FROM) +[a-z_]+" | sort | uniq -c
```

Result at the freeze commit: `inventory_observations`, `scan_items` and
`scans` only. **UNKNOWN = 0.**

### The one new writer, in detail

`guardedObservationInsertStatement` (`packages/db/src/inventory-observations.ts`)

- Writes **only** `inventory_observations`.
- Carries the *same* `READY` predicate as every other statement in the scan
  confirmation batch, so evidence and stock commit or roll back together —
  there is no window where stock exists without its evidence, or the reverse.
- Rides the **existing** T09 atomic batch. It does not open its own
  transaction, does not run its own fence, and cannot execute alone.
- Cannot change stock: an observation only becomes stock through an explicit
  reconciliation decision, which composes existing T09 commands.

### Stock changes in the receipt path

`confirmAdoptedScan` (`src/worker/routes/scans.ts`) changes stock **only** by
composing canonical T09 `CREATE` / `CORRECT` lot commands. It builds command
specs; it never writes a lot, item or event row itself.

Two bounded-identity helpers exist because real scan ids are 64-char digests:

- `scanCommandKey()` — collapses an over-long T09 client key to a stable
  digest instead of truncating it.
- `scanObservationSourceRef()` — same, for the T10 200-char source ref.

Both are deterministic, so a response-loss retry replays the same identity
rather than double-adding stock.

## Reader audit

**Question:** does T13 add any read of the legacy `inventory_items`
projection?

**Answer:** no.

| T13 file | `inventory_items` reads |
| --- | --- |
| `src/worker/routes/inventory-truth.ts` | 0 |
| `src/worker/utils/scan-evidence.ts` | 0 |
| `src/web/lib/inventory-truth.ts` | 0 |
| `src/web/services/inventory-truth.ts` | 0 |
| `src/web/pages/ReconciliationPage.tsx` | 0 |

Every new read composes a **certified** service:

| New route | Composes |
| --- | --- |
| `GET /inventory/summary` | T11 `readInventorySummary` |
| `GET /inventory/lots/:lotId` | T11 `readInventoryLot` |
| `GET /inventory/observations` | T10 `readInventoryObservations` + `planInventoryReconciliationForHousehold` |
| `POST /inventory/observations/:id/decision` | T10 `confirmReconciliationDecision` |

No reconciliation algorithm is reimplemented in route code. The frontend
submits **intent only**; the server re-derives and re-validates every proposal,
so a stale client plan is rejected rather than applied.

**UNKNOWN = 0** for both audits.

## Tenancy

Every new route is behind `tenancyGuard` and scoped to the caller's household.
Cross-tenant reads are indistinguishable from "no such thing": a foreign lot
returns `404 NOT_FOUND`, never a status that would leak existence. Non-GET
routes additionally pass through the shared rate limiter.
