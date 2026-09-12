# Inventory Truth Layer — repository authority

Current checkpoint: **T12 closed loop COMPLETE + runtime-verified** — application freeze `d15600186c3e73faba011eb690ac6cd70e8d3d2d` (real D1 70/70 incl. 8 T12 cases; route-level shopping/cook/GET proofs; STALE_SNAPSHOT race classification; adopted-cook replay fix; 3,085 full/119) —
Prior checkpoint: **T12 closed loop COMPLETE — T08–T12 release train final** — application freeze `22f675d1cca76d05c93ebb2ed40bbaea11a72238` (closed-loop suite, authority/writer maps UNKNOWN=0, agreement-gated aliases; 3,072 full/117; real D1 62/62) —
Prior checkpoint: **T11 read authority COMPLETE (hardened)** — application freeze `c15c9a81fc4367b3506a7e2693798ebe1424b0a9` (real D1 62/62 incl. 11 T11 cases; adopted-empty, MOVE/DISCARD/FEFO races, activeCount, kg/l aliases, fail-closed freshness) —
First T11 checkpoint (superseded): **T11 read authority COMPLETE** —
`hoplite/himera-6d3eda84-t10-observation-reconciliation-t11-inventory-read-authority`,
application freeze `657201f3a12f18dd96cc96adeac0dd1d3b75e6f4` (PR #3; corrective `4553b8a` after platform
overlay auto-commit `c7e2296`). Inventory Lot Authority is now the canonical
READ authority for adopted households: `readInventoryAuthority`/
`readInventoryLot`/`readInventorySummary` (packages/db/src/inventory-read-
authority.ts) serve `GET /inventory`, recipes, scans list reads, weekly
planner and notifications from `inventory_lots` + validated mapping evidence;
`inventory_items` is a checked-for-parity compatibility mirror, never a read
fallback; observations stay evidence; the event log stays audit evidence.
Full 3,041/3,041 across 115 files; real D1 51/51; all gates PASS from the
clean exact-SHA checkout. No migration. Main NOT merged; production NOT
deployed; remote D1 NOT touched. **T12 NOT STARTED.**
Previous checkpoint: **T10 observations and reconciliation COMPLETE** —
application freeze `6c28858acd0627d2d602998107c2e260c5e4f0d5`, published/fetched
on `hoplite/himera-6d3eda84-t10-observation-reconciliation` (vb-2f/frigo-dev,
repository ID 1364064929), descending from the verified T09 lineage (freeze
`bf391c5fdcdd9e9c2f2257db515815e082cb4381`, docs `d522769ae89496fd4b3f26419f1fdfe23d9e926a`,
internal train merge `668920fa462524e65a79d31a7b0844720baf38e0`; main
`d1b06732f8a80db4e77986df31ff28d9f04641fa` untouched). 2,990 full / 112 files,
1,097 focused / 19 files, 49 real local-D1, all static/build/30-migration/schema
gates PASS from a clean detached exact-SHA checkout with empty status. T10 = the
observation/evidence/reconciliation layer above T09 authority (additive 0030;
pure planner; decisions compose T09 CORRECT/MOVE in one atomic batch; no second
stock writer; no HTTP routes). **T10 COMPLETE — READY FOR INDEPENDENT REVIEW;
T11 (receipt/vision truth + Inventory UX V2) and T12 (closed-loop integration)
are NOT STARTED.** See `t10/README.md`, `t10/CONTINUATION.md` and
`t10/VERIFICATION.md`. The T08/T09 sections below are historical provenance.

Historical T09 checkpoint record: aa43e069edbff7843e9eb7532ff386b27be96a17 and
later T09 freezes (9bf9ac0 → 2742738 → e796f69 → df73bc0 → bf391c5) — superseded
as current by the T10 checkpoint above; all remain ancestors of the T10 branch.

Current checkpoint (2026-09-11): published E application
`9bd1e6bc000cd2e94121469babb1a5eb63a5047f`; successor fetch/equality and frozen-D
ancestry PASS. F is active, G/H pending. Final E proof: 1,172 focused / 2,659 full
tests, static/build/local migration gates PASS. Earlier prepublication E statuses
below are historical; canonical branch/production exclusions remain unchanged.

## Current continuation authority — 2026-09-11

See `t09/CONTINUATION.md`: canonical repository **vn-2d/frigo-dev**, current
writable continuation **hoplite/kos-2a686759**, directly at verified interrupted
F `66858c5`. Transfer/ancestry and 2,685-test/static/build/migration baseline PASS.
Previous repository names are historical provenance only. The prior continuation
`hoplite/orchemenos-e002591e` is read-only; no second successor is needed.

Historical pre-transfer authority: frozen T09D
base `hoplite/euhesperides-d77023a5` at `811f7e8463303e010199741d66f88ab8a817212d`,
user-authorized writable successor `hoplite/orchemenos-e002591e`. Same T09 task;
this supersedes earlier same-branch-only constraints. Publish successor only.

Published successor docs: `8bf32ed4e41ed3341215c6376e0c13ef13043616`, before E code.
T09E now adds internal `packages/domain/src/inventory-fefo.ts` and
`packages/db/src/inventory-lot-commands.ts` FEFO USE: deterministic exact allocation,
one atomic 1–32-effect command, v2 receipt/event evidence, bounded snapshots/JSON and
additive 0027. Keep v1 predicates and migrations 0023–0026 immutable. Contextual
units fail closed; no adoption/live writer/HTTP/read/UI cutover. E remains
uncommitted pending final full gate/review/publication; F–H are not complete.
Latest post-fence focused gate passes 1,172 tests / 11 files, including 35 actual
local D1 tests; the latest full rerun is still pending.
DEC-011 and `t09/VERIFICATION.md` define bounds, corrected findings and gate chronology.

## Historical T09 authorization (superseded repository/branch identity)

User confirmed `vn-2b/frigo-dev` on 2026-09-10; the original T09 owner was outdated.
Development T09 branch `hoplite/euhesperides-d77023a5` starts at exact fetched T08
`8f8788c1a0c9e486657751ef3875a5baa5334dec` and was published/fetched before code.
Active contract: `../tasks/T09-inventory-lot-engine.md`; review packet: `t09/`.
T09 is authorized for live mutation authority only; reads stay legacy until T12.
Never integrate or modify legacy Frigo, main, production/staging, remote D1 or
PayOS. Mirror anchors and unavailable legacy observation are explicit in REVIEW_INDEX.
Historical T08 sections below remain foundation evidence, not current task limits.

## Objective and roadmap

Answer what Frigo believes is in a household and what evidence supports it.
T08 builds a foundation, not the complete truth engine.

- T08: storage locations, lots, quantity/money/expiry/provenance contracts,
  additive persistence, legacy backfill, projection/parity and handoff.
- T09: lot commands, FEFO, CAS/idempotency, existing event authority, dual-write.
- T10: observations and reconciliation.
- T11: receipt/vision truth and inventory UX V2.
- T12: closed-loop integration and hardening.

## Authority and branch policy

User confirmed `vn-2c/Frigo` on 2026-09-09 (the initial packet named another owner).
Canonical handoff/publication branch: `hoplite/xanthos-7d942897`.
Originally requested local branch: `feature/t08-inventory-truth-foundation`.
On 2026-09-10 the user explicitly permitted publication on the Hoplite-authorized
branch instead of the original canonical name (DEC-006). This supersedes only the
branch-name restriction; every main/deployment/database/payment exclusion remains.
BASE_MAIN_SHA: `d1b06732f8a80db4e77986df31ff28d9f04641fa`.
Git, source, migrations, tests and these documents are authoritative, not chat or
account memory. On takeover read these six files in the specified order, inspect
Git status/HEAD/main and diff Last Verified SHA..HEAD before edits. Use trusted
repository-bound fetch/publication tools; shell fetch is blocked in this workspace.
Only the authorized handoff branch may be published. Never force-push or merge/rebase a
new main automatically; record divergence and numbering collisions instead.

## Architecture and compatibility

Existing inputs -> `inventory_items` / `inventory_events` -> explicitly invoked
foundation backfill -> `inventory_lots` / `storage_locations` -> pure projection.
Existing inventory remains authoritative. Foundation persistence is not a live
read-path switch. No planner/cook/shopping/scan/frontend DTO or workflow cutover.
The legacy schema already permits multiple rows per ingredient; preserve row
identity rather than assuming one aggregate row per ingredient.

## Invariants

- Household ownership on each location/lot; composite relation forbids cross-tenant binding.
- Nonnegative deterministic quantities; unsupported conversion must fail, not round.
- Valid ingredient references when known; unmapped identity remains unknown.
- At most one LEGACY_BACKFILL lot per legacy inventory row.
- Backfill preserves observable legacy facts; representable active totals prove parity.
- UNKNOWN != ZERO; ESTIMATED != CONFIRMED; OBSERVED != VERIFIED.
- Money uses validated currency/minor digits/integer minor amount, never new REAL prices.
- No fabricated purchase/receipt/merchant/price/expiry confidence.

## Exclusions

Main, production/staging deployment, remote D1, secrets and flags are untouched.
The T01–T07 release/production reconciliation stream remains independent.
PayOS, billing, subscriptions, checkout and payment webhooks/migrations are protected.
No new service, event bus, auth changes, observation engine or T09–T12 implementation.

## Dependency audit

Latest migration at base is `0022_generated_meal_plans.sql`; T08 schema uses 0023.

| Dependency | Actual authority / invariants |
| --- | --- |
| Inventory reads | `packages/db/src/queries.ts` GET_INVENTORY/GET_INVENTORY_ITEM; inventory routes map rows to old DTO. Recipes, Week, notifications and `meal-planning-snapshot.ts` read household stock. |
| Inventory writes | `routes/inventory.ts`: manual/add/edit/discard; `routes/week.ts`: persisted-plan shopping import; `routes/scans.ts`: confirmed drafts; `routes/recipes.ts`: cook deduction; `routes/auth.ts`: seed and guest household transfer. No T08 caller changes. |
| Events | Existing `inventory_events` stores REAL deltas, unit, event type, reason, JSON metadata; item ID intentionally has no FK (history survives deletion). It is a command audit ledger, not enough to reconstruct full stock/expiry/price state. No event rewrite or second ledger. |
| CAS/idempotency | Migration 0009 version; inventory PATCH/DELETE and cooking guard household+id+observed version; batch/event/command replay protection stays authoritative. Scans fence confirmation/queue state; retries must not consume/import twice. |
| Scan/receipt | Actual tables are `scans` and `scan_items` (not scan_sessions). Draft predictions require user confirmation. 0013 stores merchant/invoice/purchase_date/total_amount_vnd and item unit_price_vnd/total_price_vnd as nullable legacy REAL. None is promoted into lot price/purchase facts. |
| Quantity/units | Legacy quantity/delta/scan/shopping/recipe/nutrition values use REAL. T02 `Quantity` already supplies exact decimal-rational arithmetic from observable JS numbers; strict conversion only g↔kg/ml↔l. Count has no mass; contextual pack/bunch/slice cannot prove cross-lot equivalence. |
| Money | T05 shopping uses VND/JPY scale 0, USD/EUR scale 2, safe integer inputs and BigInt intermediates. New lot foundation mirrors that supported currency set, never changes legacy REAL fields. |
| Expiry/freshness | Legacy expiry_date is permissive text. `computeFreshness` can use default shelf life; it is a heuristic, not confirmed expiry. 0019 adds opened_at/expiry_kind/expiry_source with unknown defaults and evidence-requires-date triggers, but does not wire live writers. Unknown-source dates must not become confirmed. |
| Tenancy | Session-derived household plus worker tenancy guards; D1 reads/writes bind household. Inventory/locations/lots reference household; known ingredient FK is global catalog. Unknown legacy ingredient is valid NULL, not a fabricated catalog ID. |
| Existing indexes | Inventory: household; freshness; household/version; partial household/expiry for positive dated stock. Events: item. Scan items: scan. Ingredients: PK, alias/translation/catalog indexes. No lot-aware runtime query today. |
| FK/cascade | Inventory household cascades; ingredient FK restricts invalid/deleted referenced ingredient. Events household cascades but not item deletion. Scan items cascade with scan; scans reference user/household. New provenance reference must not block old inventory DELETE commands. |

Additional audited distinctions: inventory DELETE endpoint soft-deletes to zero;
the raw physical-delete SQL helper has no discovered runtime caller. Cooking
orders by updated_at/id (not FEFO). Scan/shopping increment version but use their
command fences, not an observed inventory-version predicate. Guest transfer
updates legacy household IDs without bumping versions; new lots deliberately do
not participate. Legacy recommendation/Week paths use differing first/last-row
policies already. None of these existing behaviors is rewritten in T08.

T08 parity is quantity/state projection, not legacy freshness eligibility. A
positive quantity with legacy out_of_stock freshness stays positive and is not
silently discarded to satisfy a planner policy. Future ownership transfer and
live lot adoption require T09 reconciliation of both household and legacyVersion.

Regression anchors: inventory-idempotency, command-route-integrity,
cooking-route-allocation, scans/scan-quota-idempotency, week-core-flow,
meal-planning-snapshot and t07-persistence/security tests. Full suite remains required.

## New index rationale

Location `(id, household_id)` unique key supports composite lot ownership FK;
partial unique `(household_id,type) WHERE is_default=1` enforces one default bucket.
Lot `(household_id,storage_location_id)` serves household snapshot reads and the
composite FK child lookup; ingredient index supports global FK parent checks.
Partial unique legacy source ID is durable backfill identity and retry lookup.
No speculative FEFO/event index is introduced. Query-plan evidence belongs in tests.

## Foundation entry points and takeover verification

`packages/domain/src/inventory-truth.ts`: StorageLocationSchema, InventoryLotSchema,
defaultStorageLocations, toLotQuantity, legacyInventoryToLot, projectInventoryLots,
checkLegacyLotParity. Leaf imports intentionally do not change old domain barrels.

`packages/db/src/inventory-truth.ts`: explicitly invoke backfillLegacyInventory(db,
authorizedHouseholdId), then readInventoryTruthSnapshot(db, authorizedHouseholdId).
No route calls either helper. Backfill returns inserted/skipped counts plus a
diagnostic parity report; a retry never refreshes an existing synthetic snapshot.
The reader uses a coherent D1 batch for legacy rows, lots and locations.

Run `pnpm exec vitest run tests/unit/inventory-truth.test.ts
tests/integration/inventory-truth.test.ts` as one shell command for the 130 focused
checks. See VERIFICATION.md for full regression and local-only migration commands.
Do not run any remote/database/deploy command to validate this foundation.

T08 COMPLETE. Last code: dd2ecc6f7066250dfdc5214a3d6c356e1479b61e; final verified
published checkpoint: fb00f46d4633c9659e812be9f86119533973a8bd. Subsequent changes
are docs-only. Checkout `origin/hoplite/xanthos-7d942897` for cross-account handoff;
the original feature branch is not the remote handoff. See T08_VERIFICATION.md,
CURRENT_STATE.md and the latest VERIFICATION.md entry for evidence and T09 prerequisites.
