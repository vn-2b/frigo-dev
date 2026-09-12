# T12 verification receipt

## Current authoritative freeze — closed-loop runtime verification fix

**T12 application freeze: `d15600186c3e73faba011eb690ac6cd70e8d3d2d`** —
`fix(t12): complete closed-loop runtime verification` — published/fetched,
local == remote == clean-checkout SHA. Supersedes `22f675d` (historical
ancestor). Starting docs HEAD for this fix: `24668c20dfaac094aff0f84e0d59c1f0a333fbf8`.

### Independent-review findings closed

| Finding | Resolution | Proof |
| --- | --- | --- |
| P1 — no T12 real workerd/D1 suite | New `tests/integration/inventory-closed-loop-d1.test.mjs` (8 cases) on actual local D1 (isolated DB `…0032`, fresh 0001→0030 chain) via test-only worker endpoints `/plan` and `/reconcile-vs-manual` (TEST_TOKEN-gated, never shipped) | Real D1 **62 → 70** |
| P2 — coverage bypassed routes | New `tests/integration/inventory-closed-loop-routes.test.ts` (5 tests) drives the REAL Hono handlers `POST /week/plans/:id/shopping/complete`, `POST /recipes/:id/cook/complete`, `GET /inventory` with `authMiddleware` and a stale KV injected | route → adapter → T09 → lot → T11 proven end-to-end |
| P2 — race accepted `PERSISTENCE_FAILED` | Reconciliation-vs-manual CORRECT regression now requires `LotCommandError` **`STALE_SNAPSHOT`** (T09 household `inventory_version` CAS guard, classified post-rollback by `classifyDecisionBatchFailure` → `classifyLotCommandBatchFailure`) and proves no decision receipt, no losing commands/events, observation still OPEN v1, parity clean | integration + real D1 (case H) |

### Route fix surfaced by the route-level proof

`completeAdoptedCooking` (`src/worker/routes/recipes.ts`) now replays the
durable `cooked_meals` receipt **before** re-planning. Previously a response-
loss retry of an adopted cook re-planned against the already-consumed authority
and answered `INSUFFICIENT_INVENTORY` instead of the idempotent replay (the
legacy branch already replayed first; the adopted adapter only replayed on batch
failure). Altered same-key requests still return `IDEMPOTENCY_CONFLICT`. No other
application behavior changed; no new SQL writer (diff of `src/` adds zero
INSERT/UPDATE/DELETE statements).

### Real-D1 cases (`inventory-closed-loop-d1.test.mjs`)

A accepted CORRECT+MOVE exactly-once + replay + altered-key conflict · B DISMISS
inert · C read → USE 200 g → read (500 → 300 g, no KV) · D FEFO current/
historical views · E projection drift immunity + `QUANTITY_DRIFT` · F response-
loss retry without duplicate lot/event/receipt + altered-key conflict · G cross-
tenant rejection (read lot, legacy mapping, reconcile, CORRECT/MOVE/DISCARD) ·
H reconciliation vs manual CORRECT → explicit `STALE_SNAPSHOT` loser.

### Route-level cases (`inventory-closed-loop-routes.test.ts`)

Shopping: adopted-empty read `[]` (not the stale KV) → import creates one lot
through the adapter (`shopping_import_commands` completed, no `T09_WRITER_FENCE`
event) → `GET /inventory` shows the lot → exact retry `idempotentReplay` with
identical facts → altered payload same key rejected with identical facts →
cross-tenant `404 NOT_FOUND` with no mutation. Cook: two-lot FEFO through the
route (response inventory `[eggs-late 6 v2]`, lots CONSUMED/ACTIVE, cooked_meals
receipt, 2 `cook:` commands, parity clean, no `inv_` KV writes) → exact retry
replays → altered key `409 IDEMPOTENCY_CONFLICT` → `GET /inventory` shows only
the active lot; insufficient stock `409 INSUFFICIENT_INVENTORY` with no partial
consumption; cross-tenant cook cannot touch A's lots.

### Baseline before this fix (branch tip `24668c2`)

Full **3,072/3,072 across 117 files**; real D1 **62/62**; lint/typecheck/build
PASS; `migration-smoke=ok` (30); local schema gate PASS; `git diff --check` clean.

### Gates at the new freeze (working tree)

| Gate | Result |
| --- | --- |
| T12 focused (closed-loop + routes + real D1) | 22/22 |
| T11 focused | 39/39 |
| T10 focused | 98/98 |
| T09 focused | 654/654 |
| Full tests | **3,085/3,085 across 119 files** |
| Lint / typecheck / build | PASS / PASS / PASS |
| Migration smoke | `migration-smoke=ok`, 30 migrations (0023–0030 untouched) |
| Local schema gate | PASS |
| All real local D1 (44 T09 + 7 T10 + 11 T11 + 8 T12) | **70/70** |
| `git diff --check` | clean |

### Clean detached checkout at exact remote SHA `d156001`

`git worktree add --detach /tmp/frigo-t12-fix d156001…` + `pnpm install --frozen-lockfile`:
full **3,085/3,085 across 119 files** (186.54s); lint/typecheck/build PASS;
`migration-smoke=ok` (30); local D1 apply then schema gate PASS; all real local D1
**70/70**; `git diff --check` clean; `git status --porcelain` **empty**.

### Re-audits

- Readers: production `UNKNOWN = 0`; writers: production `UNKNOWN = 0`
  (fresh grep; same fenced set as FINAL_AUTHORITY_MAP / FINAL_WRITER_MAP).
- Cache: adopted `GET /inventory`, cook and shopping routes proven with a stale
  KV — never served, never refreshed (`inv_*` writes = 0).
- No new ledger, table, materialization, or writer.

## Historical receipt — first T12 freeze `22f675d1cca76d05c93ebb2ed40bbaea11a72238` (superseded)

## Lineage

- Base: T11 docs HEAD `847b0363…` via train merge `14c02f8` (release train
  `hoplite/kydonia-2785bb72`; main `d1b0673` untouched, 0 ahead/behind unchanged).
- T12 branch: `hoplite/himera-6d3eda84-t10-observation-reconciliation-t11-inventory-read-authority-t12-inventory-closed-loop`.
- T11 freeze `c15c9a8` verified ancestor before any edit.

## Baseline before T12 edits (train base tree)

Full **3,063/3,063 across 116 files**; real local D1 **62/62**; lint/typecheck/
build PASS; `migration-smoke=ok` (30); schema gate PASS; T11 focused 39/39;
T10 focused 98/98; T09 focused 654/654. No unexplained regressions.

## What T12 changed (application)

- `packages/db/src/inventory-read-authority.ts`: retained display alias is now
  honored only while the projection row itself agrees with authority (label AND
  quantity round-trip through `toLotQuantity`); tampered rows drop to canonical
  presentation. No other behavior change.
- `tests/integration/inventory-read-authority.test.ts`: tamper expectation
  updated to the stricter canonical fallback (999 kg → 2000 g canonical).
- `tests/integration/inventory-closed-loop.test.ts`: new 9-test closed-loop suite
  (E2E reconciliation, DISMISS, recipe, planner, shopping, cook/FEFO,
  notifications, reconciliation-vs-manual race, drift matrix).
- No migration (count stays 30); no new production writers; no PayOS touch;
  no legacy removals.

## Gates at the T12 freeze

| Gate | Result |
| --- | --- |
| Full tests | **3,072/3,072 across 117 files** (169.87s) |
| Lint / typecheck / build | PASS / PASS / PASS |
| Migration smoke | `migration-smoke=ok`, 30 migrations |
| Local schema gate | PASS |
| Real local D1 (44 T09 + 7 T10 + 11 T11) | **62/62** |
| `git diff --check` | clean |

## Classification

- P0: NONE · P1: NONE · P2: NONE merge-blocking · P3: legacy compatibility
  paths remain for non-adopted households by design (FINAL_AUTHORITY_MAP.md
  lists why/reach/removal/truth-risk for each).
- **UNKNOWN production readers = 0 · UNKNOWN production writers = 0.**

## Prohibitions

Main NOT merged · production NOT deployed · remote D1 NOT touched · PayOS
untouched · no historical migration edits · no force-push/reset/clean ·
`.hoplite/settings.json` overlay preserved byte-for-byte uncommitted ·
T12 is the final train task; no post-T12 task started.
