# T10 verification receipt

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

## 6. Known non-issues

- No GitHub CI runs exist for the branch (repository has no CI configured for
  it); reviewers should check post-merge.
- The PR tooling auto-committed the `.hoplite/settings.json` workspace overlay
  as `99e4b7b` during PR #1 creation; corrected by `09f13c4` (repository
  settings restored). The overlay itself remains uncommitted local workspace
  state, byte-for-byte (SHA-256
  `6d8f5b45041a5f41bfa6463a5f88fe1e0f5602822ecb403a5d949961f00bbee7`), excluded
  from every commit.
