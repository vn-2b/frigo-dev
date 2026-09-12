# T10 verification receipt

## Current authoritative freeze — observation claim fence (P1 concurrency fix)

**T10 application freeze: `7393edcd4fb9cc8bb4df2a06628fb5dc57f8607b`** —
`fix(t10): atomically fence competing reconciliation decisions` — published/fetched,
local == remote == clean-checkout SHA. Supersedes `4c414fa` (historical ancestor).

### Reproduced defect (pre-fix, at `4c414fa`)

Controlled barrier races of two different decision keys on one OPEN observation
(SqliteD1, `beforeBatch` pause on the contender's decision batch):

| Race | Pre-fix loser outcome | Pre-fix state |
| --- | --- | --- |
| DISMISS vs DISMISS | raw `ERR_SQLITE_ERROR` (0030 receipt trigger abort), no domain code | one decision (by luck of the trigger) |
| DISMISS vs CORRECT / CORRECT vs DISMISS / CORRECT-A vs CORRECT-B | raw SQLite errors (trigger or `NOT NULL … inventory_events`) | one decision |
| DISMISS vs DISMISS **with the 0030 receipt trigger dropped** | **loser RESOLVED** — **two** decision rows for one observation | double commit |
| same key racing itself | raw `Inventory command receipt already exists` instead of replay | — |

Root cause: the final `UPDATE inventory_observations … WHERE status='OPEN' AND version=?`
affecting zero rows is a **silent success** in D1 (`success=true, meta.changes=0`,
proven under real workerd D1 in `inventory-observation-d1.test.mjs`), and nothing in the
batch proved the claim. Correctness was resting entirely on a trigger side effect and
losing contenders leaked raw SQLite errors.

### Fix — in-batch observation claim guard

`observationClaimGuard` is appended as the **last** statement of the decision batch:
`INSERT INTO inventory_events (…, inventory_item_id, …) SELECT ?, ?, NULL, 'T10_OBSERVATION_CLAIM_GUARD', 0, 'piece' WHERE changes() <> 1`.
If the immediately preceding observation UPDATE did not claim exactly one row, the guard
row violates `inventory_events.inventory_item_id NOT NULL`, the statement fails and D1
rolls back the entire batch (T09 receipts/events, lot CAS, projection writes, decision
receipt, observation). It is the T09 `writeGuard` technique, which D1 already honours in
production (`changes()` is tied to the top-level write despite revision triggers —
proven in `inventory-lot-d1.test.mjs`). The guard row itself can never commit.
Loser classification after rollback: committed same-key twin with equal fingerprint →
**replay** (response-loss preserved); altered twin → `IDEMPOTENCY_CONFLICT`; observation
not OPEN at expected version → **`OBSERVATION_VERSION_CONFLICT`**; T09 CAS/authority →
existing `STALE_SNAPSHOT`/`STALE_VERSION` codes; otherwise `PERSISTENCE_FAILED`. No raw
SQLite/D1 error reaches callers. The pre-batch exact-replay lookup still precedes the
OPEN/version rejection path. No migration; 0023–0030 untouched (30 migrations).

### Regressions (`tests/integration/inventory-reconciliation-fence.test.ts`, 13 tests)

Race matrix DISMISS/DISMISS, DISMISS/CORRECT, CORRECT/DISMISS, CORRECT-A/CORRECT-B on the
native lot; CORRECT+MOVE vs DISMISS and DISMISS vs CORRECT+MOVE; backfilled synthetic lot
CORRECT/CORRECT, CORRECT+MOVE/DISMISS, DISMISS/DISMISS (projection coherent); trigger-dropped
DISMISS/DISMISS and CORRECT/CORRECT (in-batch proof independent of 0030); same key exact →
replay; same key altered → `IDEMPOTENCY_CONFLICT`. Each race asserts: single winner, loser
`OBSERVATION_VERSION_CONFLICT`, one receipt, RECONCILED v2, zero `T10_*` guard rows, no
losing commands/events/lot/projection change, winner exact replay byte-identical, winner
key altered → conflict, loser retry and fresh key → `OBSERVATION_NOT_OPEN`.
**13/13 fail on the pre-fix source** (stash proof). Real D1 adds: zero-row guarded UPDATE
silent-success proof + guard-abort rollback proof, and a controlled two-DISMISS race through
workerd (`/reconcile-race`) → winner commits, loser `OBSERVATION_VERSION_CONFLICT`.
Two existing assertions were aligned to the intended semantics: same-key/same-fingerprint
race now **replays** (was "rejects anything"); injected adapter failure surfaces as
`PERSISTENCE_FAILED` (was raw message).

### Gates at the fence freeze (working tree)

| Gate | Result |
| --- | --- |
| Full tests | **3,024/3,024 across 114 files** (179.15s) |
| T10 focused (6 suites incl. fence + real D1) | 98/98 |
| T09 focused (8 suites incl. real D1) | 323/323 |
| Lint / typecheck / build | PASS / PASS / PASS |
| Migration smoke | `migration-smoke=ok`, 30 migrations |
| Local schema gate | PASS |
| Real local D1 (44 + 7) | 51/51 |
| `git diff --check` | clean |

### Clean detached checkout at exact remote SHA `7393edc`

`git worktree add --detach /tmp/frigo-t10-fence 7393edc…` + `pnpm install --frozen-lockfile`:
full **3,024/3,024 across 114 files** (178.33s); lint/typecheck/build PASS;
`migration-smoke=ok` (30); local D1 apply then schema gate PASS; real local D1 51/51;
`git diff --check` clean; `git status --porcelain` **empty**.

## Historical receipt — composition fix freeze `4c414fa7eb33329ee12936c0899644af67e48f07` (superseded)

## Current authoritative freeze — multi-field reconciliation composition fix

**T10 application freeze: `4c414fa7eb33329ee12936c0899644af67e48f07`** —
`fix(t10): compose multi-field reconciliation commands atomically` — published/
fetched, local == remote == clean-checkout SHA. The previous freeze `6c28858acd0627d2d602998107c2e260c5e4f0d5`
is superseded (historical; remains an ancestor).

### Reproduced P1 (pre-fix, at `6c28858`)

Pure-planner repro (native lot v3, 2 kg, KNOWN 2026-09-20, fridge; observation OBSERVED):

| Case | Pre-fix verdict | Pre-fix proposals |
| --- | --- | --- |
| quantity + expiry | PROPOSE_EXPIRY_UPDATE | **2 CORRECT** ({quantity,unit}, {expiryAt,expiryKind}) |
| quantity + openedAt | PROPOSE_CORRECTION | **2 CORRECT** ({quantity,unit}, {openedAt}) |
| quantity + expiry + openedAt | PROPOSE_EXPIRY_UPDATE | **3 CORRECT** |
| quantity + storage | PROPOSE_CORRECTION | 1 CORRECT + 1 MOVE (correct count; verdict fine) |
| quantity + expiry + storage | PROPOSE_EXPIRY_UPDATE | **2 CORRECT + 1 MOVE** (3 proposals; also exceeded the declared max of 2) |

Root cause: `evaluateOne` collected each dimension's proposal independently and
the verdict chose EXPIRY_UPDATE whenever any expiry-only CORRECT existed;
`decisionCommandSpecs` mapped every CORRECT to `<decisionKey>#CORRECT`, so split
CORRECTs shared a client key and a single expectedVersion (idempotency/CAS hazard).

### Fix

- Planner `composeProposals`: merges all compatible CORRECT changes into exactly
  one CORRECT and keeps at most one MOVE, both bound to the matched lot at its
  current version; contradictory values for one property, cross-lot/version
  proposals or a second MOVE → CONFLICT `PROPOSAL_COMPOSITION_CONFLICT`.
- Verdicts: lone expiry → PROPOSE_EXPIRY_UPDATE; lone move → PROPOSE_MOVE; any
  other combination (incl. expiry+storage) → PROPOSE_CORRECTION with exact proposals.
- Decision boundary `assertProposalSetInvariant`: max one CORRECT, max one MOVE,
  same lotId and expectedVersion, declared decision type consistent with the set;
  malformed caller input → INVALID_DECISION (never normalized). `decisionCommandSpecs`
  re-asserts uniqueness and composes CORRECT+MOVE via T09 `useCurrentLotVersion`
  (the manual PATCH adapter's atomic pattern).
- No migration; 0023–0030 byte-identical; migration count stays 30.

### Regression coverage

`tests/integration/inventory-reconciliation-composition.test.ts` (19 tests):
8-case pure matrix + single-dimension verdict preservation + zero-quantity
no-fabricated-terminal-state + all-match; boundary rejections (two CORRECT, two
MOVE, cross-lot, mismatched version, split CORRECTs, type/proposal mismatch,
split-valid → OBSERVATION_STALE); native and backfilled execution (one CORRECT
+ one MOVE, lot version +2, projection coherent, exact replay, four altered-field
IDEMPOTENCY_CONFLICTs, new key → OBSERVATION_NOT_OPEN); merged CORRECT-only single
command; zero quantity requires explicit terminalState; races vs CORRECT/MOVE/FEFO.
**16/19 fail on the pre-fix source** (stash proof), 19/19 pass after the fix.

### Gates at the new freeze (working tree)

| Gate | Result |
| --- | --- |
| Full tests | **3,009/3,009 across 113 files** (176.06s) |
| T10 focused (4 prior suites + composition suite) | 78/78 (59 + 19) |
| Lint / typecheck / build | PASS / PASS / PASS |
| Migration smoke | `migration-smoke=ok`, **30 migrations** |
| Local schema gate | PASS |
| Real local D1 | 49/49 |
| `git diff --check` | clean |

### Clean detached checkout at exact remote SHA `4c414fa`

`git worktree add --detach /tmp/frigo-t10-fix 4c414fa…` + `pnpm install --frozen-lockfile`:
full **3,009/3,009 across 113 files** (173.74s); lint/typecheck/build PASS;
`migration-smoke=ok` (30); local D1 apply (fresh worktree DB) then schema gate PASS;
real local D1 49/49; `git diff --check` clean; `git status --porcelain` **empty**.

## Historical receipt — freeze `6c28858acd0627d2d602998107c2e260c5e4f0d5` (superseded)

Application freeze: `6c28858acd0627d2d602998107c2e260c5e4f0d5`
(`feat(t10): add inventory observation reconciliation authority`),
branch `hoplite/himera-6d3eda84-t10-observation-reconciliation`,
published/fetched, local == remote == clean-checkout SHA.
Base lineage: train merge `668920fa462524e65a79d31a7b0844720baf38e0`
(T09 freeze `bf391c5fdcdd9e9c2f2257db515815e082cb4381` and docs
`d522769ae89496fd4b3f26419f1fdfe23d9e926a` are ancestors). Main
`d1b06732f8a80db4e77986df31ff28d9f04641fa` untouched, NOT merged.

## 1. Baseline before any source edit (T10 branch at the T09 tree)

| Gate | Command | Result |
| --- | --- | --- |
| Full tests | `pnpm test` | 2,926 passed / 108 files (180.95s) |
| Lint | `pnpm lint` | PASS |
| Typecheck | `pnpm typecheck` | PASS |
| Build | `pnpm build` | PASS (6.14s) |
| Migration smoke | `pnpm check:migrations` | `migration-smoke=ok` (29 migrations) |
| Local schema | `pnpm schema:check:local` | PASS |
| Real D1 | `pnpm exec vitest run tests/integration/inventory-lot-d1.test.mjs` | 44/44 (5.94s) |
| Diff | `git diff --check` | clean |

## 2. Gates at the application freeze (working tree)

| Gate | Result |
| --- | --- |
| Full tests | 2,990/2,990 across 112 files (177.04s) |
| T10 focused gate (19 files: 4 new T10 suites + 15 T09 inventory suites + real-D1) | 1,097/1,097 (103.49s; first run caught the stale 29-migration assertion, fixed as the intended test update) |
| Lint | PASS |
| Typecheck | PASS (0 errors after typing fixes) |
| Build | PASS (6.13s) |
| Migration smoke (30 migrations incl. 0030 + T10 asserts) | `migration-smoke=ok` |
| Local D1 apply 0029 → 0030 | PASS (13 commands, 0030 applied) |
| Local schema gate (requires 0030, T10 tables + 8 triggers) | PASS |
| Real local D1 (44 T09 + 5 T10) | 49/49 |
| `git diff --check` | clean |

## 3. Clean detached checkout at the exact remote SHA

```
git worktree add --detach /tmp/frigo-t10-clean 6c28858acd0627d2d602998107c2e260c5e4f0d5
pnpm install --frozen-lockfile
```

| Gate | Result |
| --- | --- |
| Full tests | 2,990/2,990 across 112 files (175.72s) |
| Lint | PASS |
| Typecheck | PASS |
| Build | PASS |
| Migration smoke | `migration-smoke=ok` |
| Local D1 migrations apply | PASS |
| Local schema gate | PASS |
| Real D1 (both suites) | 49/49 |
| `git diff --check` | clean |
| `git status --porcelain` | EMPTY (0 lines) |

## 4. Migration verification (local only; no remote D1)

- Fresh 0001 → 0030: PASS (smoke chain + explicit sqlite3 run)
- Upgrade 0029 → 0030: PASS (`wrangler d1 migrations apply frigo-db --local`, 0030 applied, gate PASS)
- Historical migrations 0023–0029: byte-identical (0030 only adds objects)
- Remote D1: NOT touched. Deploy: NOT performed.

## 5. Publication

- `source_control_publish_git_commit` → branch
  `hoplite/himera-6d3eda84-t10-observation-reconciliation`, head
  `6c28858acd0627d2d602998107c2e260c5e4f0d5`
- `git fetch` + `git rev-parse`: local == origin
- Predecessor publication attempt to `hoplite/himera-6d3eda84/<slug>` was
  rejected by GitHub (ref conflict with the live parent branch) — resolved via
  the platform start-branch successor (dashed name) after the internal train
  merge of PR #1
- The PR tooling twice auto-committed the `.hoplite/settings.json` workspace
  overlay onto published branches (`99e4b7b` on the T09 branch during PR #1
  creation; `a3abd6d` on this branch during PR #2 creation). Both were
  corrected by following restore commits (`09f13c4`, `ab1e983`) published with
  compare-and-swap leases; the repository's committed settings (sqlite3 setup +
  security-preview run script) are intact on the branch and the overlay remains
  uncommitted local workspace state, byte-for-byte.

## 6. Known non-issues

- No GitHub CI runs exist for the branch (repository has no CI configured for
  it); reviewers should check post-merge.
- The PR tooling auto-committed the `.hoplite/settings.json` workspace overlay
  as `99e4b7b` during PR #1 creation; corrected by `09f13c4` (repository
  settings restored). The overlay itself remains uncommitted local workspace
  state, byte-for-byte (SHA-256
  `6d8f5b45041a5f41bfa6463a5f88fe1e0f5602822ecb403a5d949961f00bbee7`), excluded
  from every commit.
