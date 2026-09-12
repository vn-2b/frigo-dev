# T13 — Receipt/Vision Truth & Inventory UX V2 (proposed scope, NOT implemented)

Status: **PROPOSED — definition only.** Produced by the roadmap reconciliation audit
(`INVENTORY_TRUTH_ROADMAP_RECONCILIATION.md`). Nothing here has been implemented; no
application file changed. This packet defines only the material scope that the original
T11 roadmap line ("receipt/vision truth and inventory UX V2", `MASTER_CONTEXT.md@43718c2`,
`tasks/T08-inventory-truth-foundation.md@b5577ea`) committed to and that RC `64c5501`
does not contain. Already-certified T08–T12 work (lot authority, FEFO, CAS/idempotency,
observations/reconciliation services, read authority, closed-loop proofs, D3/D1/D2
remediation) is **out of scope and must not be reopened**.

## Starting SHA

**T13 starts from the final docs HEAD of the reconciliation audit** (`ROADMAP_AUDIT_HEAD` =
`3fce917ad6e079f76cf3bdd55e354ce0e35054bf`, plus the SHA-recording docs commit that follows it on
the same branch — use the branch tip named in `docs/ai/HANDOFF.md`), which descends from
`1cae11ee2e5acdc1d6c76266ad72b3ef744d7797` and carries the application tree of certified RC
`64c5501ab0110658718b3752bd84e537f0854e12` unchanged. **Not main** (`d1b0673`), **not**
`64c5501` directly. If the owner merges `64c5501` to main before T13 begins, T13 must be
re-based by an explicit integration review, not by this packet.

## Objective

Make receipt and fridge-vision evidence a first-class, truthful input to the Inventory
Truth Layer — evidence with provenance, uncertainty and purchase facts preserved,
confirmed only by the user, mutating adopted stock only through T09 — and give users an
Inventory UX that exposes what T08–T11 actually know (lots, storage, expiry kind,
provenance, adoption state, reconciliation) instead of the pre-T08 projection view.

## Why T13 is required

Audit verdict **T13 REQUIRED**: 9 original criteria MISSING (R3, R4, R6, R8, R11, U1, U6,
U13, U14) and 4 material PARTIAL (U4, U7, U8, U12) with no supersession or descoping
decision; T11 was displaced by read-authority work (which the roadmap had assigned to
T12), T11's continuation handed the scope to T12, and T12 never addressed it. Release
safety of `64c5501` is not in question (P0/P1/P2 = 0); this is unfinished product scope.

## Exact gaps addressed (IDs from the audit matrix)

| ID | Gap | T13 deliverable |
| --- | --- | --- |
| R3 | Receipt-confirmed lots carry `sourceType:'SCAN'`; `RECEIPT` never emitted | Receipt confirmations create/correct lots with `sourceType:'RECEIPT'`, `sourceId` = receipt scan id; API `dataSource` distinguishes `receipt` from `scan` |
| R4 | Receipt price/purchase date/merchant dropped at authority boundary | Confirmed receipt lines carry `purchasedAt` (receipt `purchase_date`, when present and valid) and `purchasePrice` (VND minor units from `unit_price_vnd`/`total_price_vnd`, when present) into T09 `CREATE`; never fabricated when absent (stay `null`) |
| R6 / U6 | Inferred shelf-life or day-chip dates persisted as `expiryKind:'KNOWN'` | Scan/receipt/manual writers distinguish user-supplied dated facts (`KNOWN`) from inferred dates (`ESTIMATED` → `estimatedExpiryAt`) and absence (`UNKNOWN`); UI offers "unknown" and shows estimate vs known |
| R5 | Confidence/uncertainty not surfaced on receipt review; provider-level collapse | Receipt review shows per-line confidence and flags unrecognized ingredient / missing price / missing date; Cloudflare provider stops fabricating price `0`, date `today`, confidence `≥0.5` (missing stays absent) |
| R7 | Per-line lifecycle limited to `is_confirmed`; no name/unit/storage/expiry correction on receipt review | Receipt and fridge review allow edit of name, quantity, unit, storage, expiry per line; explicit reject per line recorded (not just omitted) |
| R8 | Correction overwrites raw OCR value in place | Raw extraction retained (`scan_items` original columns or an additive evidence table) separately from confirmed values; T09 receipt/event metadata records raw → confirmed |
| R11 / U14 | No receipt/vision → T10 observation path; no reconciliation UX | Receipt/scan confirmation records a `RECEIPT`/`SCAN` observation (evidence, `OBSERVED`/`CONFIRMED`) alongside the T09 command in the same batch, or an explicit decision that the direct adapter is the sanctioned path (DEC-0xx) — one or the other, documented; minimal reconciliation UX: list open observations/drift, accept/dismiss (composes existing T10 decisions) |
| U1 | No UX endpoints for lot reads/observations/reconciliation | Additive household-scoped routes: `GET /inventory/lots/:lotId` (`readInventoryLot`), `GET /inventory/summary` (`readInventorySummary`), observation/reconciliation read+decision routes over the existing T10 services |
| U4 | Detail view lacks source, expiry kind, estimated date, opened/purchased | Ingredient/lot detail renders provenance, expiry kind, estimated vs known date, openedAt, purchasedAt, lot identity |
| U7 / U8 | No UI for name/unit/storage/expiry edit or storage move | Edit sheet backed by existing PATCH → `CORRECT`/`MOVE` adapters |
| U12 | UNKNOWN expiry renders as "fresh"; no expiry correction | Distinct "unknown" presentation; correct-expiry action |
| U13 | `POST /inventory/adopt` has no product or operator path; authority codes rendered generically | Documented adoption path (operator script or gated product action — owner decision) and user-readable handling of `INVENTORY_AUTHORITY_REQUIRED`, `CONFLICT`, `UNIT_MISMATCH`, `INSUFFICIENT_INVENTORY`, `IDEMPOTENCY_CONFLICT` using `ApiError.code` |

Optional (owner decision, not required by the roadmap): image/evidence fingerprint dedupe
for the same receipt uploaded under two idempotency keys; "Đối chiếu & Đánh dấu đi chợ
tuần" either performs real shopping-list reconciliation or is relabelled.

## In-scope files / areas

- `src/worker/routes/scans.ts` (confirm mapping, provenance, expiry kind, observation
  recording), `src/worker/utils/inventory-authority.ts` (`lotExpiryFieldsFromLegacy`
  successor that accepts an explicit kind), `src/worker/routes/inventory.ts` (additive
  read routes; manual add expiry kind), new `src/worker/routes/inventory-observations.ts`
  (or equivalent) for T10 UX endpoints.
- `packages/ai/src/providers/cloudflare.ts` (stop fabricating defaults), `packages/ai/src/schemas.ts`
  (optional confidence, no `0.9` default) — Groq path already strict.
- `src/web/pages/{ReceiptReviewPage,ScanResultPage,InventoryPage,IngredientDetailPage}.tsx`,
  `src/web/services/{inventory,scans}.ts`, new reconciliation page/component, error-code
  presentation helper.
- Additive migration **0031 only if** raw-evidence retention or observation linkage needs
  columns/tables (see Migration expectation).
- Tests under `tests/unit`, `tests/integration`, `tests/e2e`; docs under
  `docs/ai/inventory-truth/t13/` and the six handoff documents.

## Out of scope

- Any change to T09 command semantics, CAS/idempotency, FEFO, event authority, adoption
  executor internals, T10 planner/decision semantics, T11 read authority semantics.
- Migrations 0001–0030 (immutable). Rewriting legacy non-adopted paths.
- PayOS/billing/checkout/webhooks; auth policy (DEC-012/DEC-015 stay); production/staging
  deploy; remote D1; `MEAL_PLANNER_ENABLED` / `MEAL_PLANNER_AUTHORITY_CUTOVER` (separate
  follow-up).
- New OCR/vision providers or model changes beyond removing fabricated defaults.
- Generic accessibility or visual redesign beyond the screens touched.

## Architecture constraints

1. Evidence ≠ truth: OCR/vision output is persisted as draft evidence/observations only;
   adopted stock changes exclusively through `composeInventoryLotCommands` /
   `prepareInventoryLotCommand` (T09). No new SQL writer to `inventory_lots`,
   `inventory_items` or `inventory_events`.
2. `UNKNOWN != ZERO`, `ESTIMATED != CONFIRMED`, `OBSERVED != VERIFIED`; no fabricated
   price/date/confidence/expiry (DEC-003). `KNOWN` only for user-supplied or receipt-
   printed dates.
3. Idempotency preserved: existing scan id digest, quota ledger, queue claim, ready-
   predicate confirm, per-item client keys; correction provenance must not break replay.
4. Tenancy: every new route/query household-bound; no existence leaks.
5. Reads through T11 read authority (`fetchHouseholdInventoryFromDb`, `readInventoryLot`);
   UI must never treat `inventory_items` projection fields as canonical for adopted
   households.
6. Legacy (non-adopted) households keep current behaviour behind `readInventoryAuthorityMode`.
7. Additive only; no history rewrite; overlay `.hoplite/settings.json` never committed.

## Acceptance criteria (14)

1. Adopted receipt confirmation creates lots with `source_type='RECEIPT'` and
   `source_id=<receipt scan id>`; `GET /inventory` reports `dataSource:'receipt'`.
2. When the receipt carries `purchase_date` and line price, the created lot has
   `purchased_at` and money columns populated exactly; when absent they are `NULL`.
3. A confirmed line with no supplied expiry yields `expiry_kind='ESTIMATED'` +
   `estimated_expiry_at` (or `UNKNOWN` when no estimate basis exists) — never `KNOWN`.
   Manual add with a day-chip yields `ESTIMATED`; an explicit date picker yields `KNOWN`.
4. Receipt review renders per-line confidence and flags unrecognized/unpriced/undated
   lines; Cloudflare provider output leaves absent fields absent.
5. Users can edit name/quantity/unit/storage/expiry per line on receipt and fridge review;
   explicit reject is recorded per line.
6. Raw extracted values survive confirmation and are retrievable per line alongside the
   confirmed values; T09 receipt metadata records raw → confirmed.
7. Either (a) each confirmation records an observation (`RECEIPT`/`SCAN`) in the same
   atomic batch as the T09 commands with no second stock writer, or (b) a DEC records why
   the direct adapter is the sanctioned path; chosen option tested.
8. Additive household-scoped routes exist for lot detail, summary, observations and
   reconciliation decisions; cross-tenant → 404, no leak.
9. Detail view shows provenance, expiry kind, estimated vs known date, openedAt,
   purchasedAt, lot id/version for adopted households.
10. Edit sheet and storage move are available in the UI and land as T09 `CORRECT`/`MOVE`
    (existing adapters), with stale-version conflicts shown as a specific message and a
    refetch.
11. UNKNOWN expiry is presented distinctly from fresh; expiry can be corrected from the UI.
12. Authority/conflict error codes are rendered as specific user-readable messages using
    `ApiError.code`; no raw JSON.
13. A documented adoption path exists (script or gated action) and is exercised in a test.
14. All existing gates stay green: full suite ≥ 3,092 + new tests, real D1 ≥ 70, lint/
    typecheck/build, migration smoke (30 or 31), local schema gate, `git diff --check`.

## Required tests

- UNIT: expiry-kind mapper (supplied vs inferred vs absent); provider no-fabrication;
  receipt line → CREATE input mapping (price/date/provenance).
- INTEGRATION (sqlite HTTP): adopted receipt confirm provenance/purchase facts/expiry
  kind; raw-vs-confirmed retention; explicit reject; observation-or-DEC path; new routes
  tenancy; replay after correction; altered payload semantics documented and asserted.
- ROUTE: `GET /inventory` `dataSource` distinction; lot detail/summary routes.
- REAL_D1: at least one receipt → RECEIPT lot → T11 read case and one observation/
  reconciliation UX-route case on real workerd/D1 (extend `inventory-lot-d1-worker.ts`).
- BROWSER (`scripts/security-preview.mjs` harness): receipt review edit → confirm →
  detail shows provenance/expiry kind; unknown-expiry add; conflict message on stale edit.

## Real-D1 requirements

Fresh 0001→0030(+0031) replay and legacy-upgrade replay must pass; if 0031 is added, the
schema gate (`scripts/d1-schema-gate.sql`) and `scripts/migration-smoke.sh` are extended.
No remote D1 during T13.

## UX / browser requirements

Mobile-first 360/390/430 px; loading/empty/error/retry on every new async surface;
`aria-label` on icon-only buttons; safe-area bottom padding on fixed bars touched.

## Migration expectation

Prefer **no migration**: `inventory_lots` already has `purchased_at`, money columns,
`expiry_kind`, `source_type='RECEIPT'`; `inventory_observations` exists (0030). An
additive **0031** is acceptable only for raw-evidence retention (e.g. `scan_items`
`raw_*` columns) or per-line reject state; it must be additive, replay-safe and gated.

## Release safety rules

No main merge/deploy/remote D1/PayOS/secrets; `MEAL_PLANNER_ENABLED` stays unbound;
migrations 0001–0030 immutable; no force-push; publish only the authorized successor
branch; clean-checkout gates at the exact freeze SHA before declaring COMPLETE; update
the six inventory-truth handoff documents plus parent CURRENT_STATE/TASK_BOARD/HANDOFF.
