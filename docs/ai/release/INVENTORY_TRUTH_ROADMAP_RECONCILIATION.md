# Inventory Truth — roadmap reconciliation / gap audit (2026-09-12)

Application RC audited: **`64c5501ab0110658718b3752bd84e537f0854e12`** (technically
certified, `INVENTORY_TRUTH_RECERTIFICATION.md`). Starting docs HEAD: **`1cae11ee2e5acdc1d6c76266ad72b3ef744d7797`**
(branch `hoplite/akraiphia-akraiphnion-a03445c7--inventory-truth-final-recertification`).
Audit branch: `hoplite/delphoi-499ad774` (thread branch; requested logical name
`hoplite/inventory-truth-roadmap-reconciliation`), created at exact `1cae11e`.
Mode: **audit only** — discovery, traceability, gap analysis, roadmap decision. No
application, migration, dependency or config file is changed by this audit.

## Verdict

**T13 REQUIRED.**

The original committed roadmap (T08 packet and the isolated Inventory Truth master
context, both written 2026-09-09 before any T09–T12 implementation) defines T11 as
**"receipt/vision truth and inventory UX V2"**. The implemented T11 is *Inventory Read
Authority & Projection Cutover*; T12 is closed-loop integration. Neither T11 nor T12,
nor any decision record, supersedes or explicitly descopes the receipt/vision-truth and
UX-V2 scope: the T11 continuation hands it forward to T12 ("T12 owns receipt/vision UX
and Inventory UX V2"), and the T12 packet never mentions it again. At RC `64c5501` the
receipt/vision surface is the **pre-T08 legacy scan pipeline** (last changed by the
2026-09-07 platform import), reached by the T09 authority only through the generic
adopted scan-confirm adapter. It is safe (no OCR output mutates stock without user
confirmation; adopted confirmations route through T09 lot commands; tenancy holds), but
it is not the Receipt/Vision Truth layer the roadmap committed to: no `RECEIPT`-source
lots, no observation/evidence integration, receipt price/date/confidence are dropped at
the authority boundary, an inferred shelf-life date is written as `KNOWN` expiry, and the
inventory UX exposes none of the T09–T11 lot/expiry-kind/provenance semantics. These are
**product-scope gaps and P3 correctness notes, not release-safety defects**: the technical
certification of `64c5501` stands. The gap is material because the roadmap made
receipt/vision truth + UX V2 a numbered task of the train, and that task was displaced,
not completed and not explicitly cancelled.

## 1. Identity and starting state (§0–§5)

- GitHub `/repos/vn-2g/frigo-dev` → `id: 1364064929`, `full_name: vn-2g/frigo-dev`;
  `/repositories/1364064929` resolves to the same. **Repository ID matches.** Owner
  name changed again (`vn-2f` → `vn-2g`); ID is authoritative.
- `git remote -v`: `origin https://github.com/vn-2g/frigo-dev.git` (fetch/push).
- `git status --porcelain` before edits: ` M .hoplite/settings.json` (platform overlay;
  working-tree SHA-256 `a8c1f180b4d156c5c752f5fc04d5c884c2ec4f370db83c2c161505a4123dea99`,
  committed blob `3818a002fc12f70fa7a9a26078a125ac3d77998b` = main). Never staged.
- Thread branch `hoplite/delphoi-499ad774` started at `bc1532e`; the overlay file is
  identical between `bc1532e` and `1cae11e`, so a `--ff-only` merge to exact
  `1cae11ee2e5acdc1d6c76266ad72b3ef744d7797` was performed. `git rev-parse HEAD` =
  `1cae11e…` before any edit.
- Broker fetch: `main` = **`d1b06732f8a80db4e77986df31ff28d9f04641fa`** (unchanged; MAIN
  NOT ADVANCED); `…--inventory-truth-final-recertification` = `1cae11e`;
  `…--inventory-truth-final-remediation` = `bc1532e`.
- Ancestry: `d1b0673 → 64c5501 → bacfa1c → bc1532e → 1cae11e` all `merge-base --is-ancestor`
  PASS; `git diff 64c5501 1cae11e -- . ':(exclude)docs'` is **empty** (docs-only delta).
- Code was inspected in a clean detached worktree `/tmp/frigo-rc` at exact `64c5501`
  (`git status --porcelain` empty before and after the audit; a temporary uncommitted
  probe test was created there and deleted — see §14).

## 2. Roadmap reconstruction — sources and hierarchy (§6–§7)

Every repository source that defines T08–T12, ordered by authority (earlier, pre-
implementation definitions first). Dates are commit author dates (UTC).

| # | Authority class | Path | Commit | Date | Exact statement (summary) |
| --- | --- | --- | --- | --- | --- |
| S1 | 1 — roadmap written before implementation | `docs/ai/inventory-truth/MASTER_CONTEXT.md` §"Objective and roadmap" | `43718c2` | 2026-09-09 23:11 | "T08: … T09: lot commands, FEFO, CAS/idempotency, existing event authority, dual-write. **T10: observations and reconciliation. T11: receipt/vision truth and inventory UX V2. T12: closed-loop integration and hardening.**" (Line unchanged through `1cae11e`.) |
| S2 | 1 — task packet before implementation | `docs/ai/tasks/T08-inventory-truth-foundation.md` §"Exclusions / next tasks" | `b5577ea` (first version) | 2026-09-09 23:40 | "T09 owns commands CREATE/USE/DISCARD/OPEN/MOVE/CORRECT … **T10 observations/reconciliation, T11 receipt/vision/UX V2 and T12 closed-loop integration** are prerequisites-only handoff subjects." |
| S3 | 1 — same roadmap, T08 exclusions | `MASTER_CONTEXT.md` §"Exclusions" | `43718c2` | 2026-09-09 | "No new service, event bus, auth changes, observation engine or T09–T12 implementation." |
| S4 | 2 — invariants that bound receipt truth | `MASTER_CONTEXT.md` §"Invariants"; `DECISIONS.md` DEC-003 | `43718c2`, `b5577ea` | 2026-09-09 | "UNKNOWN != ZERO; ESTIMATED != CONFIRMED; OBSERVED != VERIFIED"; "No fabricated purchase/receipt/merchant/price/expiry confidence"; DEC-003: "KNOWN means a supplied dated fact"; "Infer from … default shelf life rejected". |
| S5 | 2 — dependency audit naming receipt evidence | `MASTER_CONTEXT.md` §"Dependency audit" (Scan/receipt row) | `b5577ea` | 2026-09-09 | "0013 stores merchant/invoice/purchase_date/total_amount_vnd and item unit_price_vnd/total_price_vnd as nullable legacy REAL. **None is promoted into lot price/purchase facts.**" (records the pre-T08 baseline the truth layer was to replace). |
| S6 | 4 — T08 handoff at completion | `docs/ai/inventory-truth/T08_VERIFICATION.md` | `8f8788c` | 2026-09-10 | "No planner/cook/shopping/scan/frontend cutover, **receipt/OCR/vision engine or UX V2**." "T10–T12 remain unimplemented." |
| S7 | 1 — T09 packet | `docs/ai/tasks/T09-inventory-lot-engine.md` | `e56f163` | 2026-09-10 | T09 = commands/FEFO/CAS/ledger/writer integration; "reads stay legacy until T12" (MASTER_CONTEXT, same commit) — **read cutover was assigned to T12, not T11.** "Retain scan draft -> user confirmation … no read cutover." |
| S8 | 4 — T10 handoff at completion | `docs/ai/inventory-truth/t10/README.md`; `t10/OBSERVATION_SOURCE_MAP.md` row 10 | `18519f0` | 2026-09-11 | "**T11 (receipt/vision truth, Inventory UX V2): NOT STARTED.** T10 only provides the generic evidence contract (`RECEIPT` is already a valid observation source type) that T11 will consume. No camera/OCR/vision code exists." "No receipt tables/routes exist at T10 start (T11 scope) … T10 defines the generic observation contract **T11 will fill with `RECEIPT`-source observations**." "HTTP API surface: none added … **T11 owns the UX endpoints.**" "global read cutover belongs to T12." |
| S9 | 5 — later retrospective (implemented T11) | `docs/ai/inventory-truth/t11/README.md`, `t11/CONTINUATION.md` | `e64ee77` | 2026-09-12 02:04 | "T11 — Inventory Read Authority & Projection Cutover"; "the T11 task packet arrived truncated mid-§32"; "**T12 owns receipt/vision UX and Inventory UX V2.**" |
| S10 | 5 — later retrospective (implemented T12) | `docs/ai/inventory-truth/t12/README.md`, `CONTINUATION.md`, `TEST_MATRIX.md` | `24668c2`, `5cb4caa` | 2026-09-12 | Closed-loop integration only; "T12 packet arrived truncated mid-§31"; **no mention of receipt, vision, OCR, UX V2 or frontend** anywhere in `t12/`. "No post-T12 task was started." |
| S11 | 5 — release reviews | `INVENTORY_TRUTH_RELEASE_CERTIFICATION.md`, `INVENTORY_TRUTH_RECERTIFICATION.md` | `32b6ec1`, `1cae11e` | 2026-09-12 | Technical certification only; re-certification explicitly defers: "historical roadmap mismatch still to be audited". |
| S12 | pre-T08 product baseline (context, not roadmap) | `README.md` §10, `PROJECT_STATUS.md` M12, `docs/PROJECT_AUDIT_AND_ROADMAP.md` §4/F-12a, `frigo_frontend_prompt_kit_v1/docs/{SCREEN_SPEC,FRONTEND_AGENT_PROMPT,QA_CHECKLIST}.md` | `4b51399` | 2026-09-07 | Legacy receipt OCR feature ("Receipt OCR to Inventory / Reconcile Shopping List"), `ReceiptReviewPage`; audit rows "Receipt OCR … Chua dat: Review UI co, nhung import/reconciliation va unknown ingredient chua an toan"; frontend kit: scan review must show "editable name, quantity, unit, confidence", "Scan never auto-confirms inventory", inventory screen "search, filters, freshness, CRUD", detail "quantity, freshness, **source**, recipes". |

No T10, T11 or T12 task packet was ever committed (`git log --all -- docs/ai/tasks`
lists only T01–T09). No commit in the train (`d1b0673..1cae11e`, 61 commits) removes or
rewrites the S1/S2 roadmap lines. No `DEC-0xx` (DEC-001…DEC-015) or ADR touches
receipt/vision or UX V2 scope.

### Is the mismatch real? (§8)

**CONFIRMED.** Two independent pre-implementation sources of the highest authority class
(S1, S2), reaffirmed by the T08 and T10 completion handoffs (S6, S8), define T11 as
receipt/vision truth **and** Inventory UX V2. The implemented T11 (S9) is a different
task (read authority — which S7/S8 had assigned to T12). The displaced scope was handed
forward to T12 (S9) and then dropped (S10). No supersession or descoping decision exists.

Both halves are confirmed: **A. Receipt/Vision Truth — CONFIRMED** (S1, S2, S6, S8 row
10 "T11 will fill with RECEIPT-source observations"). **B. Inventory UX V2 — CONFIRMED**
(S1, S2, S6, S8 "T11 owns the UX endpoints", S9 "T12 owns … Inventory UX V2").

Limitation: the roadmap names the scope in one line each; no committed acceptance
criteria exist for T11. The matrix below therefore derives requirements strictly from
(a) the roadmap words, (b) the committed invariants that any "truth" layer in this
program must satisfy (S4), (c) the T10 handoff's explicit statement of what T11 was to
consume/provide (S8), and (d) the pre-T08 product baseline that defines what
"receipt/vision" and "inventory UX" already meant in this product (S12). Nothing is
derived from a generic wishlist; every row cites its source.

## 3. Current pipeline at RC 64c5501 (§10–§19)

Files: `src/worker/routes/scans.ts` (1,301 lines), `src/worker/services/scan-queue.ts`,
`packages/ai/src/{router,schemas,types}.ts`, `packages/ai/src/providers/{groq,cloudflare,
qwen,glm,mock}.ts`, `src/web/pages/{ScanPage,ScanResultPage,ReceiptReviewPage}.tsx`,
`src/web/services/scans.ts`. Of these, the train changed **only** `src/worker/routes/scans.ts`
(T09 fences + `confirmAdoptedScan`) and `src/web/services/scans.ts` (response-loss
outbox, 16+/8−). `git diff d1b0673 64c5501 -- packages/ai src/web/pages/Scan*.tsx
src/web/pages/ReceiptReviewPage.tsx src/worker/services/scan-queue.ts` is **empty**.

Actual pipeline:

```
image (base64, ≤5 MB)  → POST /scans/receipt | /scans/fridge  (Idempotency-Key → scanId digest; quota ledger)
  → R2 original (users/<uid>/scans/<scanId>/original.webp)
  → SCAN_QUEUE_MODE=async (production): scans.status=pending → queue → scan-queue.ts claim/lease
       → AIRouter.receiptScan()/vision()  [groq → cloudflare AI → qwen → glm, in order]
       → INSERT scan_items (raw_name, canonical_id, estimated_quantity, unit, confidence, category, storage, unit_price_vnd, total_price_vnd)
       → UPDATE scans SET status='ready', merchant_name, invoice_number, purchase_date, total_amount_vnd
  → GET /scans/:id (household-scoped) — client polls
  → ReceiptReviewPage / ScanResultPage: user reviews, edits quantity (stepper), removes rows, (fridge only) adds manual rows / edits name
  → POST /scans/:id/confirm  { items[] }
       → resolveScanConfirmationItems: hydrate from server snapshot; user-edited name authoritative; reject foreign ids
       → group by canonical/name; unit compatibility fails closed (UNIT_MISMATCH 422)
       → expiryDate = submitted ?? existing ?? NOW + defaultShelfLifeDays(7)   ← inferred
       → readInventoryAuthorityMode(): 'native' → confirmAdoptedScan → T09 CORRECT (existing row) / CREATE (sourceType:'SCAN', sourceId:scanId,
                                            purchasedAt:null, purchasePrice:null, expiryKind via lotExpiryFieldsFromLegacy → 'KNOWN')
                                            + UPDATE scan_items SET <reviewed values>, is_confirmed=1 + UPDATE scans status='confirmed' (last)
                                  'legacy' → inventory_items UPDATE/INSERT (data_source='scan') + inventory_events (metadata: scanId, scanItemId, sourceQuantity, sourceUnit)
  → fetchHouseholdInventoryFromDb (T11 read authority for adopted households)
```

Findings by section:

- **§11 OCR/vision provider boundary.** Production-capable: `GroqProvider.receiptScan`
  (llama-4-scout, JSON mode, 20 s timeout, zod `ReceiptScanResultSchema` validation) and
  `CloudflareAIProvider.receiptScan` (`@cf/meta/llama-3.2-11b-vision-instruct`); `qwen`/`glm`
  do not implement `receiptScan` (skipped). `wrangler.jsonc` binds `AI`, `IMAGES` (R2),
  `SCAN_QUEUE`, `AI_MOCK_MODE="false"`, `SCAN_QUEUE_MODE="async"`. Mock output only when
  `aiMockMode` or `silentFallback === false`; production defaults fail loudly with
  `AI_SCAN_UNAVAILABLE` (`router.ts:63–82, 109–129, 178–181`), tested
  (`ai-router.test.ts` "fail closed when production has no vision provider"). Structured
  output: yes (zod). **Provider output never mutates stock directly**: it is persisted
  only into `scan_items`/`scans` (draft), and stock changes require `POST /scans/:id/confirm`
  with the user's reviewed list (S12 QA rule "Scan never auto-confirms inventory" holds).
  Deterministic fallback: `findCanonicalIngredient` re-derives canonical identity server-
  side; provider `canonical_id` is only a secondary hint (`scans.ts:731–735`). Failures are
  explicit (queue → `scans.status='failed'`, client shows error). **Uncertainty is
  partially collapsed inside providers**: `cloudflare.ts` clamps `confidence` to ≥0.5,
  defaults quantity to `max(0.1, …||1)`, price to `0`, `purchase_date` to today, unit to
  `'piece'` via `standardizeUnit` fallback; `ReceiptItemSchema.confidence` defaults to
  `0.9` when absent. Severity: **P3** (evidence quality; no stock corruption because
  confirmation is manual and the Groq path validates strictly). Classified against S4
  ("no fabricated … price/expiry confidence") as a Receipt-Truth gap, not a release defect.
- **§12 Receipt evidence model.** Durable evidence exists only as the legacy draft:
  `scans` (id, household, image_key, status, scan_type, merchant/invoice/purchase_date/
  total) + `scan_items` (raw_name, canonical_id, estimated_quantity, unit, confidence,
  category, storage, is_confirmed, prices). Evidence survives (only `scan_queue_jobs`
  tombstones are cleaned; `scans`/`scan_items` are not deleted by `cleanup.ts`). The
  system can answer "why does this lot exist" only coarsely: adopted lots carry
  `source_type='SCAN'`, `source_id=<scanId>`; the `RECEIPT` source type exists in the
  schema (0023 CHECK, domain enum, T10 `ObservationSourceType`) but **no production
  writer ever emits it** (`rg "sourceType: 'RECEIPT'" src packages --glob '!**/*.test.*'`
  → 0 hits). `GET /inventory` collapses it further: `dataSource: SCAN|RECEIPT → 'scan'`
  (`inventory.ts:440`). No provider/model, raw-vs-normalized extraction, evidence hash,
  or candidate status is recorded beyond `is_confirmed`. **Manual / receipt / vision /
  shopping / reconciliation / legacy backfill are only partly distinguishable** (receipt
  vs fridge-vision is distinguishable via `scans.scan_type` joined by `source_id`, not
  on the lot; reconciliation-derived changes are T09 `CORRECT`/`MOVE` receipts, not lots).
- **§13 Confidence/uncertainty.** Confidence is stored per `scan_items` row and shown
  on `ScanResultPage` (fridge) as a percentage; **`ReceiptReviewPage` does not render
  confidence** (its item state type omits it). Neither page flags low-confidence,
  ambiguous unit, unrecognized product (`canonical_id NULL`), missing price or missing
  purchase date. Confidence does not survive confirmation (not on the lot, not on the
  event). **Expiry: the confirm route invents a dated expiry** when the user supplies none
  (`scans.ts:1035–1041`: `NOW + defaultShelfLifeDays || 7`) and the adopted adapter writes
  it through `lotExpiryFieldsFromLegacy` as **`expiryKind = 'KNOWN'`** (`inventory-authority.ts:59–67`
  treats every bare date as KNOWN). Probe (§14) confirmed: a receipt line confirmed
  without expiry produced `expiry_kind='KNOWN', expiry_at=<today+4d>` for pork belly.
  DEC-003 says "KNOWN means a supplied dated fact" and rejects shelf-life inference
  (S4). The same conversion happens for manual adds without an explicit date only when
  the client sends one — `InventoryPage` **always** sends `expiryDate = today + N days`
  from a 2/5/10/30-day chip (`InventoryPage.tsx:75`), so every manual lot is also
  `KNOWN`. Downstream T10 reconciliation therefore treats these estimates as confirmed
  ("An ESTIMATED observation can never overwrite a KNOWN/USE_BY/BEST_BEFORE expiry",
  `t10/OBSERVATION_SOURCE_MAP.md` row 9). Severity: **P3** correctness note (no stock
  quantity impact; expiry semantics are wrong-kind, not wrong-value the user did not
  see) — but it is the central Receipt/Vision Truth invariant, so it is a **material
  scope gap**.
- **§14 Receipt line → inventory mapping.** Identity: `findCanonicalIngredient(name)` →
  `ingredient_id` or NULL + raw name (no FK sentinel; F-01 fixed). Quantity/unit: standard
  8-unit enum; g↔kg / ml↔l exact; contextual units fail closed (`convertScanQuantity`).
  Grouping merges same-ingredient lines within one scan into one CORRECT/CREATE
  (`scans.ts:965–1090`) — two receipt lines of the same ingredient with different
  expiry/price become **one lot**; a receipt line for an ingredient that already has an
  active lot becomes a **CORRECT on the existing lot** (`confirmAdoptedScan` maps
  `update.id → mapped.lot`), i.e. purchases are merged into the FEFO-oldest existing lot
  rather than creating a new dated lot. Price (`unit_price_vnd`, `total_price_vnd`),
  `purchase_date`, merchant and invoice are **dropped** at the authority boundary
  (`purchasedAt: null, purchasePrice: null`, `scans.ts:66`) even though the lot schema
  supports `purchased_at`/money (0023) — the exact baseline S5 described as the thing
  to be replaced. Storage: default location per storage type; missing → `DRIFT_DETECTED`.
  Household: bound at every step. Lot identity: `insert.id` = `item_<scanId>_<stablePart>`.
- **§15 Duplication / idempotency.** Upload: `Idempotency-Key` → deterministic `scanId`
  digest per (user, household, key); replay/`recoverScan` returns the existing scan
  (`scans.ts:347–393`); quota ledger fences reservation (`scan-quota-idempotency` 15
  tests). Same image retried after network loss: client keeps the same `commandId`
  while image/type/owner are unchanged (`ScanPage.tsx:57–60`). Queue: at-least-once
  with claim/lease fencing (`scan-queue-fencing` 9 tests). Confirm: every statement is
  guarded by the `status='ready'` predicate, status flip last; concurrent confirm →
  exactly one wins, loser sees `idempotentReplay`; adopted: per-scan-item `clientKey`
  receipts. **Same receipt image uploaded twice with different keys → two scans → two
  confirmations → double stock** (no image/evidence fingerprint dedupe); **altered
  payload after confirmation → 200 `idempotentReplay`, stock unchanged** (probe §14),
  i.e. the confirm boundary is "first confirmation wins", not "changed payload →
  `IDEMPOTENCY_CONFLICT`" as `t12/FINAL_WRITER_MAP.md` row "Scan confirm (adopted)"
  states. No silent duplicate is created in either case; the documentation claim is
  imprecise (**P3 documentation**). Image fingerprint dedupe was never a committed
  requirement → recorded as PRODUCT_GAP candidate for T13 only if the owner wants it.
- **§16 Tenancy.** `tenancyGuard` on `/scans*`; `GET /scans/:id` and confirm filter by
  `household_id` (404 `NOT_FOUND`, no existence leak); `resolveScanConfirmationItems`
  rejects ids not belonging to the scan (`INVALID_SCAN_ITEM`); queue rejects tenant
  mismatch as permanent failure; quota scoped to user+household. Probe: household B
  read/confirm of A's receipt → 404/404, no mutation. **No tenancy finding.**
- **§17 Candidate lifecycle.** Actual states: `scans.status ∈ {pending, processing,
  ready, confirmed, failed}` and `scan_items.is_confirmed ∈ {0,1}`. There is **no
  per-line REJECTED / CORRECTED / DUPLICATE / EXPIRED state**; omitting a row from the
  confirm payload leaves it `is_confirmed=0` forever (implicit rejection). The user can
  (fridge review): edit quantity (stepper), remove a row, add a manual row (name/qty/
  unit); the "sửa … tên" banner promise is not backed by a name editor (`updateItem` is
  called only for quantity). Receipt review: quantity stepper, remove row; **no name,
  unit, storage, expiry or price correction** (storage shown as a static chip; page
  sends no `expiryDate`). Confirmation for adopted households mutates stock **only**
  through `composeInventoryLotCommands` (T09) — verified in code and by
  `inventory-adoption.test.ts` "confirms scans into lots with the scan transition in one
  batch". Correct answer to the architecture question: **yes for adopted households; the
  legacy branch writes the projection directly by design (non-adopted only).**
- **§18 Observation integration.** **None.** `recordInventoryObservation`,
  `planInventoryReconciliationForHousehold`, `confirmReconciliationDecision` have zero
  production callers (`src/worker/**` → 0 hits; only `tests/**` and the TEST_TOKEN-gated
  `tests/helpers/inventory-lot-d1-worker.ts`). Receipt/vision → observation, which S8
  says "T11 will fill with RECEIPT-source observations", does not exist. The path used
  instead is the direct scan-confirm → T09 adapter. Adopted stock still routes through
  T09 (evidence above), so this is not a safety gap, but it is exactly the committed
  T11 integration that is absent.
- **§19 Correction.** OCR says 2000 g, user sets 1200 g and confirms: the confirm route
  **overwrites `scan_items.estimated_quantity` in place with 1200** (`scans.ts:1114–1131`)
  — the raw OCR value (2000) is lost from the draft; the T09 receipt records the
  command input (1200) and the legacy-branch event keeps `sourceQuantity`. No correction
  provenance (who changed what from what) exists. Retry cannot duplicate (ready
  predicate). Correction never bypasses authority (adopted). Probe §14 confirmed.

## 4. Inventory UX V2 — discovery and current state (§20–§36)

Historical definition available: only the roadmap words "inventory UX V2" (S1, S2, S6,
S8, S9) plus the pre-T08 baseline (S12: inventory screen "search, filters, freshness,
CRUD"; detail "quantity, freshness, source, recipes"; "All async screens have
loading/error/empty/retry"; 360/390/430 px; ≥44 px tap targets; icon buttons
`aria-label`). No V2 mockups, screen list or acceptance criteria were ever committed.
"V2" is therefore read as: the inventory UX that exposes the truth layer T08–T11 built
(lots, storage locations, expiry kinds, provenance, adoption state, reconciliation),
because that is the only meaning under which a *new* UX version belongs to *this*
program (S8: "T11 owns the UX endpoints"). Where a requirement cannot be sourced, the
row is marked "no committed criterion" and excluded from the verdict.

Current frontend at `64c5501` (`src/web/pages/InventoryPage.tsx` 369 lines,
`IngredientDetailPage.tsx` 145, `components/common/{IngredientRow,StatusChip,EmptyState,
AsyncState,ConfirmDialog}.tsx`; unchanged by the train except `AuthPage`/`auth.ts`/`http.ts`/`scans.ts`):

- **List (§21).** One row per API item. For adopted households `GET /inventory` returns
  **one row per ACTIVE lot** (`readInventoryAuthority` → `items: active.map(toReadItem)`),
  so multiple lots of one ingredient render as separate rows with identical name and no
  lot/expiry disambiguation beyond the row's own `expiryDate` text; non-adopted returns
  legacy rows. Empty state, loading (`InlineLoading`), error+retry (`InlineError`) exist.
  Search + category/"expiring" pills. Storage shown only as " · Ngăn đông" suffix for
  freezer (pantry not shown in the row). Terminal lots hidden (authority excludes them).
- **Detail (§22).** `IngredientDetailPage` re-fetches the whole list and `find`s the id
  (no `readInventoryLot` call); shows quantity/unit, `StatusChip(freshness)`, storage,
  `expiryDate || 'Chưa đặt hạn'`, matching recipes. **Does not show**: expiry kind
  (KNOWN/ESTIMATED/UNKNOWN/BEST_BEFORE/USE_BY), `estimatedExpiryDate`, `openedAt`,
  `purchasedAt`, source/provenance (`dataSource`, `sourceType`, `sourceId`), lot id/
  version, sibling lots. Baseline S12 required "source" on the detail screen → MISSING.
  No mutation on this page. The API's additive T11 fields (`lotId`, `lotVersion`,
  `quantityMilli`, `canonicalUnit`, `expiryKind`, `estimatedExpiryDate`, `state`,
  `inventoryVersion`) are **consumed by no web code** (`rg` in `src/web` → 0 hits).
- **Add (§23).** Modal: name, quantity (integer `min=1`), unit (7 options), category,
  storage, expiry as **relative day chips (2/5/10/30)** → sent as absolute `expiryDate`;
  no price, opened state, purchase date or "unknown expiry" option. Route: adopted →
  `adoptManualInventoryCreate` → T09 `CREATE` (`sourceType:'MANUAL'`, `expiryKind:'KNOWN'`).
  Trace frontend → API → authority: PASS. UX completeness vs V2: MISSING unknown-expiry
  and estimated-vs-known distinction (the chip UI is inherently an estimate that is
  persisted as KNOWN).
- **Edit / correct (§24).** UI exposes only ±quantity steppers on rows (`PATCH
  {quantity}` with `version`) and delete. No name/unit/storage/expiry/category edit UI
  exists (the API supports them; `adoptManualInventoryUpdate` composes `CORRECT` +
  `MOVE`). Adopted PATCH → T09 `CORRECT` (reason "Cập nhật nguyên liệu"); there is no
  UI distinction between "edit metadata" and "correct authoritative quantity" — every
  stepper tap is a T09 `CORRECT` with an absolute quantity computed client-side
  (`Math.max(1, currentQty + delta)`), which cannot reach 0 and cannot express USE vs
  CORRECT intent. Projection-only updates cannot happen for adopted stock (server gate).
- **Move (§25).** Command exists (`MOVE`, lot-aware, CAS, composed with CORRECT); **no
  UI** to change storage after creation.
- **Open (§26).** `OPEN` command exists in domain (`inventory-lot-commands.ts:80`) with
  `openedAt`; **no production producer** (`rg "type: 'OPEN'" src` → 0) and **no UI**.
  Read authority returns `openedAt`; UI ignores it.
- **Use / consume (§27).** Backend: FEFO `USE` via cook completion only
  (`recipes.ts:695`). Manual consume UI: the quantity stepper "−" issues a `CORRECT`
  (absolute), floors at 1, no partial-consume dialog, no FEFO choice, no unit conversion
  input. Stale snapshot → server 409 `CONFLICT` → UI shows generic "Chưa cập nhật được số
  lượng" and refetch only on success (`onSuccess: invalidateInventoryDependents`; on error
  the stale list stays until the next query refetch). Response loss → outbox replay with
  `Idempotency-Key` (sync tests).
- **Discard (§28).** Delete button → `ConfirmDialog` → `DELETE /inventory/:id`
  (`If-Match` version) → adopted `DISCARD` of the full remaining quantity (or terminal
  `CORRECT` at zero) with a fixed reason. No partial discard, no reason capture, no
  expired-food prompt.
- **Lot-aware UX (§29).** Not exposed: same ingredient in two lots shows as two
  identical-looking rows; the user cannot tell which is which except by expiry date text;
  merging by scan confirm targets the existing mapped lot. S8/S1 expectations that UX V2
  sits on T09 lots → PARTIAL (data is per-lot; presentation is lot-blind).
- **Expiry / freshness (§30).** `StatusChip` renders fresh/use_soon/expiring/out_of_stock
  from server `freshness`; UNKNOWN expiry renders as `fresh` (`computeReadFreshness`:
  `expiry === null → 'fresh'`) with row text hidden and detail "Chưa đặt hạn" — the UI
  cannot distinguish "fresh" from "unknown", violating the spirit of UNKNOWN ≠ ZERO for
  presentation (S4). `estimatedExpiryDate` is never shown. The user cannot correct a bad
  expiry (no edit UI).
- **Adoption (§31).** `POST /inventory/adopt` exists (explicit, receipted, idempotent,
  household-scoped) with **no web caller and no operator script**
  (`rg inventory/adopt src/web scripts` → 0). `ADOPTION_REQUIRED` /
  `INVENTORY_AUTHORITY_REQUIRED` (409) and `DRIFT_DETECTED` surface as the generic
  "Vui lòng thử lại" strings. Guest→account transfer deferral has a dedicated UX (DEC-015,
  D3 fix). Adopted-empty state renders the normal empty state (authority returns `[]`).
  T12 records "Adoption remains explicit/controlled; T12 adds no auto-adoption path" —
  so in production **no household can currently become adopted through any product
  surface**, which means the entire T09–T11 authority stack is unreachable for real users
  at `64c5501`. This is consistent with the staged-rollout design (`FINAL_AUTHORITY_MAP`
  "removal condition = universal adoption") but there is **no committed rollout
  mechanism or decision** naming who/what calls `/inventory/adopt`. Classified
  PRODUCT_GAP (rollout enablement), not a defect.
- **Drift / reconciliation (§32).** Backend only (T10). No observation input, drift view,
  accept/dismiss, conflict or stale-decision UI; no HTTP routes. S8 explicitly assigned
  the UX endpoints to T11 → MISSING.
- **Error / conflict (§33).** Client `ApiError.code` exists (D3) but inventory/scan
  pages map every failure to one generic Vietnamese string; `CONFLICT`/`STALE`,
  `UNIT_MISMATCH` (422 with a specific server message), `INSUFFICIENT_INVENTORY`,
  `INVENTORY_AUTHORITY_REQUIRED`, `IDEMPOTENCY_CONFLICT` are not distinguished and the
  server's user-facing message is discarded. Recovery (refetch) is not triggered on
  conflict. Outbox: 409 is treated as retryable and **blocks the queue head**
  (`isNonRetryable` excludes 409; `flushOnce` `break`s on any retryable error) — pre-
  existing on main, unchanged; PROJECT_AUDIT F-12a already asked for "proof that 4xx
  conflict khong bi drop"; a permanent 409 (e.g. version conflict on a stale offline
  PATCH) therefore keeps "Đang chờ đồng bộ (N thay đổi)" indefinitely. **P3** (pre-existing,
  offline-only, no data corruption; the user can log out to clear).
- **Loading / empty / offline (§34).** Present per S12 checklist: loading, empty, error+
  retry on list; `OfflineBanner` with pending count and manual retry; scan pages poll
  with bounded attempts and show pending/failed states. Sync-status per row: `pendingSync`
  is set in cache but not rendered by `IngredientRow`. Acceptable vs committed criteria.
- **Mobile / responsive (§35).** All pages are `max-w-md` mobile-first with sticky bottom
  CTAs; `ScanResultPage` uses safe-area padding, `ReceiptReviewPage` and `InventoryPage`
  bottom bars do not (`pb-[calc(1rem+env(safe-area-inset-bottom))]` only on ScanResult).
  No browser test covers the inventory/scan pages (only `frontend-ui-integration.test.tsx`
  "scan data honesty" and Home/Recipe/Notifications). Not a committed roadmap criterion
  beyond S12 → informational.
- **Accessibility (§36).** Icon buttons: `IngredientRow` delete has `aria-label`; the
  `ReceiptReviewPage` remove button has only `title="Xóa"`; `ScanResultPage` remove has
  neither. Errors use `role="alert"` on Inventory/ScanResult, not on ReceiptReview
  (`pollError` div). S12 checklist item "Icon-only buttons have aria-label" → PARTIAL
  (informational; not roadmap-material).

## 5. Closed-loop product integration (§37)

| Loop | Backend | Product UX | Classification |
| --- | --- | --- | --- |
| receipt → evidence → confirm → stock → inventory read | `scan_items` draft → confirm → T09 (adopted) → T11 read; tests: `inventory-adoption` scan case, `scan-response-loss` (19), routes | ReceiptReview → `/fridge` list refresh (`invalidateInventoryDependents`) | **BACKEND COMPLETE** (as legacy SCAN provenance) / **PRODUCT SCOPE PARTIAL** (no receipt truth: price/date/confidence dropped, expiry kind fabricated) |
| receipt → correction → stock → recipe | correction = in-place overwrite; recipes read via funnel (T12 §19 test) | quantity-only correction | PARTIAL (no raw-vs-corrected evidence) |
| receipt → stock → planner | funnel (T12 §20 test); `/meal-planning/*` SAFE_DEFERRED | "Đối chiếu & Đánh dấu đi chợ tuần" button calls the same `confirmScan` then navigates to Week shopping — **no reconciliation against the shopping list actually happens** (`ReceiptReviewPage.tsx:125–145`) | PRODUCT GAP (mislabelled action; pre-existing) |
| inventory manual use → stock → recipe/planner refresh | PATCH → CORRECT → funnel; T12 tests | stepper → invalidate dependents | DONE (with the edit/correct semantics caveat above) |
| scan observation → reconciliation → stock → UI | T10 + T12 closed-loop suites (backend, test-only endpoints) | none | **BACKEND COMPLETE / PRODUCT SCOPE MISSING** |

## 6. Mock / placeholder / feature-flag audit (§38–§39)

- Placeholders: none production-facing in the audited surfaces (`TODO|FIXME|stub|not
  implemented` → 0 hits beyond CSS `placeholder=` and one comment about a future
  retention job in `inventory.ts:1013`). `MockAIProvider` is reachable only with
  `AI_MOCK_MODE=true` or `silentFallback:false`; production sets neither.
- Flags: `AI_MOCK_MODE="false"`, `SCAN_QUEUE_MODE="async"`, `WEEK_SCHEMA_MODE="dual"`
  bound in `wrangler.jsonc`; `MEAL_PLANNER_ENABLED` **not bound** (planner 404
  `MEAL_PLANNER_DISABLED`; `SAFE_DEFERRED` D2 reader; `MEAL_PLANNER_AUTHORITY_CUTOVER`
  precondition unchanged and unrelated to receipt/UX scope).
- Unreachable functionality (no flag, no caller): `POST /inventory/adopt` from any product
  surface; `OPEN` command; `RECEIPT` source type; all T10 observation/reconciliation
  services; `readInventoryLot`/`readInventorySummary` from any route. These are complete
  backend capabilities without a product path — consistent with the T09/T10 packets
  (which explicitly deferred HTTP/UI) but that deferral pointed at T11 (S8).

## 7. Requirement traceability matrix (§9, §40–§42)

Status vocabulary: DONE · PARTIAL · MISSING · SUPERSEDED · OUT_OF_SCOPE_BY_EXPLICIT_DECISION.
No row qualifies for SUPERSEDED or OUT_OF_SCOPE (no decision record exists). Severity:
P0–P3 for release-safety/correctness, PRODUCT_GAP for unfinished product scope. Test
evidence classes: UNIT, INTEGRATION (sqlite HTTP), ROUTE, REAL_D1, BROWSER, NONE.

### A. Receipt / Vision Truth (original T11 half A)

| ID | Original requirement | Historical source | Current implementation (RC 64c5501) | Tests | Status | Gap severity |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | Production-capable receipt image → structured extraction, fail-closed without provider | S1/S2 "receipt/vision truth"; S12 baseline | `packages/ai/src/router.ts:132–196` (groq → cloudflare), `scan-queue.ts:221–258`, `POST /scans/receipt` | UNIT `ai-router.test.ts` (fail-closed, CF receipt parse), `receipt-scan.test.ts` (4); INTEGRATION `scan-queue-fencing` (9), `scan-quota-idempotency` (15) | DONE (pre-T08 legacy, unchanged) | — |
| R2 | OCR/vision output is evidence, never truth: no stock mutation without explicit user confirmation | S4 invariants; S12 QA "Scan never auto-confirms inventory" | Draft `scan_items` → `POST /scans/:id/confirm` required; adopted → T09 only | INTEGRATION `inventory-adoption.test.ts` "confirms scans into lots…", `inventory-writer-fence`; ROUTE `scan-response-loss` (19) | DONE | — |
| R3 | Receipt-source provenance on adopted stock (`RECEIPT`-source lots/observations) | S8 row 10 ("T11 will fill with RECEIPT-source observations"); 0023 CHECK / domain enum include `RECEIPT` | Adopted confirm writes `sourceType:'SCAN'` for receipts too (`scans.ts:67`); `RECEIPT` has zero production writers; API collapses to `dataSource:'scan'` | Probe (§14) `source_type='SCAN'` for receipt scan; NONE in repo | MISSING | PRODUCT_GAP |
| R4 | Receipt facts (price, purchase date, merchant/invoice) become lot purchase facts instead of being dropped | S5 baseline (“None is promoted into lot price/purchase facts” = pre-T08 state to replace); 0023 `purchased_at`/money columns; T09 CREATE fields | `confirmAdoptedScan` passes `purchasedAt:null, purchasePrice:null`; `scan_items` prices stay in the draft only | Probe: `purchased_at=null, amount_minor=null` | MISSING | PRODUCT_GAP |
| R5 | Uncertainty preserved: confidence / unrecognized line / ambiguous unit-price-date carried to review and not converted to false certainty | S4 "ESTIMATED != CONFIRMED", "No fabricated … confidence"; S12 review shows "confidence" | Fridge review shows %; **receipt review omits confidence**; CF provider clamps ≥0.5, defaults price 0/date today/unit piece; confidence not persisted past confirmation | UNIT (schema validation only); NONE for UI | PARTIAL | P3 + PRODUCT_GAP |
| R6 | Expiry evidence kind is truthful: inferred/default dates are ESTIMATED or UNKNOWN, never KNOWN | S4 DEC-003 "KNOWN means a supplied dated fact"; "Infer from … default shelf life rejected" | `scans.ts:1035–1041` invents `NOW+shelfLife`; `lotExpiryFieldsFromLegacy` → `KNOWN`; same for manual add day-chips | Probe: `expiry_kind='KNOWN'` for un-dated receipt line; NONE in repo asserting kind for scan/manual writers | MISSING | **P3 (correctness of evidence kind; no quantity impact)** + PRODUCT_GAP |
| R7 | Candidate lifecycle with review/correct/reject/confirm per line | S12 review spec ("editable name, quantity, unit, confidence"); S1 | `scans.status` + `is_confirmed`; receipt review: qty stepper + remove only; fridge review: qty, remove, manual add (name edit promised, not implemented) | UNIT `scans.test.ts` (5) hydration/duplicate/unit; NONE for UI | PARTIAL | PRODUCT_GAP |
| R8 | Correction provenance: raw extraction retained separately from confirmed value | S4 "OBSERVED != VERIFIED"; S8 evidence contract | Confirm overwrites `scan_items` in place; legacy event keeps `sourceQuantity`; adopted receipt keeps command input only | Probe (2000 → 1200 overwrite) | MISSING | PRODUCT_GAP |
| R9 | Duplicate/idempotent ingestion and confirmation | S7 (T09 CAS/idempotency), S12 F-06 | Key-digest scan id, quota ledger, queue claim, ready-predicate confirm, per-item receipts; altered re-confirm → replay (not conflict); no image fingerprint | INTEGRATION `scan-quota-idempotency` (15), `scan-queue-fencing` (9), `scan-response-loss` (19), adoption replay; probe | DONE (doc row in `FINAL_WRITER_MAP` "changed payload → IDEMPOTENCY_CONFLICT" is inaccurate) | P3 (docs) |
| R10 | Household tenancy of receipt/scan evidence and confirmation | S4 invariants; S7 | `tenancyGuard`, household-bound SELECT/UPDATE, foreign id rejection | INTEGRATION quota "rejects mismatched tenant…", queue tenant conflict, T12 real-D1 G; probe 404/404 | DONE | — |
| R11 | Receipt/vision → T10 observation → reconciliation → T09 integration | S8 (explicit), S1 | No production observation writer; direct confirm→T09 adapter instead | T10/T12 suites exist for the backend layer via TEST_TOKEN endpoints only | MISSING | PRODUCT_GAP |
| R12 | Adopted receipt confirmation mutates stock only through T09 authority | S7, S4 | `confirmAdoptedScan` → `composeInventoryLotCommands` | INTEGRATION adoption scan case; writer-fence; T12 writer map | DONE | — |

### B. Inventory UX V2 (original T11 half B)

| ID | Original requirement | Historical source | Current implementation | Tests | Status | Gap severity |
| --- | --- | --- | --- | --- | --- | --- |
| U1 | UX endpoints for the truth layer (observations/reconciliation/lot reads) | S8 "T11 owns the UX endpoints"; S9 hand-forward | No routes for observations/reconciliation; `readInventoryLot`/`readInventorySummary` unrouted | NONE | MISSING | PRODUCT_GAP |
| U2 | Inventory list with search/filters/freshness/CRUD; loading/empty/error/retry | S12 SCREEN_SPEC 7, QA checklist | `InventoryPage.tsx` | INTEGRATION `frontend-ui-integration` (Home use-soon only); NONE for InventoryPage | DONE (baseline) | — |
| U3 | Lot-aware presentation (multiple lots of one ingredient distinguishable; storage/expiry per lot) | S1 (UX V2 on T09 lots), S8 | One row per lot with no lot cue; storage suffix only for freezer | NONE | PARTIAL | PRODUCT_GAP |
| U4 | Detail view shows quantity, freshness, storage, expiry **and source/provenance**; expiry kind and opened state where known | S12 SCREEN_SPEC 8 ("source"); S4 semantics; T11 API fields | No source, expiryKind, estimatedExpiryDate, openedAt, purchasedAt, lot id | NONE | PARTIAL | PRODUCT_GAP |
| U5 | Add flow ends in T09 for adopted households | S7 | `adoptManualInventoryCreate` | INTEGRATION adoption/writer-fence; T12 routes | DONE | — |
| U6 | Add flow can express unknown/estimated expiry truthfully | S4 | Day chips always send an absolute date → KNOWN | NONE | MISSING | PRODUCT_GAP (shares R6 root) |
| U7 | Edit/correct metadata (name/unit/storage/expiry/category) with authority-backed semantics | S7 (CORRECT/MOVE exist); S12 CRUD | API + adapters exist; UI offers only ±quantity and delete | INTEGRATION `inventory-patch-parity`, `inventory-backfilled-patch` (API only) | PARTIAL (API DONE, UI MISSING) | PRODUCT_GAP |
| U8 | Move between storage locations | S7 MOVE | Command + adapter; no UI | INTEGRATION T09 MOVE/MOVE races | PARTIAL (UI MISSING) | PRODUCT_GAP |
| U9 | Open package (openedAt) | S7 OPEN; 0019 `opened_at` | Domain command only; no producer, no UI | UNIT/INTEGRATION T09 OPEN/OPEN | PARTIAL (no product path) | PRODUCT_GAP |
| U10 | Manual use/consume (partial, FEFO where appropriate) | S7 USE/FEFO | Cook path only; stepper issues absolute CORRECT floored at 1 | INTEGRATION FEFO suites (cook) | PARTIAL | PRODUCT_GAP |
| U11 | Discard (confirmation, authority, refresh) | S7 DISCARD; S12 | ConfirmDialog → DELETE → DISCARD/terminal CORRECT; full only, fixed reason | INTEGRATION adoption/writer-fence | DONE (baseline) | — |
| U12 | Expiry/freshness display distinguishes unknown/estimated/known and allows correction | S4; S12 | UNKNOWN renders as "fresh"; no estimated marker; no correction UI | UNIT `computeReadFreshness` | PARTIAL | PRODUCT_GAP |
| U13 | Adoption transition is reachable and understandable | S7 adoption authority; `FINAL_AUTHORITY_MAP` rollout notes | `POST /inventory/adopt` has no product/operator caller; 409 codes rendered generically | INTEGRATION adoption route | MISSING (product path) | PRODUCT_GAP |
| U14 | Reconciliation/drift UX (observation input, accept/dismiss) | S8 (T11 owns UX), S1 | none | NONE (backend suites only) | MISSING | PRODUCT_GAP |
| U15 | Conflict/error UX for user-recoverable domain errors (stale/conflict, unit mismatch, insufficient) | S12 QA "error/retry"; S7 CAS semantics | Generic strings; no refetch on conflict; outbox blocks on permanent 409 (pre-existing) | UNIT `sync.test.ts` (409 not turned into offline import) | PARTIAL | P3 (outbox head-of-line) + PRODUCT_GAP |
| U16 | Loading/empty/offline/pending states | S12 QA checklist | Present (list, scan polling, OfflineBanner) | INTEGRATION `frontend-ui-integration` (Home/Recipe/Notifications) | DONE | — |
| U17 | Mobile viewport / accessibility basics | S12 (not roadmap-material) | Mobile-first; safe-area inconsistent; some icon buttons lack `aria-label` | NONE | PARTIAL | P3 / informational |

Counts — Receipt/Vision (R1–R12): DONE 5 (R1, R2, R9, R10, R12) · PARTIAL 2 (R5, R7) ·
MISSING 5 (R3, R4, R6, R8, R11) · SUPERSEDED 0 · OUT_OF_SCOPE 0.
Inventory UX V2 (U1–U17): DONE 4 (U2, U5, U11, U16) · PARTIAL 9 (U3, U4, U7, U8, U9,
U10, U12, U15, U17) · MISSING 4 (U1, U6, U13, U14) · SUPERSEDED 0 · OUT_OF_SCOPE 0.

## 8. Materiality and T13 decision (§43–§44)

Release-safety findings against `64c5501`: **P0 none · P1 none · P2 none.** P3: (a)
inferred shelf-life/day-chip expiry persisted as `KNOWN` (R6/U6 — evidence-kind
correctness, not stock quantity; no cross-tenant or integrity impact); (b) provider-
level uncertainty collapse in `cloudflare.ts` (R5); (c) `FINAL_WRITER_MAP` scan row
overstates changed-payload behaviour (R9 docs); (d) pre-existing outbox head-of-line
block on permanent 409 (U15); (e) accessibility/safe-area inconsistencies (U17). None
of these changes the technical certification.

Material unfinished **original** scope (committed in S1/S2, reaffirmed S6/S8, never
superseded): MISSING rows R3, R4, R6, R8, R11 (receipt/vision truth: provenance,
purchase facts, truthful expiry kind, correction evidence, observation integration) and
U1, U6, U13, U14 (UX V2: truth-layer endpoints, unknown/estimated expiry input, adoption
path, reconciliation UX), plus material PARTIAL rows U4, U7, U8, U12 (provenance/expiry-
kind presentation, edit/move UX, expiry correction). These match the examples §43 lists
as T13-justifying ("receipt/vision ingestion not production-complete [as truth]",
"candidate confirmation/correction incomplete", "required receipt provenance absent",
"required Inventory UX V2 screens/actions missing", "reconciliation UX required but
absent"). Outcome A would require every material criterion DONE or explicitly
superseded; 9 MISSING rows and 4 material PARTIAL rows exist with no supersession
evidence.

**Decision: T13 REQUIRED.** Scope definition (not implementation) is in
`docs/ai/release/T13_PROPOSED_SCOPE.md`. Because T13 is product scope on top of a
technically certified RC, the owner may alternatively decide to **merge `64c5501` first
and run T13 as the next train task** — that is a release-management choice this audit
does not make; what this audit establishes is that the original T11 scope is not
fulfilled inside `64c5501`, so "NO T13 REQUIRED" cannot be stated.

## 9. Test evidence summary (§40, §47)

Existing tests executed from the clean worktree at exact `64c5501`
(`pnpm install --frozen-lockfile`, lockfile unchanged; Node v24.19.0, pnpm 10.26.0):

```
pnpm exec vitest run tests/unit/receipt-scan.test.ts tests/unit/scans.test.ts \
  tests/unit/scan-privacy.test.tsx tests/integration/scan-response-loss.test.ts \
  tests/integration/inventory-adoption.test.ts
→ Test Files 5 passed (5) · Tests 55 passed (55) · 5.37 s
  (scan-response-loss 19 · scan-privacy 8 · receipt-scan 4 · scans 5 · inventory-adoption 19)
```

Temporary audit probe (uncommitted, created under `tests/__audit_probe__/` in the RC
worktree, run, then deleted; worktree `git status --porcelain` empty afterwards) — 4/4
passed, facts recorded: adopted receipt confirmation of an un-dated 500 g line with
confidence 0.55, price 85,000 ₫, purchase date 2026-09-10 → lot `source_type='SCAN'`,
`source_id='receipt_probe'`, `purchased_at=null`, `amount_minor=null`, `currency=null`,
`expiry_kind='KNOWN'`, `expiry_at='2026-09-16'` (today + PORK_BELLY 4-day default);
`inventory_observations` count 0; OCR 2000 g corrected to 1200 g → `scan_items.estimated_quantity=1200`
(raw lost), lot 1,200,000 milli; re-confirming a confirmed receipt with 9 instead of 2
→ HTTP 200 `idempotentReplay:true`, lot unchanged at 2,000 milli; household B
`GET`/`confirm` of A's receipt → 404/404, no mutation. The full 3,092-test certification
was not rerun (not required; no application change).

Evidence classes present per area: UNIT (AI schemas/router, scan hydration), INTEGRATION
(scan quota/queue/response-loss, adoption scan confirm, T09/T10/T11/T12 suites), ROUTE
(T12 shopping/cook/GET), REAL_D1 (T09/T10/T11/T12, 70), BROWSER (D3 auth flow only).
**Missing evidence:** any test of `ReceiptReviewPage`/`ScanResultPage`/`InventoryPage`/
`IngredientDetailPage` behaviour; any assertion on `expiry_kind` written by scan/manual
adopted writers; any assertion that receipt price/date reach (or intentionally do not
reach) lots; any browser check of inventory/scan flows.

## 10. Prohibitions honoured (§0, §48)

No main merge/modification; no deploy; no remote D1; PayOS untouched; no migration
change or 0031; no application refactor or fix; `MEAL_PLANNER_ENABLED` not enabled;
no rebase/squash/force-push; workspace overlay `.hoplite/settings.json` never staged.
Application tree at the audit docs HEAD is byte-identical to `64c5501`
(`ROADMAP_AUDIT_HEAD = 3fce917ad6e079f76cf3bdd55e354ce0e35054bf`;
`git diff 64c5501 3fce917 -- . ':(exclude)docs'` empty; `git merge-base --is-ancestor 1cae11e 3fce917` PASS). Docs added/updated only: this file, `T13_PROPOSED_SCOPE.md`,
`docs/ai/{CURRENT_STATE,TASK_BOARD,HANDOFF}.md`, `docs/ai/inventory-truth/{CURRENT_STATE,TASK_BOARD}.md`.
