# Inventory Truth release train — final RC targeted remediation (D3 P1 + D1 P2 + D2 P2)

Date: 2026-09-12 · Branch: `hoplite/akraiphia-akraiphnion-a03445c7--inventory-truth-final-remediation` (requested name `hoplite/inventory-truth-final-remediation`; the platform publishes only under this thread's branch namespace)
Base: `32b6ec103c6c38b1903b8af12118018a61f5088d` (independent review record; docs-only
descendant of T12 docs HEAD `5cb4caa`, itself the direct child of T12 app freeze `d156001`).
Ancestry gates before any edit: `d156001 → HEAD` PASS, `5cb4caa → HEAD` PASS,
`d1b0673 → HEAD` PASS. No rebase/squash/cherry-pick/force-push/reset/clean.

**NEW_APPLICATION_FREEZE = `64c5501ab0110658718b3752bd84e537f0854e12`**
(`fix(release): close guest registration and restore release hygiene`).
Docs-only commit(s) follow it; the application tree is certified at `64c5501`.

## 0. Identity, main, baseline

- GitHub `/repositories/1364064929` → `vn-2f/frigo-dev` (`vb-2f/frigo-dev` → 301). PASS.
- `origin/main` = `d1b06732f8a80db4e77986df31ff28d9f04641fa` (unchanged; the freeze is
  57 ahead / 0 behind). Task-workspace baseline records: remote
  `https://github.com/vn-2f/frigo-dev.git`; `git status --porcelain` = ` M
  .hoplite/settings.json` (platform overlay, never staged); branch
  `hoplite/akraiphia-akraiphnion-a03445c7` @ `c71692a`; work done in a fresh worktree
  `/tmp/hoplite/remed` created from `32b6ec1` with an empty status.
- Baseline before edits (same tree as RC `d156001` for application files):
  auth/guest/outbox suites 153/153; the previous certification (3,085/119, real D1
  70/70, T09 654, T10 98, T11 39, T12 22) applies unchanged because `32b6ec1` is
  docs-only on top of `d156001`.

## 1. D3 — guest → email registration dead-end (P1) — CLOSED

Server unchanged (DEC-012 intact; `src/worker/routes/auth.ts` untouched). Verified
from server code before the client change: `verify-otp` validates the digest first,
then returns `409 INVENTORY_TRANSFER_DEFERRED` **before** `consumeOtp`, account
activation, session creation or any transfer side effect; `markOtpFailure` is not
called on that path, so the same code remains valid.

Client change (3 files, +75/−7):

| File | Change |
| --- | --- |
| `src/web/services/http.ts` | `ApiError.code` getter: structured `code` from the existing `HTTP <status>: {json}` envelope (no new error shape) |
| `src/web/services/auth.ts` | `INVENTORY_TRANSFER_DEFERRED` + `isInventoryTransferDeferred(err)` (`ApiError` ∧ status 409 ∧ code match; anything else is not a deferral) |
| `src/web/pages/AuthPage.tsx` | `submitOtpVerification(transferGuestData)`; first submit keeps sending `migrateFromHouseholdId` for `hh_guest_*` sessions; on deferral → `transferDeferred` state renders a plain-language notice (data cannot be transferred safely yet · stays in the guest household, not deleted · account can still be created) and the button **“Tiếp tục không chuyển dữ liệu khách”**, which re-submits the same email/OTP/`purpose=register` **without** the field; the state resets on back/resend/re-entering OTP mode |

Session/outbox safety (packet §9): between the 409 and the explicit retry nothing
is cleared, rebound or switched — `setAuthSession` runs only on a 2xx; the guest
outbox is never rebound (`rebindPendingOps` requires `migratedFromHouseholdId`,
which the server never returns on this path); a failed retry leaves the guest
session intact. No inventory/authority logic was added to the client.

Tests (packet §11):

| Req | Test | Result |
| --- | --- | --- |
| A non-guest registration | `auth-guest-transfer-deferred.test.tsx` A — single verify without the field, session established, `/onboarding` | PASS |
| B first guest attempt → deferral state | B+D — body contains `migrateFromHouseholdId`; notice + action rendered; no `HTTP 409`/code text; not shown as wrong OTP; OTP digits retained | PASS |
| C continue without transfer | C+F — second body `{email, code, purpose}` only, `migrateFromHouseholdId` absent | PASS |
| D guest state before success | B+D — identity, `frigo_is_guest`, store, inventory cache, pending outbox byte-identical after the 409 | PASS |
| E failed retry | E — 400 on retry → guest state identical, not half-authenticated | PASS |
| F account session only after success | C+F — `localStorage`/store switch only after 200; no outbox rebind to the new household; no “đã được chuyển” claim | PASS |
| G OTP reuse safety (server) | `inventory-guest-transfer.test.ts` “D3 client contract” — real `/auth/register` → verify with field → 409, OTP row unchanged (`used 0`, `attempt_count 0`), no session; same OTP without field → 200 + cookie + `is_verified 1`; guest stock stays in `hh_guest_source`, new household has 0 rows; consumed OTP → 400 with or without the field | PASS |
| unrelated errors | 400 “Mã OTP không chính xác” stays on the normal error path, no deferral state | PASS |
| classification | only `ApiError` 409 with `code === INVENTORY_TRANSFER_DEFERRED` qualifies (not 400/401/offline/plain Error/non-JSON) | PASS |

Negative control: the UI suite run against the pre-fix `AuthPage` fails exactly
B+D, C+F and E (3/6) — it detects the defect.

Browser reproduction (packet §12) on `scripts/security-preview.mjs` from the
remediation tree (isolated in-memory SQLite, external network disabled):
Landing → “Bắt đầu trải nghiệm (Khách)” (guest `hh_guest_178920725521904jn7sxk`) →
guest adds one inventory item through the real route → `/auth?mode=register` →
register → dev OTP → “Xác thực & Hoàn tất” → **deferral notice + “Tiếp tục không
chuyển dữ liệu khách”** rendered; `localStorage` still guest (`frigo_is_guest=true`,
same household), page text contains neither `HTTP 409` nor
`INVENTORY_TRANSFER_DEFERRED` → click the action → `/onboarding`, `frigo_is_guest=false`,
`frigo_user_id=usr_…`, `/me` returns the registered user with its own household,
`GET /inventory` for the new account = 0 items (nothing claimed as migrated);
browser errors: none. Screenshot published in the thread.

## 2. D1 — tracked `.hoplite/settings.json` (P2) — CLOSED

Restored in the clean remediation worktree (where no platform overlay exists) with
`git checkout d1b06732f8a80db4e77986df31ff28d9f04641fa -- .hoplite/settings.json`.
`git ls-files -s` → `100644 3818a002fc12f70fa7a9a26078a125ac3d77998b`; raw SHA-256
`48507643905fe9070291cb858f037049a7f28b513974ee03264ac959f20b7935` (= main);
content has no `inference/ports/services` keys (not the overlay `6d8f5b45…` /
`a8c1f180…`). At the freeze: `git diff d1b0673 64c5501 -- .hoplite/settings.json` →
**no difference**. The workspace overlay in the task checkout was never edited,
staged, committed, restored or reset.

## 3. D2 — flag-gated meal-planning snapshot reader (P2) — DOCUMENTED

No code change; flag not enabled. `packages/db/src/meal-planning-snapshot.ts:198–202`
is now classified **`SAFE_DEFERRED`** in `docs/ai/inventory-truth/t11/READ_CONSUMER_MAP.md`
and `docs/ai/inventory-truth/t12/FINAL_AUTHORITY_MAP.md` (exact path; compatibility
projection; adopted reachable only if `MEAL_PLANNER_ENABLED === 'true'`; currently
off — not bound in `wrangler.jsonc`; read-only; not canonical authority; not
drift-immune; removal condition **`MEAL_PLANNER_AUTHORITY_CUTOVER`**: route
`loadMealPlanningSnapshot` inventory reads through T11 read authority /
`fetchHouseholdInventoryFromDb` or an equivalent canonical adapter before the flag
may be enabled for adopted households). UNKNOWN production readers = 0 with that
row present (the maps now say so honestly). Follow-up item recorded in
`TASK_BOARD.md`/`HANDOFF.md`.

## 4. Re-audit after remediation (packet §16–§17)

- Fresh grep, production readers of `inventory_items`/`inventory_lots`: same set as the
  review plus no new sites; **UNKNOWN readers = 0** (planner reader = SAFE_DEFERRED).
- Fresh grep, production writers: same fenced set; **UNKNOWN writers = 0**. The D3
  diff under `src/web` contains no SQL, no adoption/authority logic.
- Architecture unchanged: evidence → T10 observation → reconciliation → T09 command
  authority → `inventory_lots` → T11 read authority → consumers; `inventory_items`
  remains the compatibility projection; no second ledger.
- Migrations: 30; `git diff d156001 64c5501 -- migrations` empty (0023–0030
  byte-identical); no 0031.

## 5. Verification

Remediation working tree (before freeze): D3 suites 32/32 (6 UI + 26 route);
T12 22/22; T11 39/39; T10 98/98; T09 654/654; real D1 70/70; lint/typecheck/build
PASS; `migration-smoke=ok`; `pnpm schema:check:local` PASS; `git diff --check` clean;
full **3,092/3,092 across 120 files (196.55 s)**.

**Clean detached worktree `/tmp/hoplite/remed-clean` @ exact `64c5501`**
(`git status --porcelain` empty before start): Node v24.19.0, pnpm 10.26.0,
`pnpm install --frozen-lockfile` OK, lockfile SHA-256
`e3be8dd0c31cfb40f6bd6c8c08906a47a17a6347d02108f5a44b0bd3c96ddea3` unchanged
before/after (no dependency change).

| Gate | Result |
| --- | --- |
| `pnpm test` | **3,092 / 3,092 across 120 files (191.47 s)** — was 3,085/119 (+7 tests: 6 UI + 1 route) |
| D3 guest-registration tests | 32/32 |
| Real local D1 (44 + 7 + 11 + 8) | **70/70** |
| T09 / T10 / T11 / T12 focused | 654/654 · 98/98 · 39/39 · 22/22 |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | PASS / PASS / PASS |
| `pnpm check:migrations` | `migration-smoke=ok` (30) |
| local D1 apply + `pnpm schema:check:local` | PASS |
| `git diff --check` | clean |
| `git status --porcelain` at end | **empty** (ignored only: `.wrangler/`, `dist/`, `node_modules/`) |

## 6. Release diff audit (packet §22)

`d156001 → 64c5501`, application: `.hoplite/settings.json` (A, main blob),
`src/web/pages/AuthPage.tsx` (+56/−7), `src/web/services/auth.ts` (+8),
`src/web/services/http.ts` (+12), `tests/integration/inventory-guest-transfer.test.ts`
(+56), `tests/unit/auth-guest-transfer-deferred.test.tsx` (A, 270) — nothing else
outside `docs/`. `d1b0673 → 64c5501`: 126 files, 0 binary rows, no change to
`package.json`, `pnpm-lock.yaml`, `wrangler*.jsonc`, `tsconfig*`, `vite.config.ts`,
`eslint.config.js`, `.dev.vars.example`, `public/_headers`, `.gitignore`;
`.hoplite/settings.json` no longer differs from main; secrets scan of new
application lines: none.

## 7. Status

D3 CLOSED · D1 CLOSED · D2 DOCUMENTED (deferred cutover tracked as
`MEAL_PLANNER_AUTHORITY_CUTOVER`). No P0/P1 known. Main NOT merged; nothing
deployed; remote D1 NOT touched; PayOS untouched; T09/T10/T11 semantics unchanged;
DEC-012 unchanged (DEC-015 records the client contract).
