# T11 verification receipt

## Current authoritative freeze — runtime hardening fix

**T11 application freeze: `c15c9a81fc4367b3506a7e2693798ebe1424b0a9`** —
`fix(t11): complete read authority runtime hardening` — published/fetched,
local == remote == clean-checkout SHA. Supersedes `657201f` (historical ancestor).
Starting docs HEAD for this fix: `e64ee7749d3110ecc7b1eb08216062fc404918d5`.

### Findings closed

| Finding | Resolution | Proof |
| --- | --- | --- |
| A. No real-D1 proof of T11 | New `tests/integration/inventory-read-authority-d1.test.mjs` (11 cases) through test-only worker endpoints `/read`, `/funnel`, `/read-race` on actual local workerd/D1 (isolated DB, fresh 0001→0030 chain) | Real D1 **51 → 62** |
| B. Adopted-but-empty regression | Integration + real D1 + HTTP `GET /inventory`: valid receipt, zero lots → mode `native`, `[]`; stale KV neither read nor written; no auto-adoption; stale projection rows without lots → `ADOPTION_REQUIRED` (fail closed, never served) | PASS ×3 surfaces |
| C. READ vs MOVE / DISCARD / FEFO | Deterministic barrier tests in both harnesses (SqliteD1 `beforeBatch`; real-D1 `/read-race` pauses the writer before its command batch, reads, releases, reads again) | every snapshot is a legal before/after state; FEFO never a cross-lot hybrid |
| D. `readInventorySummary.activeCount` | Now equals the returned (filtered) summary length | 3 lots / RICE filter → `activeCount 1`, `items 1`; no match → `0/[]` |
| E. Display-unit compatibility | `displayQuantity`: retained legacy alias (kg↔g, l↔ml) presented only when the projection supplies the unit *label* and the alias round-trips exactly via `toLotQuantity`; count/contextual units never convert; unprovable alias → canonical; projection quantity never consulted | legacy 2 kg → authority 2 000 000 milli/g → API `2 kg`; 1.5 l → 1 500 000/ml → `1.5 l`; native 500 g → `500 g`; projection `999 kg` → still `2 kg`; malformed `bag` → `2000 g` |
| F. Freshness hardening | `computeReadFreshness(expiry, state, now)` deterministic + injectable; invalid/impossible dates throw → `CORRUPT_LOT_ROW`; non-finite clock → `INVALID_READ_QUERY`; T09 snapshot schema rejects impossible dates one layer earlier (`DRIFT_DETECTED`) | 6 invalid inputs never classify `fresh` |

### Re-audits

- Readers: production `UNKNOWN = 0` (`READ_CONSUMER_MAP.md`, `LEGACY_READ_MAP.md`); no new dual-truth fallback.
- Writers: production `UNKNOWN = 0`; T11 hardening adds no `inventory_items` writer (`LEGACY_READ_MAP.md`).
- Migrations: 30, 0023–0030 untouched.

### Baseline before this fix (branch tip `e64ee77`)

Full **3,041/3,041 across 115 files**; real D1 **51/51**; lint/typecheck/build PASS;
`migration-smoke=ok` (30); local schema gate PASS.

### Gates at the new freeze (working tree)

| Gate | Result |
| --- | --- |
| T11 focused (read-authority + real D1) | 39/39 |
| T09 focused (10 suites incl. real D1) | 654/654 |
| T10 focused (6 suites incl. real D1) | 98/98 |
| Full tests | **3,063/3,063 across 116 files** (166.41s) |
| Lint / typecheck / build | PASS / PASS / PASS |
| Migration smoke | `migration-smoke=ok`, 30 migrations |
| Local schema gate | PASS |
| All real local D1 (44 T09 + 7 T10 + 11 T11) | **62/62** |
| `git diff --check` | clean |

### Clean detached checkout at exact remote SHA `c15c9a8`

`git worktree add --detach /tmp/frigo-t11-final c15c9a8…` + `pnpm install --frozen-lockfile`:
full **3,063/3,063 across 116 files** (164.68s); lint/typecheck/build PASS;
`migration-smoke=ok` (30); local D1 apply then schema gate PASS; all real local D1
**62/62**; `git diff --check` clean; `git status --porcelain` **empty**.

## Historical receipt — first T11 freeze `657201f3a12f18dd96cc96adeac0dd1d3b75e6f4` (superseded)

## Application freeze

**T11 application freeze: `657201f3a12f18dd96cc96adeac0dd1d3b75e6f4`** —
`feat(t11): canonical inventory read authority with projection cutover` —
published on branch
`hoplite/himera-6d3eda84-t10-observation-reconciliation-t11-inventory-read-authority`
as PR #3. Two platform commits followed: `c7e2296` (PR tooling auto-commit of
the external `.hoplite/settings.json` workspace overlay — removed again by
corrective commit `4553b8a`, the established T10 pattern `09f13c4`/`ab1e983`;
the overlay file itself is preserved byte-for-byte in the workspace, SHA-256
`6d8f5b45…`). The product tree of the branch tip is identical to the freeze.

## Lineage

- T11 base: train merge `30ce4ea` (kydonia release train after PR #2 merged),
  which contains exactly the required T10 docs HEAD `c71692a…` and T10
  application freeze `7393edc…` (ancestry verified with `git merge-base
  --is-ancestor`).
- Main `d1b0673…` untouched and NOT merged. PR #3 targets the configured base
  `hoplite/kydonia-2785bb72` (the release train), not main.
- T11 is an isolated release-train task: no deploy, no remote D1, no PayOS,
  no legacy table deletion, no full legacy write removal, T12 NOT STARTED.

## Baseline (before T11 source changes, on the base tree)

`pnpm install --frozen-lockfile` + full battery: **3,024/3,024 across 114
files** (167.16s); lint/typecheck/build PASS; `migration-smoke=ok` (30);
local schema gate PASS; real local D1 **51/51**. Counts must not decrease —
final counts increase everywhere.

## Gates at the freeze (working tree)

| Gate | Result |
| --- | --- |
| Full tests | **3,041/3,041 across 115 files** (17 new read-authority tests) |
| Lint / typecheck / build | PASS / PASS / PASS |
| Migration smoke | `migration-smoke=ok` (30 migrations, no new migration) |
| Local D1 apply + schema gate | PASS (local only; no remote D1) |
| Real local D1 (44 T09 + 7 T10) | 51/51 |
| `git diff --check` | clean |

## Clean detached checkout at the exact freeze SHA

`git worktree add --detach /tmp/frigo-t11-verify 657201f…` +
`pnpm install --frozen-lockfile`: full **3,041/3,041 across 115 files**
(161.75s); lint/typecheck/build PASS; `migration-smoke=ok` (30); local D1
apply then schema gate PASS; real local D1 51/51; `git diff --check` clean;
`git status --porcelain` **empty**.

## Verification highlights

- Read consumer audit: `READ_CONSUMER_MAP.md`, production `UNKNOWN = 0`.
- Authority read service proves: lots-only content, kg/g/l/ml/piece exactness,
  terminal-state semantics, tenancy fencing, bounds, observation
  non-authority, projection-tamper immunity, corruption fail-closed, read/write
  coherence (READ vs CORRECT/USE/T10 reconciliation), HTTP contract for
  adopted and legacy households, KV bypass.
- No migration; 0023–0030 untouched.
