# Inventory Truth release train (T08→T12) — final integration review (2026-09-12)

**Verdict: RELEASE CANDIDATE NOT READY — one P2 release-hygiene defect
(`.hoplite/settings.json` deleted from the tree) and one P2 documentation/scope
gap (undocumented `inventory_items` reader in the flag-gated `/meal-planning`
planner). No P0/P1. Application behavior, tests and migrations are certified
clean; remediation is small and targeted (below).**

Companion documents: `INVENTORY_TRUTH_ANCESTRY.md`, `INVENTORY_TRUTH_CHANGE_MANIFEST.md`.

## 1. Identity and lineage

- Repository ID **1364064929** → `vb-2f/frigo-dev` (GitHub API), default `main`.
- Review HEAD `5cb4caa0…` (T12 docs); app RC `d1560018…` is its direct parent.
- All 11 checkpoints (main, T08 ×3, T09 ×2, T10 ×2, T11 ×2, T12) are ancestors ✅.
- `origin/main` is exactly `d1b06732…` (unchanged). RC is 54 ahead / 0 behind —
  pure fast-forward; no main-side commits to reconcile.
- History is linear with 3 internal train merges; no rebase/squash/force-push.

## 2. Final application tree (main → `d156001`)

120 files, +24,242/−185: 8 migrations, 8 domain, 7 db, 6 routes, 3 other src,
38 tests, 46 docs, 4 config. No dependency/lockfile/wrangler/tsconfig changes, no
binaries, no secrets, no generated files. Only cross-cutting product change:
`auth.ts` guest→account inventory transfer deferred (`409 INVENTORY_TRANSFER_DEFERRED`)
— an intentional T09 writer-audit closure (`66858c5`) with updated tests.

## 3. Task-by-task survival (semantic, not just ancestry)

| Task | Evidence in RC tree | Status |
| --- | --- | --- |
| T08 | `backfillLegacyInventory`, 0023 lot/location schema + revision triggers, `inventory-truth.test.ts` (fresh replay of 30 migrations; populated-0022 upgrade preserves rows/events) | intact |
| T09 | `executeInventoryLotCommand`/`executeInventoryFefoCommand`, CAS + write-guard (`T09_GUARD`), receipts, events, projection mirror, `runLegacyInventoryBatch` fence (`T09_WRITER_FENCE`), `executeInventoryAdoption`; 654/654 focused, 44 real D1 | intact |
| T10 | `recordInventoryObservation` (evidence only), `confirmReconciliationDecision` composing into T09 commands, `observationClaimGuard` (`T10_OBSERVATION_CLAIM_GUARD`); 98/98, 7 real D1 | intact |
| T11 | `readInventoryAuthority`/`assertProjectionParity`, funnel authority-first with KV bypass and fail-closed `InventoryReadError`; `computeReadFreshness`, `displayQuantity`; 39/39, 11 real D1 | intact (T12 tightened alias gating; no regression) |
| T12 | closed-loop suites (integration 9, routes 5, real D1 8); adopted-cook replay-first fix present; STALE_SNAPSHOT-only race assertion | intact |

No later task overwrote an earlier task's semantics (all focused suites pass at the RC).

## 4. Architecture invariant

evidence → T10 observation → reconciliation → T09 command authority →
`inventory_lots` → T11 read authority → consumers. `inventory_items` is a
same-batch projection mirror; the funnel never consults it for adopted content
and never falls back to it or to KV after an authority failure (code reviewed at
`inventory.ts:494–503`; proven by T11/T12 tests). Second-ledger search: tables
added by 0023–0030 are `inventory_lots`, `inventory_commands`,
`inventory_adoption_receipts`, `inventory_observations`,
`inventory_reconciliation_decisions`, `storage_locations` — none is a competing
stock ledger (commands/receipts/decisions are immutable audit; observations are
evidence). No `current_inventory`/`*_v2`/planner/scan caches exist server-side.

## 5. Reader audit (fresh grep at RC)

| Reader | Class | Adopted reachable? | Decides truth? |
| --- | --- | --- | --- |
| funnel native branch (`GET /inventory`, recipes, scans, week, notifications) | READ_AUTHORITY | yes | authority |
| funnel legacy branch + 1h KV | LEGACY_COMPATIBILITY | no (gate first) | non-adopted only |
| `inventory.ts:604` POST id preflight | LEGACY_COMPATIBILITY (identity guard) | yes, but reads no stock | no |
| `recipes.ts:398`, `scans.ts:993`, `week.ts:1405`, `notifications.ts:26` | LEGACY_COMPATIBILITY | no (native diversion precedes) | non-adopted only |
| `packages/db` authority internals (`inventory-lot-commands`, `-adoption-executor`, `-truth`, `queries.ts`) | READ_AUTHORITY inputs (parity/backfill) | — | no |
| **`packages/db/src/meal-planning-snapshot.ts:201` (`/meal-planning/*` T02–T04 planner)** | **UNCLASSIFIED in train docs → SAFE_DEFERRED** | yes, if `MEAL_PLANNER_ENABLED='true'` | reads projection quantity/freshness for ranking; **read-only, never mutates**; pre-existing on main, untouched by train; **not bound in `wrangler.jsonc` → routes return 404 in deploy config** |

UNKNOWN production readers after this review: **0** (the planner reader is now
classified SAFE_DEFERRED with a removal condition), but it was **absent from
READ_CONSUMER_MAP / FINAL_AUTHORITY_MAP**, which claimed UNKNOWN = 0 → **P2
documentation/scope defect** (see §11).

## 6. Writer audit (fresh grep at RC)

`inventory_items` writers: T09 mirror (`inventory-lot-commands.ts:429/433`,
COMMAND_AUTHORITY); legacy routes `inventory.ts:843/1022`, `recipes.ts:484`,
`scans.ts:1148/1171`, `week.ts:1440/1463`, `queries.ts` constants — all behind
`runLegacyInventoryBatch` + native diversions (LEGACY_COMPATIBILITY, unreachable
for adopted stock). `inventory_lots` writers: T09 commands, adoption executor,
T08 backfill (COMMAND_AUTHORITY). Reconciliation writes only decisions + T09
commands (RECONCILIATION_ADAPTER); observations write only evidence
(OBSERVATION_ONLY). Meal-planning service performs no inventory writes.
**UNKNOWN production writers = 0.**

## 7. Migration chain

30 files, 0001–0030, no duplicate numbers; 0001–0022 byte-identical to main;
0023–0030 each introduced once and never modified (blob-identical at RC).
`pnpm check:migrations` (sqlite3 replay incl. Week fixtures + double-apply of
0010/0011) PASS; `pnpm schema:check:local` PASS. **Real workerd/D1 fresh replay
0001→0030: APPLIED 30**, `PRAGMA foreign_key_check` = [], expected tables (9),
triggers (41) and indexes (12) present, `inventory_lots.legacy_item_id`,
`households.inventory_version`, `inventory_events.command_id` present.
Legacy upgrade simulation: permanent `inventory-truth.test.ts` "upgrades a populated
0022 database…" (rows/events preserved, backfill 8 lots, parity ok) PASS.

## 8. Clean release-candidate checkout (`/tmp/frigo-rc` @ exact `d156001`)

Node v24.19.0, pnpm 10.26.0, `pnpm install --frozen-lockfile` OK, lockfile
unchanged before/after. **Full 3,085/3,085 across 119 files (188.57s)**; T09
654/654; T10 98/98; T11 39/39; T12 22/22; **all real local D1 70/70** (44+7+11+8);
lint/typecheck/build PASS; `migration-smoke=ok`; schema gate PASS;
`git diff --check` clean; **`git status --porcelain` empty**.

## 9. Closed-loop smoke, concurrency, idempotency, tenancy, fail-closed, cache

All required matrices are covered by retained permanent tests and passed at the RC:
manual→read, DISMISS unchanged, accepted reconciliation changed, recipe USE reread,
planner (week) regenerate, shopping add reread, cook FEFO reread, drift immunity,
response-loss replay, cross-tenant rejection, adopted-empty `[]`; READ vs
CORRECT/MOVE/USE/DISCARD/FEFO/reconciliation, reconciliation vs reconciliation,
reconciliation vs manual CORRECT (loser **`STALE_SNAPSHOT` only**; the sole
`PERSISTENCE_FAILED` mention in the suite is the negative comment), scan/shopping
races, cook response-loss retry; exact/altered-key/stale semantics; tenancy B→A
denied across read/mutate/mapping/reconcile/scan/shopping; fail-closed for corrupt
mapping, missing/forged receipts, invalid quantity/expiry, drift, stale snapshot;
adopted reads never serve or refresh `inv_*` KV (route-level stale-KV tests).

## 10. API compatibility

Adopted rows are a strict superset of legacy rows: shared `id, lotId?…` — legacy
keys `addedDate, category, dataSource, expiryDate, freshness, householdId, id,
ingredientId, name, normalizationStatus, quantity, storage, unit, updatedAt,
version` all present; adopted adds `lotId, legacyItemId, lotVersion, quantityMilli,
canonicalUnit, expiryKind, estimatedExpiryDate, state`. `id` remains the projection
id; `version` remains the legacy CAS; kg/l aliases are agreement-gated. Recipes,
week, scans and notifications consume the same funnel rows.

## 11. Defects

| # | Sev | Finding | Repro | Remediation |
| --- | --- | --- | --- | --- |
| D1 | **P2** (release hygiene) | `.hoplite/settings.json` is tracked on main (blob `3818a00`, sandbox setup/run scripts) but **deleted** from the RC tree at `4553b8a` (T11). Merging would remove a platform config file from main. | `git diff --name-status d1b0673 d156001 -- .hoplite/settings.json` → `D` | Targeted successor commit on the T12 branch restoring the **main blob** (`git checkout d1b0673 -- .hoplite/settings.json`), as T09/T10 did (`09f13c4`, `ab1e983`); must not overwrite the external workspace overlay (SHA `6d8f5b45…`) — commit the repo blob only. |
| D2 | **P2** (docs/scope) | `packages/db/src/meal-planning-snapshot.ts:201` reads `inventory_items` for the flag-gated `/meal-planning/*` planner without an adoption gate and is absent from READ_CONSUMER_MAP / FINAL_AUTHORITY_MAP (which state UNKNOWN = 0). Read-only; pre-existing on main; untouched by the train; `MEAL_PLANNER_ENABLED` is not bound in `wrangler.jsonc`, so unreachable in the deploy config. For an adopted household with the flag on, ranking would see projection rows (mirrored by T09, so normally coherent, but not authority and not drift-immune). | grep at RC; `wrangler.jsonc` vars | Document as `SAFE_DEFERRED` with removal condition "route `loadMealPlanningSnapshot` inventory through `readInventorySummary`/funnel when the planner flag is enabled for adopted households" (follow-up task), and update the two maps. No code change required for certification. |

P0: NONE · P1: NONE · P3: bounded non-adopted legacy compatibility (by design).

## 12. Merge safety statement

Application code, migrations and tests of `d156001` are certified clean and
fast-forwardable onto `d1b0673`. Certification is withheld only until D1 is
remediated (restore the tracked platform file) and D2 is documented, after which
a re-run of §8 on the new SHA closes the review. **No merge, deploy or remote D1
action was performed by this review.**
