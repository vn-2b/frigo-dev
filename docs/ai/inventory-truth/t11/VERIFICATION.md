# T11 verification receipt

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
