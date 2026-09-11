# T10A — Observation source map

Audit date: 2026-09-11, at T09 final freeze lineage (`hoplite/himera-6d3eda84`,
application freeze `bf391c5fdcdd9e9c2f2257db515815e082cb4381`, docs HEAD
`d522769ae89496fd4b3f26419f1fdfe23d9e926a`).

Classification vocabulary used by T10:

| Class | Meaning |
| --- | --- |
| AUTHORITATIVE_MUTATION | Changes authoritative stock, only through the T09 lot authority |
| OBSERVATION | Produces evidence about stock; must never itself change stock |
| HEURISTIC | Derived/estimated claim with no direct observation behind it |
| LEGACY_PROJECTION | Legacy rows/caches that mirror stock for pre-T09 consumers |
| EXTERNAL_EVIDENCE | Evidence from outside the household's own assertions (receipts, scans) |
| UNKNOWN | Source inspected; classification not yet provable |

Per T10 invariants: an `OBSERVATION`-class source is allowed to *record*
`inventory_observations` rows (evidence persistence only). Stock changes happen
only when an explicit reconciliation decision composes existing T09 commands
(`CORRECT` / `MOVE`) — no source below gains a second stock writer in T10.

## Sources (exhaustive for inventory-implying state)

| # | Source | Entry points | Class | T10 treatment |
| --- | --- | --- | --- | --- |
| 1 | Manual inventory add/edit/delete | `routes/inventory.ts` POST/PATCH/DELETE → T09 authority adapters (receipts `manual-create:*` / composed CORRECT/MOVE / terminal CORRECT) | AUTHORITATIVE_MUTATION | Not an observation source. Already routed through T09; unchanged. |
| 2 | Manual stock count (user asserts "I counted 2 kg") | New T10 observation input (no route yet; service layer only) | OBSERVATION | First-class T10 observation source `MANUAL`. Evidence `OBSERVED`, or `CONFIRMED` when the actor explicitly confirms the claim. |
| 3 | Scan confirmation | `routes/scans.ts` POST /scans/:id/confirm → T09 authority adapter; scan drafts (`scan_items`) hold pre-confirmation evidence | AUTHORITATIVE_MUTATION (confirm) / EXTERNAL_EVIDENCE (draft) | Draft scan lines may be recorded as T10 observations with source `SCAN`, evidence `OBSERVED`. The existing confirm flow is untouched; a scan observation never auto-confirms stock. |
| 4 | Offline scan fallback | `src/web/services/scans.ts` → queued POST /inventory; `lib/sync.ts` outbox | AUTHORITATIVE_MUTATION (via manual adapter) | Same as #3 for draft evidence; outbox replay is a T09 concern, not an observation writer. |
| 5 | Shopping import | `routes/week.ts` POST /week/plans/:id/shopping/complete → T09 authority adapter | AUTHORITATIVE_MUTATION | Not an observation source. Purchase facts it commits are future receipt evidence (T11), not T10 observations. |
| 6 | Cooking deduction | `routes/recipes.ts` POST /recipes/:id/cook/complete → FEFO USE composition | AUTHORITATIVE_MUTATION | Not an observation source. Planned-vs-cooked deltas are a T12 closed-loop concern. |
| 7 | Weekly planner | `weekly-planner` / `meal-planning-snapshot.ts` / shopping suggestion read paths | LEGACY_PROJECTION (read-only consumer) | Reads household stock; writes no stock and no observations in T10. |
| 8 | Legacy inventory rows | `inventory_items` table + `packages/db/src/queries.ts` GET_INVENTORY | LEGACY_PROJECTION | The projection identity T10 observations may reference via `legacyItemId`; never treated as truth by the planner (lots are). |
| 9 | Freshness/expiry heuristics | `inventory_items.freshness`, `expiry_kind='estimated'` / `expiry_source='estimated'`, lot `estimatedExpiryAt` | HEURISTIC | May be recorded as observations with evidence `ESTIMATED` only. An ESTIMATED observation can never overwrite a KNOWN/USE_BY/BEST_BEFORE (confirmed) expiry; contradictions classify as CONFLICT with confirmed authority retained. |
| 10 | Receipt metadata | No receipt tables/routes exist at T10 start (T11 scope). Lot `purchasePrice`/`purchasedAt` exist as T09 CREATE fields. | EXTERNAL_EVIDENCE (future) | T10 defines the generic observation contract T11 will fill with `RECEIPT`-source observations. No OCR/vision/receipt parsing is implemented here. |
| 11 | Notification/snapshot logic | `meal-planning-snapshot.ts`, notification read paths | LEGACY_PROJECTION (read-only) | Consumers only; no writes. |
| 12 | Backfill/adoption evidence | T08 `backfillLegacyInventory` (insert-only, refuses adopted households); T09 `inventory_adoption_receipts` | AUTHORITATIVE_MUTATION (adoption) / immutable provenance | Not an observation source. Adoption receipts are the *authority* the reconciliation matcher uses to resolve `legacyItemId` → synthetic lot mappings; never inferred. |
| 13 | T09 command/event receipts | `inventory_commands`, `inventory_events` | AUTHORITATIVE_MUTATION (evidence of it) | The mutation ledger reconciliation decisions must reuse; decisions never create a parallel ledger. |

## Explicit non-sources

- Guest household transfer (`routes/auth.ts`, DEC-012 SAFE_DEFERRED): performs no
  stock or observation mutation.
- Web optimistic caches/outbox, scan queue/cleanup jobs, auth guest creation:
  no direct stock mutation (T09 writer map retained).
- Recommendation/planner candidate generation: read-only.

## Invariants restated for T10

1. `UNKNOWN != ZERO`, `ESTIMATED != CONFIRMED`, `OBSERVED != VERIFIED`,
   `OBSERVATION != inventory mutation`, `evidence != truth`.
2. Only rows #2/#3-class user assertions become observations in T10; writers
   #1/#5/#6 remain AUTHORITATIVE_MUTATION and were not modified.
3. Every observation records the household-scoped authoritative inventory
   version it was made against, so later drift is detectable (stale, never silent).
