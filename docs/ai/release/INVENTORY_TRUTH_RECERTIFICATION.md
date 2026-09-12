# Inventory Truth release train — independent final re-certification (2026-09-12)

Application RC: **`64c5501ab0110658718b3752bd84e537f0854e12`** · Docs HEAD reviewed: **`bc1532ea406525dc7fa9e59c58d320fd525774d8`**
Review branch: `hoplite/akraiphia-akraiphnion-a03445c7--inventory-truth-final-recertification`
(base = exact `bc1532e`; suggested logical name `hoplite/inventory-truth-final-recertification`).
Reviewer: Hoplite, independent of the T08–T12 and remediation implementation runs.
Mode: audit only — no application code changed, nothing merged, deployed or run against remote D1.

## Verdict

**RELEASE CANDIDATE `64c5501` — TECHNICALLY CERTIFIED.** No P0/P1/P2 defects. The
candidate is internally coherent, regression-free against every retained gate,
migration-safe on sqlite and real workerd/D1, and the D3/D1/D2 remediation is
exactly as narrow as documented. It is ready to proceed to the **separate ROADMAP
RECONCILIATION / GAP AUDIT**. **Main was NOT merged and must not be merged on the
strength of this certification alone** (historical roadmap mismatch still to be
audited). Two P3/informational notes are recorded in §17.

## 1. Identity and state gate (§0, §5)

- GitHub `/repositories/1364064929` → `vn-2f/frigo-dev`, default branch `main`;
  `/repos/vb-2f/frigo-dev` → `301` to the same ID. **PASS.**
- Task workspace before any action: remote `https://github.com/vn-2f/frigo-dev.git`
  (fetch/push); `git status --porcelain` = ` M .hoplite/settings.json` (platform
  overlay, SHA-256 `a8c1f180…`, never staged); `git branch -vv` = thread branch
  `hoplite/akraiphia-akraiphnion-a03445c7` @ `c71692a` (+ remediation branch @ `bc1532e`
  in `/tmp/hoplite/remed`); `git rev-parse HEAD` = `c71692a5…`.
- `origin/main` = **`d1b06732f8a80db4e77986df31ff28d9f04641fa`** — unchanged; RC is
  57 ahead / 0 behind, docs HEAD 59 ahead / 0 behind. No main-side commits to audit.
- Expected published branch `hoplite/akraiphia-akraiphnion-a03445c7--inventory-truth-final-remediation`
  resolves to `bc1532e` on the remote; `hoplite/akraiphia-akraiphnion-a03445c7` = `32b6ec1`. **PASS.**

## 2. Lineage (§6)

All 16 checkpoints are ancestors of `bc1532e` (Git ancestry, not dates), and the
ordered chain holds 14/14:
`d1b0673 → dd2ecc6 (T08 app) → 8f8788c (T08 docs) → bf391c5 → d522769 → 7393edc →
c71692a → c15c9a8 → 847b036 → d156001 → 5cb4caa → 32b6ec1 → 64c5501 → bacfa1c → bc1532e`
(`fb00f46` T08 verified checkpoint also an ancestor). Merge commits in the train:
`668920f` (PR #1, T09), `30ce4ea` (T10), `14c02f8` (T11) — none after T12; every
post-T12 commit has a single parent. Tree hashes of the certified freezes are
unchanged (`d156001` tree `2bf3bea…`, `c15c9a8` `ad53645…`, `7393edc` `2eeaaeb…`,
`bf391c5` `cdd9bfc…`) — no history rewrite. Missing application ancestors: **none**.

```
d1b0673  main baseline (origin/main today)
   │
   ├─ T08  43718c2 … dd2ecc6 (app) … fb00f46 … 8f8788c (docs)
   ├─ T09  e56f163 … bf391c5 (app freeze) ─ d522769 (docs) ─ 99e4b7b* ─ 09f13c4*
   ├─ M 668920f  Merge PR #1 (T09)
   ├─ T10  6c28858 … 7393edc (app freeze) ─ c71692a (docs)
   ├─ M 30ce4ea  Merge T10
   ├─ T11  657201f ─ c7e2296* ─ 4553b8a† … c15c9a8 (app freeze) ─ 847b036 (docs)
   ├─ M 14c02f8  Merge T11
   ├─ T12  22f675d ─ 24668c2 ─ d156001 (APP FREEZE) ─ 5cb4caa (DOCS)
   ├─ 32b6ec1  independent integration review (docs)          NOT READY: D3 P1, D1 P2, D2 P2
   ├─ 64c5501  D3/D1/D2 remediation  ◄── APPLICATION RELEASE CANDIDATE
   ├─ bacfa1c  remediation docs
   ├─ bc1532e  remediation docs (branch name)  ◄── docs HEAD reviewed here
   └─ (this commit)  final re-certification docs
```
`*` PR-tooling overlay auto-commit + corrective restore · `†` deletion of the tracked
settings file (defect D1, closed at `64c5501`).

## 3. Remediation commit scope (§7)

`git diff --name-status 32b6ec1 64c5501` = exactly: `A .hoplite/settings.json`,
`M src/web/pages/AuthPage.tsx` (+56/−7), `M src/web/services/auth.ts` (+8),
`M src/web/services/http.ts` (+12), `M tests/integration/inventory-guest-transfer.test.ts`
(+56), `A tests/unit/auth-guest-transfer-deferred.test.tsx` (270). The same six files
are the entire non-docs delta `d156001 → 64c5501`. `packages/db`, `packages/domain`,
`src/worker` (incl. `routes/auth.ts`), `migrations/`, `wrangler*.jsonc`, `package.json`,
`pnpm-lock.yaml`, `tsconfig*`, `vite.config.ts`, `eslint.config.js`, `scripts/`,
`public/`: **no change**. PayOS/billing/webhook paths: untouched (also main→RC).
Commits after `64c5501` (`bacfa1c`, `bc1532e`) touch `docs/` only. **PASS.**

## 4. D3 independent code review (§8–§10)

Server (`src/worker/routes/auth.ts`, unchanged since `d156001`): `verify-otp` loads the
latest OTP → lockout check → digest verification (failure → `markOtpFailure`) →
expiry check → **DEC-012 refusal `409 INVENTORY_TRANSFER_DEFERRED` when
`purpose==='register' && migrateFromHouseholdId`** → only then `consumeOtp`, account
activation, session cookie. The refusal path performs no write, so the OTP stays
usable and the account stays pending.

Client (`64c5501`):
- `http.ts`: `ApiError.code` getter parses the existing `HTTP <status>: <body>` envelope
  (`/^HTTP \d{3}: ([\s\S]*)$/`), `JSON.parse` in try/catch, returns `body.code` only when
  it is a string, else `null`. `fetchJson` builds that envelope for every non-2xx
  (401/403 → kind `auth`, others → kind `http`).
- `auth.ts`: `isInventoryTransferDeferred(err) = err instanceof ApiError && err.status === 409
  && err.code === 'INVENTORY_TRANSFER_DEFERRED'` — both conditions required; wrong/expired
  OTP (400), other 409 codes, 401, network (`kind offline`, no status), malformed or
  non-JSON bodies and plain `Error`s all return `false`. `verifyOtp` unchanged: the
  `rebindPendingOps` branch requires `result.migratedFromHouseholdId === migrateFromHouseholdId`
  on a **successful** response — unreachable on the deferral (throws) and on the retry
  (no field sent, server never returns `migratedFromHouseholdId`).
- `AuthPage.tsx`: `submitOtpVerification(transferGuestData)`. First submit
  (`handleVerifyOtp`) sends `migrateFromHouseholdId` only for `register` + guest +
  `hh_guest_*`. Catch: `transferGuestData && isInventoryTransferDeferred(err)` →
  `setTransferDeferred(true)` (guarded by `isCurrent()`), **no `setErrorMessage`, no
  storage or store change**; anything else → existing generic error path. Render: when
  `transferDeferred && otpPurpose === 'register'` the submit button is replaced by a
  `role="status"` notice (cannot transfer safely yet · kept in the guest household · not
  deleted · not transferred · account can still be created) and the button
  **“Tiếp tục không chuyển dữ liệu khách”** → `submitOtpVerification(false)` → same
  email/OTP/`purpose=register`, field omitted. `setAuthSession` runs only inside
  `res.success` of a 2xx. The flag resets on back, resend, and (re)entering OTP mode.
  Pressing Enter while deferred re-submits with the field → another harmless 409.
- Runtime flow reconstructed: guest → register → OTP → 409 (OTP unused, account
  pending, guest identity/caches/outbox untouched, `rebindPendingOps` not executed,
  no half-authenticated state) → explicit action → 200 → account session. A failed
  retry only sets the generic error message; guest state remains.
- Maintainability (classified separately from correctness): the structured code is
  derived from the message envelope rather than a dedicated `body` field. This mirrors
  the pre-existing `plannerErrorMessage` pattern and is correct; a first-class parsed
  body on `ApiError` would be cleaner. **Not a release finding.**

## 5. D3 permanent tests (§11) — read, not counted

| Req | Where | Assertion actually present |
| --- | --- | --- |
| A non-guest registration | UI suite A | single verify body `{email, code, purpose}`; `frigo_is_guest=false`; `/onboarding` |
| B first guest request sends field | UI B+D | body `{…, migrateFromHouseholdId: hh_guest_…}` |
| C 409 → special UI state | UI B+D | `[data-testid=transfer-deferred]` rendered; submit button gone; no `HTTP 409`, no code text, no “Mã OTP không đúng”; OTP digits retained |
| D guest state/outbox unchanged | UI B+D | `guestState()` (ids, `frigo_is_guest`, store, inventory cache, pending ops) deep-equal before/after |
| E explicit continue retries same OTP w/o field | UI C+F | 2nd body `{email, code, purpose}`; `not.toHaveProperty('migrateFromHouseholdId')` |
| F success → account session | UI C+F | storage/store switch only after 200; no outbox rebound to new household; `/onboarding` |
| G failed retry keeps guest | UI E | 400 on retry → `guestState()` unchanged, `isGuest` true, no `/onboarding` |
| H unrelated errors stay generic | UI “keeps unrelated OTP failures…” + classification unit test (400/401/other-409/offline/plain Error/non-JSON) | no deferral state |
| I server: first 409 does not consume OTP | route test “D3 client contract” (real `authRoutes` + `authMiddleware`, SqliteD1) | `auth_otps` row identical (`used 0`, `attempt_count 0`), `is_verified 0`, no session, no `Set-Cookie` |
| J same OTP then succeeds w/o field | route test | 200, cookie, `used 1`, `is_verified 1`, one session; replay with/without field → 400 |
| K guest stock stays in guest household | route test | `source-item.household_id === hh_guest_source`; inventory tables snapshot unchanged |
| L new account has no migrated stock | route test | `COUNT(*) FROM inventory_items WHERE household_id = hh_<new>` = 0; response has no `migratedFromHouseholdId` |

Contracts I–L exist at the real route boundary, not only in mocks; A–H run the real
`AuthPage`, auth store, api layer and outbox with only `fetch` stubbed. **PASS.**

## 6. Negative control (§12) — reproduced

Fresh detached worktree at `64c5501` with the three client files reverted to their
`d156001` versions (server and new tests unchanged): UI suite **4 failed / 2 passed**
(B+D, C+F, E, and the classification unit test — the latter needs the new helper).
With only `AuthPage.tsx` reverted (new services kept): **3 failed / 3 passed** (B+D,
C+F, E) — matching the remediation report. The tests detect the original defect.
Worktree removed afterwards; no history touched.

## 7. Browser reproduction (§13) — executed at exact `64c5501`

`scripts/security-preview.mjs` from the clean RC worktree (isolated in-memory SQLite,
external network disabled, `ENVIRONMENT=development` so the dev OTP is shown).
Landing → “Bắt đầu trải nghiệm (Khách)” → guest `hh_guest_17892097205060qtw7oxv`
(`frigo_is_guest=true`) → guest adds 1 inventory item through the real route
(`POST /api/v1/inventory` 201; `GET` → 1 item) → `/auth?mode=register` → register
(200, dev OTP `795292`) → “Xác thực & Hoàn tất” → server `POST /auth/verify-otp` **409**
→ page state: deferral notice present, action “Tiếp tục không chuyển dữ liệu khách”
present, submit button absent, **no `HTTP 409`, no `INVENTORY_TRANSFER_DEFERRED`, no
“OTP wrong” text**, OTP digits retained, `localStorage` still guest, `/me` still the
guest, guest inventory still readable (1 item) → click the action → server
`POST /auth/verify-otp` **200** → `/onboarding`, `frigo_is_guest=false`,
`frigo_user_id=usr_1789209782552_dlq2b`, `/me` = registered user with its own household,
`GET /api/v1/inventory` for the new account = **0 items**, no “đã được chuyển” text;
browser errors: none. Screenshot of the deferral state published in the thread.

## 8. D1 (§14)

At `64c5501`: `git ls-files -s .hoplite/settings.json` → `100644 3818a002fc12f70fa7a9a26078a125ac3d77998b`;
raw SHA-256 `48507643905fe9070291cb858f037049a7f28b513974ee03264ac959f20b7935`;
`git diff origin/main 64c5501 -- .hoplite/settings.json` → **empty** (byte-identical;
`cmp` confirms); `git diff --name-status origin/main 64c5501 -- .hoplite` → empty (not
deleted/altered). Content has no `inference/ports/services` keys (not the overlay
`6d8f5b45…`/`a8c1f180…`). Workspace overlay untouched. **PASS.**

## 9. D2 (§15)

`packages/db/src/meal-planning-snapshot.ts:198–202` (`loadMealPlanningSnapshot`) selects
`id, household_id, version, ingredient_id, quantity, unit, freshness, expiry_date,
expiry_kind, storage, opened_at, expiry_source, added_date, updated_at FROM inventory_items`
in the same batch as catalog/ranking/nutrition reads. Production callers: only
`src/worker/services/meal-planning.ts` (5 call sites), used exclusively by
`src/worker/routes/meal-planning.ts`, whose middleware returns `404 MEAL_PLANNER_DISABLED`
unless `MEAL_PLANNER_ENABLED === 'true'`. No `readInventoryAuthorityMode` / authority gate
anywhere on that path → adopted households **would** read the projection if the flag
were enabled. `wrangler.jsonc` and `wrangler.staging.jsonc.example` do not bind
`MEAL_PLANNER_ENABLED` (only the isolated preview script and tests set it). The service
performs no inventory writes. Docs at `bc1532e`: `t11/READ_CONSUMER_MAP.md` and
`t12/FINAL_AUTHORITY_MAP.md` classify it **`SAFE_DEFERRED`**, name the exact path, state
projection/not-authority/not-drift-immune, flag-off reachability, and the removal
condition **`MEAL_PLANNER_AUTHORITY_CUTOVER`** with the rule that the flag must not be
enabled for adopted households before the cutover; the item is also tracked in
`TASK_BOARD.md`, `HANDOFF.md`, `t12/CONTINUATION.md`. Not cut over here. **PASS.**

## 10. Fresh reader / writer audits (§16–§18)

Fresh `rg` over `src/` + `packages/` (non-test) for `FROM/JOIN inventory_items|inventory_lots`
and the helper abstractions (`SQL.GET_INVENTORY*`, `readInventoryAuthority`,
`readAdoptedLotSnapshot`, `readMappedLotSnapshot`, `fetchHouseholdInventoryFromDb`,
`getHouseholdInventory`, `loadMealPlanningSnapshot`), plus the queue consumer
(`processScanJob`) and cron (`runScheduledCleanup`: deletes expired `auth_otps` /
`sessions_v2` only). The raw-SQL reader and writer sets are **byte-identical to the
certified `d156001` sets** (diff of grep output empty). Classification unchanged from
the integration review: READ_AUTHORITY (funnel native branch, `readInventoryAuthority`
consumers, adapters' `readAdoptedLotSnapshot`), LEGACY_COMPATIBILITY (funnel legacy
branch + 1h KV; `notifications.ts:26`, `recipes.ts:398`, `scans.ts:993`, `week.ts:1405`
behind native diversions; `inventory.ts:604/138/376/675/748/969` preflights/response
rows), OBSERVATION_ONLY (`inventory_events` audit reads), **SAFE_DEFERRED**
(`meal-planning-snapshot.ts:201`), TEST_ONLY (`scripts/*.mjs`, tests). `src/web` contains
no SQL and no authority logic. **UNKNOWN production readers = 0.**
Writers: COMMAND_AUTHORITY (`inventory-lot-commands.ts` receipts/guards/CAS/lot/mirror/
events, `inventory-adoption-executor.ts`, `inventory-truth.ts` backfill),
RECONCILIATION_ADAPTER (`inventory-reconciliation.ts:347/355/390`), OBSERVATION_ONLY
(`inventory-observations.ts:80`), LEGACY_COMPATIBILITY (`inventory.ts:645/659/843/864/
1022/1030`, `recipes.ts:484/503/511`, `scans.ts:1148/1171/1200`, `week.ts:1440/1463/1513`,
`queries.ts` constants — all inside `runLegacyInventoryBatch` with the `T09_WRITER_FENCE`
+ native diversions). **UNKNOWN production writers = 0**; no adopted stock mutation
outside T09; no cross-tenant mutation path. Second ledger: tables added by 0023–0030
are `storage_locations`, `inventory_lots`, `inventory_commands`,
`inventory_adoption_receipts`, `inventory_observations`, `inventory_reconciliation_decisions`;
no views; no `current_inventory|*_state|reconciled_|scan_|planner_|cached_inventory|
stock_ledger|*_v2` inventory structures (only Week's `meal_plan_slots_v2`); KV holds
`inv_*` (legacy branch, 1h) and `plan_*` only. **No second authoritative stock ledger.**

## 11. Task survival (§19) — by tree comparison at the RC

T09 core (`inventory-lot-commands.ts`, adoption executor, writer fence, domain
contracts, 0024–0029) vs T09 freeze `bf391c5`: only the 3 `export` keywords T11 added.
T10 files vs `7393edc`: identical. T11 files vs `c15c9a8`: only T12's alias
agreement-gating (+16/−2 in `inventory-read-authority.ts`). T12 runtime (`src/worker`,
`packages`, closed-loop suites, helpers) vs `d156001`: **identical**. T08 foundation
vs `dd2ecc6`: only T09's 5-line refuse-re-backfill guard. Executed at the RC:
T08 foundation/schema suites 430/430; T09 654/654; T10 98/98; T11 39/39; T12 22/22
(manual mutation/read, observation→reconciliation→read, recipes/USE, planner,
shopping, cook/FEFO, notifications, drift, response-loss replay, tenancy, adopted-empty).
**PASS.**

## 12. Migrations (§20–§22)

30 files, contiguous `0001…0030`; 0001–0022 identical to main; 0023–0030 blob-identical
to `d156001` (`1ec671af… 779cf2bd… e9204fff… b1cfb349… 2d879eb8… 2f8b437f… 27a78201… 6e323d89…`);
no 0031. `pnpm check:migrations` → `migration-smoke=ok`; `pnpm schema:check:local` PASS.
**Fresh real workerd/D1** (wrangler 3.114.17, isolated DB, no remote): 30/30 applied,
`d1_migrations`=30, `foreign_key_check`=[], 200 non-system objects (69 tables / 75 indexes /
56 triggers) **identical to the set captured at `d156001`**; 6 inventory-truth tables,
41 `trg_inventory_*`/`trg_storage_locations_*` triggers, 4 `idx_inventory_lots_*` indexes
present; repo schema-gate SQL → 0 issues.
**Legacy upgrade replay on real local D1**: fresh DB → 0001–0022 → 2 households,
4 legacy `inventory_items` (kg / l / piece / g, versions 1–3, mixed expiry kinds),
2 events → 0023–0030 applied: rows and events byte-identical before/after, lots=0,
locations=0, receipts=0 (no automatic cutover), `households.inventory_version` initialised,
non-adopted UPDATE + event INSERT still legal, `foreign_key_check`=[]. Adopted/backfilled
coherence, mapping validity and tenant boundaries are covered by the permanent suites
executed above (`inventory-truth` “upgrades a populated 0022 database…”, kg/l exact
backfill, isolation/cross-household rejection; `inventory-adoption` backfilled
activation/replay/cross-tenant; real-D1 T11 case C synthetic mapping). **PASS.**

## 13. Clean application checkout gates (§23–§30) — `/tmp/hoplite/rc2` @ exact `64c5501`

`git status --porcelain` empty before start. Node **v24.19.0**, pnpm **10.26.0**,
`pnpm install --frozen-lockfile` OK (3 s, store warm); lockfile SHA-256
`e3be8dd0c31cfb40f6bd6c8c08906a47a17a6347d02108f5a44b0bd3c96ddea3` before = after.

| Gate | Result |
| --- | --- |
| `pnpm test` | **3,092 passed / 3,092 · 120 files · 196.29 s** (floor 3,092/120 met; +7 vs `d156001` = 6 UI + 1 route test) |
| D3 focused (`auth-guest-transfer-deferred.test.tsx` 6, `inventory-guest-transfer.test.ts` 26) | **32/32** |
| D3/auth regression selection (`auth-hardening` 72, `browser-security` 12, `auth-me-quota` 17, `sync` 20, `auth` 19, `logout-dialog` 1, `logout-ux` 2) | 143/143 |
| T09 (10 suites) / T10 (6) / T11 (2) / T12 (3) | **654 / 98 / 39 / 22** |
| T08 foundation + schema suites (5) | 430/430 |
| Real local D1 (`lot-d1` 44, `observation-d1` 7, `read-authority-d1` 11, `closed-loop-d1` 8) | **70/70** |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | PASS / PASS / PASS |
| `pnpm check:migrations` | `migration-smoke=ok` |
| local D1 apply + `pnpm schema:check:local` | PASS |
| `git diff --check` | clean |
| `git status --porcelain` at end | **empty** (ignored only `.wrangler/`, `dist/`, `node_modules/`) |

No `it.skip/only/todo` anywhere under `tests/`.

## 14. Concurrency / idempotency / tenancy / fail-closed / cache retention (§31)

Retained and executed at the RC: READ vs CORRECT/MOVE/USE/DISCARD/FEFO/reconciliation
(T11 integration 6 + real D1 4); reconciliation vs reconciliation (fence suite, 10 `it`
blocks incl. parameterised races; concurrency F1–F5); reconciliation vs manual CORRECT
→ `STALE_SNAPSHOT` (closed-loop + real D1 H); USE/USE, USE/DISCARD, MOVE/MOVE, FEFO/FEFO,
cross-household (G1–G12, `STALE_SNAPSHOT` losers); scan lease/response-loss and shopping
retries; cook response-loss replay (routes suite); `IDEMPOTENCY_CONFLICT` asserted in 20
test files; cross-tenant read/mutate/reconcile/import/cook rejections (real D1 G, routes
suite, T11 F). Adopted reads never serve or refresh `inv_*` KV (routes suite with stale KV
injected). Nothing in the remediation touches these paths (`src/worker`/`packages`
identical to `d156001`).

## 15. Documentation coherence at `bc1532e`

`INVENTORY_TRUTH_REMEDIATION.md`, `CURRENT_STATE.md`, `TASK_BOARD.md`, `HANDOFF.md`,
`DECISIONS.md` (DEC-015) and the two authority maps agree with the measurements above
(freeze SHA, 3,092/120, 70/70, focused counts, blob/raw hashes, negative control 3/6,
SAFE_DEFERRED classification, cutover follow-up, published branch name). The earlier
`INVENTORY_TRUTH_RELEASE_CERTIFICATION.md` correctly labels its NOT-READY verdict as
historical for `d156001`.

## 16. Prohibitions honoured

No merge into main; no rebase/squash/cherry-pick/force-push/reset/clean; no deploy;
no remote D1; PayOS untouched; `MEAL_PLANNER_ENABLED` not enabled; no migration change;
no dependency change; no application code change by this review; workspace overlay
untouched. The negative-control worktree was temporary and removed.

## 17. Findings

| # | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| N1 | P3 / informational | For non-deferral failures `AuthPage` still surfaces the raw `err.message` (`HTTP 4xx: {…}`) — pre-existing on main for every auth error path, unchanged by D3 (which only intercepts the DEC-012 code). | Not a release finding; candidate for a UX follow-up. |
| N2 | maintainability | `ApiError.code` derives structured data from the message envelope (consistent with `plannerErrorMessage`). Correct and defensively parsed. | Not a release finding. |

P0: none · P1: none · P2: none.

## 18. Next step

Proceed to the **ROADMAP RECONCILIATION / GAP AUDIT** for `64c5501`. Main integration
remains a separate, explicitly authorised step after that audit; `MEAL_PLANNER_AUTHORITY_CUTOVER`
must land before `MEAL_PLANNER_ENABLED` is enabled for adopted households.
