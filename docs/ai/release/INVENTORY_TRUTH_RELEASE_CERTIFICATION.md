# Inventory Truth release train (T08→T12) — final independent integration review

Date: 2026-09-12 · Reviewer: Hoplite (independent of the T08–T12 implementation threads)
Review start: docs HEAD `5cb4caa0d5b3c86b00954d77cd40b16027c21df1` (exact, not main)
Application release candidate (RC): `d15600186c3e73faba011eb690ac6cd70e8d3d2d`
Companion documents: `INVENTORY_TRUTH_ANCESTRY.md`, `INVENTORY_TRUTH_CHANGE_MANIFEST.md`.

## Remediation status (2026-09-12, after this review)

Defects D3/D1 were closed and D2 documented at application freeze
`64c5501ab0110658718b3752bd84e537f0854e12` on
`hoplite/inventory-truth-final-remediation` — see
`INVENTORY_TRUTH_REMEDIATION.md`. The verdict below is the historical verdict
for RC `d156001`; `64c5501` is the candidate for re-certification.

## Verdict

**RELEASE CANDIDATE NOT READY.** No P0. **One P1 (D3, user-facing registration
regression for web guests)** and two P2 (D1 platform file deleted from the tree,
D2 undocumented projection reader in the flag-gated planner). Everything else in
§1–§16 is certified from a clean detached checkout of the exact RC SHA: full suite
3,085/3,085, real local D1 70/70, all static gates PASS, migration chain
reproducible on sqlite and real workerd/D1, architecture invariant and tenancy/
idempotency/fail-closed/cache certifications hold. Remediation is small and
targeted (§17). **No merge, deploy, remote D1 or PayOS action was performed.**

## 0. Relation to the earlier certification commit `b794ee8`

The T12 branch tip carries one docs-only commit after the review start,
`b794ee8` (“certify … NOT READY: 2 P2”), with files of the same names under
`docs/ai/release/`. It is **not** part of the RC and was not used as a base: this
review was executed independently from `5cb4caa` and reproduces its D1/D2 findings
with fresh evidence, and additionally finds **D3 (P1)** by exercising the shipped
web client against the RC server. When the train is reconciled, the versions in
this commit supersede `b794ee8`'s.

## 1. Identity gate

GitHub API: `/repos/vn-2f/frigo-dev` → `id 1364064929`, default branch `main`;
`/repositories/1364064929` resolves to the same repository; `vb-2f/frigo-dev` (the
name given in the packet) answers `301 Moved Permanently` to it. Identity anchor
**PASS** (ID match; owner renamed `vb-2f` → `vn-2f`).

Workspace record (task checkout, before any action): `git remote -v` =
`https://github.com/vn-2f/frigo-dev.git`; `git status --porcelain` = ` M
.hoplite/settings.json` (platform overlay; never staged, committed, restored or
reset — see §16); `git branch -vv` = `hoplite/akraiphia-akraiphnion-a03445c7` at
`c71692a`; `git rev-parse HEAD` = `c71692a5…`; `origin/main` after fetch =
`d1b06732f8a80db4e77986df31ff28d9f04641fa`. Review work was done in two fresh
detached worktrees: `/tmp/hoplite/rc-review` @ `5cb4caa` (docs) and
`/tmp/hoplite/rc-app` @ `d156001` (application gates).

## 2. Lineage (packet §6)

All 11 checkpoints are ancestors of `5cb4caa`; the ordered chain holds 11/11;
`d156001` is the direct parent of `5cb4caa`; T08 starts at `43718c2` whose parent
is `d1b0673`. Three internal train merges (`668920f`, `30ce4ea`, `14c02f8`), no
merge from main, no rewrite. Full graph: `INVENTORY_TRUTH_ANCESTRY.md`. **PASS.**

## 3. Main divergence (packet §7)

`origin/main` **is still `d1b0673`** (recorded explicitly). Merge base with both
`d156001` and `5cb4caa` = `d1b0673`. `main...d156001` = 0 behind / **54 ahead**,
120 files, +24,242/−185. `main...5cb4caa` = 0 / 55, 120 files, +24,445/−185.
No main-side commits exist to audit for conflicts; the candidate is a pure
fast-forward. **PASS.**

## 4. Final application tree (packet §8)

Manifest and classification: `INVENTORY_TRUTH_CHANGE_MANIFEST.md` (DOMAIN 8, DB 7,
MIGRATION 8, WORKER_ROUTE 7, API 2, TEST 38, DOC 46, CONFIG 1, OTHER 3). No
dependency churn, no config/binding change, no binaries, no generated or local
files, no secrets. Two items require attention: the tracked `.hoplite/settings.json`
deletion (D1) and the `auth.ts` guest-transfer deferral (D3).

## 5. Task-by-task survival (packet §9)

Checked which earlier-task files later tasks touched, then read the deltas:

| Task | Later touches of its application files | Semantics at RC |
| --- | --- | --- |
| T08 | `packages/db/src/inventory-truth.ts` +5 lines (T09 `9bf9ac0`: refuse re-backfill of an adopted household); 0023 and `packages/domain/src/inventory-truth.ts` untouched; gate scripts extended only | Foundation schemas/contracts intact; backfill still explicit/idempotent; the guard strengthens, not weakens |
| T09 | `inventory-lot-commands.ts` (T11 `657201f`): **3 `export` keywords only**; routes `inventory/recipes/scans/week.ts` (T11 read funnel, T12 cook replay-first) | Command authority, CAS + write-guards, receipts/idempotency, FEFO, events, projection mirror, writer fence and adoption executor byte-identical in logic; 654/654 (10-suite selection) and 1,432/1,432 (22 T09-lineage suites) PASS |
| T10 | **no later touches** | Observations evidence-only; `confirmReconciliationDecision` composes T09 CORRECT/MOVE in one batch with the decision receipt and claim guard; no HTTP route exposes T10 (by design, documented) — 98/98 PASS |
| T11 | `inventory-read-authority.ts` (T12 `22f675d`: alias agreement-gating), `recipes.ts` (T12 `d156001`: adopted cook replays receipt first) | Funnel: native → `readInventoryAuthority`, KV bypassed, any failure → `InventoryReadError` (never projection, never KV, never `[]`); 39/39 PASS |
| T12 | — | closed-loop suites 22/22 incl. 8 real D1; STALE_SNAPSHOT-only race |

No later task overwrote an earlier task's semantics. **PASS.**

## 6. Architecture invariant (packet §10) and second-ledger search (§13)

Code path at RC: external evidence → `recordInventoryObservation` (evidence rows
only) → `planInventoryReconciliation` (pure) → `confirmReconciliationDecision` →
`composeInventoryLotCommands` (T09) → `inventory_lots` (+ same-batch
`inventory_items` mirror, receipts, events) → `readInventoryAuthority` (T11) →
`fetchHouseholdInventoryFromDb` → `GET /inventory`, recipes, week planner, scans,
notifications. Tables added by 0023–0030: `storage_locations`, `inventory_lots`,
`inventory_commands`, `inventory_adoption_receipts`, `inventory_observations`,
`inventory_reconciliation_decisions` — commands/receipts/decisions are immutable
audit (triggers), observations are evidence, no views/materializations. Server
caches: only `inv_${householdId}` (legacy branch, 1h) and Week `plan_*` keys.
Searched `current_inventory|inventory_state|reconciled_inventory|scan_inventory|
planner_inventory|cached_inventory|*_v2` in `src/ packages/ migrations/`: no stock
ledger (only Week `meal_plan_slots_v2`). Client `localStorage` inventory cache is a
display cache fed by API responses. **No second authoritative stock ledger. PASS.**

## 7. Reader audit (packet §11) — fresh grep of `src/` + `packages/` (non-test)

| Reader | Class | Adopted reachable? | Can decide stock truth? |
| --- | --- | --- | --- |
| Funnel native branch → `readInventoryAuthority` (`inventory.ts:494`) serving `GET /inventory`, `recipes.ts` ×6, `scans.ts` ×6, `week.ts:584` (`fetchWeekInventory`), `notifications.ts:19` | READ_AUTHORITY | yes | authority |
| `readInventoryLot`/`readInventorySummary`/`assertProjectionParity`; `readAdoptedLotSnapshot` (adapters) | READ_AUTHORITY | yes | authority |
| Funnel legacy branch `SQL.GET_INVENTORY` + KV put/get (`inventory.ts:506–525`) | LEGACY_COMPATIBILITY | **no** (adoption gate first) | non-adopted only; removal = universal adoption |
| `notifications.ts:26`, `recipes.ts:398`, `scans.ts:993`, `week.ts:1405` raw `inventory_items` | LEGACY_COMPATIBILITY | no (native diversion precedes at `notifications:18`, `recipes:346`, `scans:1138`, `week:1358`) | non-adopted only |
| `inventory.ts:604` (POST id preflight, `LIMIT 1` without household filter) | LEGACY_COMPATIBILITY (tenancy guard) | yes | no — returns `409 CONFLICT` for foreign ids without content; pre-existing on main |
| `inventory.ts:138/376/675/748/969` `GET_INVENTORY_ITEM` (adopted response row after same-batch commit; PATCH/DELETE preflights; replay) | LEGACY_COMPATIBILITY (response shape/preflight) | yes (`adoptedItemResponse`) | no — identity/presentation only; authority already committed the lot in the same batch |
| `inventory_events` reads (`inventory.ts:368/612/682/983`, `week.ts:1643`) | OBSERVATION_ONLY / audit (idempotency fingerprints, import-count integrity) | yes | no |
| `packages/db` internals: `inventory-truth.ts` (backfill source), `inventory-lot-commands.ts:177` (parity rows), `inventory-writer-fence.ts:33`, `inventory-adoption-executor.ts`, `inventory-reconciliation.ts`, `inventory-observations.ts` | READ_AUTHORITY inputs / OBSERVATION_ONLY | — | no |
| **`packages/db/src/meal-planning-snapshot.ts:201`** (`loadMealPlanningSnapshot` for `/meal-planning/*`, gated by `MEAL_PLANNER_ENABLED === 'true'`) | **SAFE_DEFERRED** (this review) | yes when the flag is on — reads `inventory_items` quantity/freshness for ranking with **no adoption gate** | read-only; normally coherent (T09 mirror) but not authority and not drift-immune → **D2** |
| `scripts/*.mjs`, `tests/**` | TEST_ONLY | — | — |

UNKNOWN production readers after review: **0**; before review the planner
reader was absent from `t11/READ_CONSUMER_MAP.md` and `t12/FINAL_AUTHORITY_MAP.md`
although both state “UNKNOWN = 0” (`t10/OBSERVATION_SOURCE_MAP.md` had listed it).

## 8. Writer audit (packet §12) — fresh grep of INSERT/UPDATE/DELETE

| Writer | Class |
| --- | --- |
| `executeInventoryLotCommand` / `executeInventoryFefoCommand` / `composeInventoryLotCommands` (`inventory-lot-commands.ts:403–563, 769–853`: receipt, guards, household CAS, lot write, projection mirror `:429/:433`, events) | COMMAND_AUTHORITY |
| `executeInventoryAdoption` (`inventory-adoption-executor.ts:243–286`), `backfillLegacyInventory` (`inventory-truth.ts:114/124`, explicit, refuses adopted households) | COMMAND_AUTHORITY (controlled activation) |
| Route adapters `adoptManualInventoryCreate/Update/Discard`, `confirmAdoptedScan`, `completeAdoptedCooking`, `completeAdoptedShoppingImport` | COMMAND_AUTHORITY adapters |
| `confirmReconciliationDecision` (`inventory-reconciliation.ts:347/355/390`: decision row, observation claim, T09 statements) | RECONCILIATION_ADAPTER |
| `recordInventoryObservation` (`inventory-observations.ts:80`) | OBSERVATION_ONLY |
| Legacy `inventory.ts:645/843/1022`, `recipes.ts:484/503/511`, `scans.ts:1148/1171/1200`, `week.ts:1440/1463/1513`, `SQL.INSERT/UPDATE/DELETE_INVENTORY_ITEM` | LEGACY_COMPATIBILITY — every call site runs inside `runLegacyInventoryBatch` (`week:1579`, `scans:1231`, `recipes:524`, `inventory:644/840/1019`), whose first statement is the `T09_WRITER_FENCE` insert that aborts the batch when the household has mapped lots or an adoption receipt; adopted requests are additionally diverted before reaching them; DB triggers (`trg_inventory_items_projection_owner/replace`) block replacement of mapped rows |
| `scripts/*.mjs`, `scripts/migration-smoke.sh` fixtures | TEST_ONLY |

UNKNOWN production writers: **0**. Adopted stock mutations route through T09 only
(proven by `inventory-writer-fence.test.ts` 15, adoption G12, closed-loop routes
“never legacy batch”). Meal-planning service performs no inventory writes. **PASS.**

## 9. Migration chain (packet §14) and real local D1 replay (§15)

- 30 files `0001…0030`, contiguous, no duplicate number; 0001–0022 byte-identical to
  main; 0023–0030 each introduced once (`cdffb42, 13133b3, b036b25 ×2, 9bd1e6b,
  9bf9ac0, bf391c5, 6c28858`) and never modified.
- sqlite3 3.45.1 fresh `:memory:` sequential apply 0001→0030: `foreign_key_check`
  0, `integrity_check ok`, 69 tables / 173 indexes (incl. sqlite autoindexes) / 56 triggers. `pnpm
  check:migrations` → `migration-smoke=ok`.
- **Real workerd/D1** (wrangler 3.114.17 `d1 migrations apply --local` on a fresh
  isolated database, no remote): 30/30 applied, `d1_migrations` = 30, repo schema
  gate SQL → 0 issues, `pnpm schema:check:local` PASS. Object set (200 non-system
  objects: 69 tables, 75 indexes, 56 triggers) is **identical** between sqlite and
  real D1. Inventory-truth tables/indexes/triggers required by T08–T12 are all
  present (e.g. `idx_inventory_lots_{household_location,ingredient,legacy_source,
  projection}`, `trg_inventory_lots_live_*`, `trg_inventory_events_command_*`,
  `trg_inventory_commands_fefo_*`, `trg_inventory_adoption_receipts_immutable_*`,
  `trg_inventory_observations_*`, `trg_inventory_reconciliation_decisions_*`).

## 10. Legacy upgrade simulation (packet §16)

Permanent test identified and run: `inventory-truth.test.ts` “upgrades a populated
0022 database without changing legacy rows or event history” (PASS inside the
54-test file). Additionally executed on **real local D1**: fresh DB → 0001–0022 →
seed 2 legacy households / 4 `inventory_items` (kg, l, piece, g; versions 1–3;
mixed expiry kinds) / 2 events → apply 0023–0030: rows and events byte-identical
before/after, `inventory_lots`=0, `storage_locations`=0, receipts=0 (no automatic
cutover), `households.inventory_version` initialised (3), legacy UPDATE + event
INSERT still legal afterwards (non-adopted compatibility), `foreign_key_check` = [].
The same scenario on sqlite3 gives identical results. **PASS.**

## 11. Clean RC checkout, install, tests, static gates (packet §17–§23)

`git worktree add --detach /tmp/hoplite/rc-app d156001…` (status empty). Node
**v24.19.0**, pnpm **10.26.0**, `pnpm install --frozen-lockfile` OK in 9 s,
lockfile SHA unchanged before/after.

| Gate | Result |
| --- | --- |
| `pnpm test` (full) | **3,085 passed / 3,085, 119 files, 199.68 s** — no regression vs T12 record |
| T09 focused (10 suites) / all 22 T09-lineage suites | **654/654** / 1,432/1,432 |
| T10 focused (6 suites) | **98/98** |
| T11 focused (2 suites) | **39/39** |
| T12 focused (3 suites) | **22/22** |
| Real local D1 (`inventory-lot-d1` 44, `-observation-d1` 7, `-read-authority-d1` 11, `-closed-loop-d1` 8) | **70/70** |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | PASS / PASS / PASS |
| `pnpm check:migrations` / `pnpm schema:check:local` | `migration-smoke=ok` / PASS |
| `git diff --check` | clean |
| `git status --porcelain` at end (ignored: `dist/`, `node_modules/`, `.wrangler/` only) | **empty** |

## 12. Closed-loop smoke matrix (packet §24) — reconfirmed by executed tests at RC

manual mutation → read (real D1 C, T11 E); observation → DISMISS → read unchanged
(closed-loop DISMISS, real D1 B); observation → accepted reconciliation → read
changed (closed-loop E2E, real D1 A); recipe → USE → reread (closed-loop recipe,
real D1 C); planner → stock change → regenerate (closed-loop planner); shopping →
add stock → reread (routes suite, closed-loop shopping); cook → FEFO → reread
(routes suite, real D1 D); projection drift → authority unaffected (drift matrix,
real D1 E); response loss → idempotent replay (routes suite, real D1 F,
`shopping-command-race`); cross tenant → rejected (routes suite, real D1 G);
adopted empty → `[]` (T11 HTTP + real D1 B, routes suite). All PASS.

## 13. Concurrency (§25) and idempotency (§26)

Retained coverage: READ vs CORRECT/MOVE/USE/DISCARD/FEFO/reconciliation
(`inventory-read-authority.test.ts:245–450` + real D1 E–E4); reconciliation vs
reconciliation (`inventory-reconciliation-fence.test.ts` 13 races incl. same-key
twin replay and altered-key conflict; observation-concurrency F1–F5);
reconciliation vs manual CORRECT (closed-loop race + real D1 H → loser is
`LotCommandError STALE_SNAPSHOT`, nothing committed); USE/USE, USE/DISCARD,
MOVE/MOVE, FEFO/FEFO, cross-household (`inventory-concurrency` G1–G12, all
`STALE_SNAPSHOT` losers); scan lease/response-loss races
(`scan-response-loss`, `scan-quota-idempotency`); shopping retries
(`shopping-command-race`); cook response-loss retry (routes suite). The remaining
`PERSISTENCE_FAILED` expectations are all **injected-failure** cases (controlled
triggers / RAISE(IGNORE) / captured batches), never CAS losers. Idempotency: exact
retry → replay; altered payload same key → `IDEMPOTENCY_CONFLICT`; stale distinct
command → `STALE_SNAPSHOT`/`STALE_VERSION`; no duplicate stock (real D1 F, routes
suite, adoption replay). **PASS.**

## 14. Tenancy (§27), fail-closed (§28), cache (§29)

Household B cannot read A lots (`LOT_NOT_FOUND`), resolve A legacy mapping,
reconcile A observations (`OBSERVATION_NOT_FOUND`), CORRECT/MOVE/DISCARD A lots,
consume A stock via cook, or import against A (`404 NOT_FOUND`); error shapes are
uniform not-found/tenancy-safe codes, with A's state proven untouched afterwards
(real D1 G, routes suite, T11 F, concurrency G8/G9, adoption). Scan command IDs are
tenant-scoped (`scan-quota-idempotency`). Cross-tenant mutation: none found.
Existence leak: the pre-existing POST id preflight answers `409 CONFLICT` when a
client-supplied id belongs to another household — identical on main, reveals no
stock, judged **P3/informational** (not a train regression).
Fail-closed: corrupt mapping / forged or missing receipt → `MAPPING_CORRUPT` /
`CORRUPT_RECEIPT` / `ADOPTION_REQUIRED`; ACTIVE zero quantity → `CORRUPT_LOT_ROW`;
invalid expiry → `CORRUPT_LOT_ROW` (never “fresh”); drift → `DRIFT_DETECTED` for
writers, read stays authority + parity diagnostic; stale snapshot →
`STALE_SNAPSHOT`; the funnel converts any authority error into
`InventoryReadError` (503) and never reads the projection or KV (`inventory.ts:494–503`).
Cache: adopted branch performs no `inv_*` get/put (routes suite asserts 0 `inv_`
writes with a stale KV injected); legacy branch keeps its 1h cache and only
falls back to KV for **non-strict** reads. **PASS.**

## 15. API compatibility (§30) and dependency/config audit (§31)

Legacy row (`mapInventoryRow`): `id, householdId, ingredientId, normalizationStatus,
name, quantity, unit, category, storage, expiryDate, addedDate, freshness,
dataSource, version, updatedAt`. Adopted row (`inventoryReadItemToApi`) keeps all
of them with the same meaning — `id` = the id the T09 authority writes into
`inventory_items` (legacy item id for backfilled lots, lot id for native lots),
`version` = legacy CAS (`legacyVersion ?? lot version`), `quantity/unit` = exact
canonical or agreement-gated kg/l alias, `expiryDate` = `expiryAt ??
estimatedExpiryAt`, `freshness` recomputed from authority — and adds `lotId,
legacyItemId, lotVersion, quantityMilli, canonicalUnit, expiryKind,
estimatedExpiryDate, state, inventoryVersion`. Recipes, planner, scans and
notifications all consume the same funnel rows (engines read `id`/`ingredientId`/
`quantity`/`unit`), so no incompatible shapes were introduced. Intentional
differences: adopted rows never carry projection-only corruption; `dataSource`
maps `SCAN|RECEIPT→scan`, `SHOPPING→shopping`, else `manual`.
Dependencies/config: no change (see manifest). Cloudflare bindings and vars are
identical to main; `MEAL_PLANNER_ENABLED` remains unbound in `wrangler.jsonc`.

## 16. `.hoplite/settings.json` (packet §3)

Workspace overlay preserved untouched. Note: the overlay present in this
workspace hashes to `a8c1f180…` (it contains one extra `"services": []` line
compared with the `6d8f5b45…` bytes that the PR tooling committed in
`99e4b7b/a3abd6d/c7e2296`); this is platform-generated state and was not edited,
staged, committed, restored or reset. Repository blob on main: `48507643…`.

## 17. Defects and remediation plan

| # | Severity | Finding | Reproduction | Affected SHA / path | Required remediation |
| --- | --- | --- | --- | --- | --- |
| **D3** | **P1** (user-facing regression, release blocker) | Every web guest who registers by email is stopped at OTP verification. `AuthPage.tsx:248–252` sends `migrateFromHouseholdId` whenever the session is a guest (`hh_guest_*` — the id `POST /auth/guest` always issues); the RC's `verify-otp` answers `409 INVENTORY_TRANSFER_DEFERRED`, the client surfaces the raw JSON as an error, and offers no “continue without transfer” action. On main the same request succeeds (best-effort migration). Guest sessions are the default entry (“Bắt đầu trải nghiệm (Khách)”, onboarding “Đăng ký bằng Email” CTA), so the affected population is every guest converting to an account. Data is safe (OTP unused, account pending, guest stock intact); the account can only be finished by an out-of-UI retry without the field or by logging the guest out first. The server behaviour is exactly DEC-012 and is correct for Inventory Truth; the gap is the untouched client. | Reproduced twice at RC: (a) curl against the isolated preview: guest → add item → register → verify-otp with `migrateFromHouseholdId` → **HTTP 409**; identical OTP without the field → 200; (b) browser: Landing → Khách → `/auth?mode=register` → OTP → “Xác thực & Hoàn tất” → on-screen `HTTP 409: {"error":"Chưa hỗ trợ chuyển dữ liệu…","code":"INVENTORY_TRANSFER_DEFERRED"}` (screenshot in the thread). | `d156001`: `src/worker/routes/auth.ts:425–431` (`INVENTORY_TRANSFER_DEFERRED` at `:429`; DEC-012, from `66858c5`) vs unchanged `src/web/pages/AuthPage.tsx`, `src/web/services/auth.ts` | Targeted successor on the T12 branch (client only, no server/auth-policy change): (1) on `INVENTORY_TRANSFER_DEFERRED`, `AuthPage` must show the deferral in plain language and offer an explicit “Tiếp tục không chuyển dữ liệu khách” action that re-submits the same OTP **without** `migrateFromHouseholdId` (server keeps the OTP unused, so this succeeds — proven above); (2) keep the guest outbox/scope untouched until success (existing `sync.test.ts` case); (3) add a unit/integration test for the UI path; (4) record the decision in `DECISIONS.md` (DEC-012 addendum: client contract) and `HANDOFF.md`. Alternative product decision (stop sending the field for guests and inform the user their guest data stays in the guest household) is acceptable if the owner prefers it; either way the user must not dead-end. |
| D1 | P2 (release hygiene) | `.hoplite/settings.json` is tracked on main (blob `3818a00`: setup installs sqlite3 + `pnpm install --frozen-lockfile`; run `node scripts/security-preview.mjs`) but **deleted** from the RC tree by T11 `4553b8a` (“keep the external workspace overlay out of the branch” removed the repo file instead of restoring the main blob as `09f13c4`/`ab1e983` did). Merging would delete the repository's documented sandbox setup/run scripts from main (the setup step installs sqlite3, which `pnpm check:migrations` requires). | `git diff --name-status d1b0673 d156001 -- .hoplite/settings.json` → `D`; `git cat-file -e 847b036:.hoplite/settings.json` → absent | `4553b8a` … `d156001`, path `.hoplite/settings.json` | Successor commit on the T12 branch: `git checkout d1b0673 -- .hoplite/settings.json` and commit **that blob** (`48507643…`). Must not commit the workspace overlay (`a8c1f180…`/`6d8f5b45…`); if the platform re-overlays the file locally, commit from a clean detached worktree. |
| D2 | P2 (documentation/scope) | `packages/db/src/meal-planning-snapshot.ts:201` reads `inventory_items` for the flag-gated `/meal-planning/*` planner with no adoption gate and is missing from `t11/READ_CONSUMER_MAP.md` and `t12/FINAL_AUTHORITY_MAP.md`, which claim UNKNOWN = 0. Read-only, pre-existing on main, untouched by the train, unreachable in the deploy config (`MEAL_PLANNER_ENABLED` not bound), and the T09 mirror keeps the projection coherent for adopted households — but it is not authority and not drift-immune. | grep at RC; `wrangler.jsonc` vars | `d156001`: `packages/db/src/meal-planning-snapshot.ts`, `docs/ai/inventory-truth/t11/READ_CONSUMER_MAP.md`, `t12/FINAL_AUTHORITY_MAP.md` | Docs successor: classify as `SAFE_DEFERRED` in both maps with removal condition “route `loadMealPlanningSnapshot` inventory through the T11 read authority (or `fetchHouseholdInventoryFromDb`) before enabling `MEAL_PLANNER_ENABLED` for adopted households”. No code change required for certification; a follow-up task should do the cutover before the flag is enabled. |

P0: **none**. P3/informational: POST id-preflight existence answer (pre-existing on
main); bounded non-adopted legacy compatibility paths by design (removal
conditions in `t12/FINAL_AUTHORITY_MAP.md`).

## 18. Merge safety statement

The inventory architecture, migrations and tests of `d156001` are certified clean,
reproducible from a fresh checkout and fast-forwardable onto `d1b0673`. The
candidate must **not** be merged until D3 (guest registration dead-end) and D1
(tracked platform file) are remediated on the train and D2 is documented; then
re-run §11 (clean checkout gates) and the D3 browser reproduction on the new SHA to
close the review. **No merge, deploy, remote D1 or PayOS action was performed.**
