# T09 verification (append-only evidence)

## T09E final prepublication receipt — 2026-09-11

Both independent-review findings are fixed: retained fingerprint/result version
binding and persisted ordered-receipt equality in the completion fence. The latter
uses symmetric JSON-tree comparisons (array order matters; object key order does
not). Full-batch reverse-and-renumber attacks roll back in SQLite and actual local
D1; unmodified batches and subsequent replay succeed. Scoped independent E review
reports no remaining P1/P2 findings. This is not the final T09 independent review.

Final executed checks on the application tree to be committed:

| Command / evidence | Result |
| --- | --- |
| Full 11-file focused command recorded below; `.hoplite/artifacts/t09e-publish/focused.log` | PASS, **1,172 tests / 11 files**, 02:03:37 UTC, 89.46s; includes 35 actual local D1 cases |
| `pnpm test`; `.hoplite/artifacts/t09e-publish/full.log` | PASS, **2,659 tests / 98 files**, 02:07:12 UTC, 154.24s |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS, both TypeScript projects |
| `pnpm build` | PASS |
| `pnpm check:migrations` | PASS, 27-migration replay |
| Isolated local-D1 27-migration apply/schema gate recorded below | PASS; schema unchanged by final completion-fence fix |
| `git diff --check`; frozen 0023–0026 byte comparison | PASS |

Final focused breakdown: command unit 202, truth unit 76, command repository 146,
lot schema 26, actual D1 35, truth repository 54, receipt authority 306, event
authority 196, FEFO unit 20, FEFO repository 34, FEFO schema 77. No migration
artifact duplicates remain. The older 1,170/2,657 receipts below are historical;
these final results include both later ordered-receipt regressions.

Next: commit/publish/fetch/equality-check E on the authorized successor before F.
No live writer changed, no application freeze and no T09 readiness claim.

## 2026-09-10 — publication-first baseline

- User confirmed canonical `vn-2b/frigo-dev`; no remote URL changed.
- Git status/remotes/log/branches inspected. Broker fetched main and T08.
- Main: d1b06732f8a80db4e77986df31ff28d9f04641fa.
- T08: 8f8788c1a0c9e486657751ef3875a5baa5334dec, COMPLETE receipt, source,
  migration 0023, 130-test suite and handoff present.
- Published authorized T09 branch at exact T08 HEAD; fetched same SHA.
- `test "$(git rev-parse HEAD)" = "$(git rev-parse origin/hoplite/euhesperides-d77023a5)"`: PASS.
- No implementation written before publication.
- Existing CI filters do not run on this branch. Deploy release job requires main
  workflow/CI ancestry gates; no workflow was dispatched and no PR opened.
- Managed setup failed to claim despite ready/no operation. Exact existing repo
  setup run via shell: sqlite3 installation + `pnpm install --frozen-lockfile` PASS
  (Node 24.19.0, pnpm 10.26.0); platform issue reported. No dependency edits.
- Fresh tests, lint, typecheck, build and migration gates: NOT YET RUN.

## T09A baseline and audit checkpoint

- Initial review packet committed/published/fetched at
  e56f163921a4afd901f63c46617a8f574bbc5be1.
- `pnpm exec vitest run tests/unit/inventory-truth.test.ts tests/integration/inventory-truth.test.ts`:
  PASS **130 tests / 2 files** (76 unit, 54 integration), 12:57:57 UTC, 2.38s.
- `git diff --check`: PASS before initial commit.
- Read-only delegated SQLite probe: 23-migration replay, invalid-event CAS guard
  rollback confirmed; version+1 postcondition demonstrated unsafe. This probe is
  design evidence, not the final T09 runtime/test suite.
- Exhaustive writer audit completed; findings and required mitigations in WRITER_MAP.
- No T09 application code yet. Full/lint/typecheck/build/migration final gates pending.

## T09B — command contracts

- T09A c212deda67d832e4fde18941f06d6f38a99a2a96 published/fetched before code.
- Added pure CREATE/USE/DISCARD/OPEN/MOVE/CORRECT planner and 202 unit tests.
- `pnpm exec vitest run tests/unit/inventory-lot-commands.test.ts tests/unit/inventory-truth.test.ts tests/integration/inventory-truth.test.ts`:
  PASS **332 tests / 3 files** (202 T09B + 130 T08), parent rerun 13:15:41 UTC.
- `pnpm exec eslint packages/domain/src/inventory-lot-commands.ts tests/unit/inventory-lot-commands.test.ts`: PASS (implementation agent).
- `pnpm typecheck`: PASS (implementation agent).
- Initial test assumption that installed T08 Zod accepts February 30 was incorrect;
  installed Zod 3.25.76 already rejects it. Corrected the assumption, retained strict
  live timestamp tests. No T08 schema weakened or changed.
- Domain boundary only: no HTTP exposure, persistence, migration, FEFO or writer
  cutover yet. Full final gates and runtime atomicity remain pending.

## T09C — native command/schema implementation

Base checkpoint 5d10bc5fd6d58922e33c18a737351d70864599c9 was published/fetched.
Internal native executor, additive 0024, SQLite schema/core tests and actual local
D1 Worker tests added. No HTTP or legacy writer changes.

Executed during implementation:
- Combined T08/T09 contracts/core/schema/runtime: **505 tests / 6 files PASS**
  before final two adoption tests (13:43:16 UTC).
- `pnpm test`: **1,986 / 93 files PASS**, then **1,992 / 93 files PASS** after
  terminal freshness/runtime executor hardening (13:44:09 UTC, 72.07s).
- `pnpm lint`, `pnpm typecheck`, `pnpm build`: PASS before final adoption gate.
- `pnpm check:migrations`: PASS, 24-migration chain.
- `pnpm wrangler d1 migrations apply frigo-db --local`: PASS, 24/24; repeated
  into a fresh local store after preserving the initial proof store.
- `pnpm schema:check:local`: PASS against final 0024 table/column/trigger list.
- Populated 0023 -> 0024, full SQLite integrity/FKs, query plans: PASS in schema tests.

Corrected failures/findings:
1. D1 `PRAGMA integrity_check` returned SQLITE_AUTH, not a transaction defect.
   Replaced only the runtime query with supported quick_check; full SQLite integrity
   assertions remain. Runtime RETURNING/guard rollback/actual executor all PASS.
2. Parent review found zero-stock projection freshness was not out_of_stock. Fixed
   and added terminal/revival/nonterminal preservation assertions.
3. Native activation in a mixed legacy-only household could block later backfill.
   Added fail-closed household adoption gate and two no-effect regressions. Two
   earlier target-specific error expectations intentionally became ADOPTION_REQUIRED.

Final post-adoption checkpoint gates and remote-worktree proof are recorded below
after execution. These are T09C checks, not completion of D–H or the full T09 gate.

## T09C published checkpoint verification — 2026-09-10

T09C_CODE_CHECKPOINT_SHA=13133b3aad214f2dbe7bdfb0c6ad9a70483d32de
This is not the final T09 application freeze. No application changes after this
checkpoint during the verification below.

| Exact executed gate | Result |
| --- | --- |
| `pnpm exec vitest run tests/unit/inventory-lot-commands.test.ts tests/unit/inventory-truth.test.ts tests/integration/inventory-lot-commands.test.ts tests/integration/inventory-lot-schema.test.ts tests/integration/inventory-lot-d1.test.mjs tests/integration/inventory-truth.test.ts` | PASS, **507 / 6 files**: 202 domain, 146 native repository, 25 schema, 4 actual D1, 130 T08 |
| `pnpm test` | PASS, **1,994 / 93 files**, 13:52:05 UTC start, 68.78s |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS, both web/test and Worker projects |
| `pnpm build` | PASS, web + Worker; no deployment |
| `pnpm check:migrations` | PASS, clean 24-migration chain |
| `pnpm schema:check:local` | PASS, final 0024 guards and FK checks |
| `pnpm wrangler d1 migrations apply frigo-db --local` | PASS, fresh 24/24 chain after preserving initial proof DB |
| Populated 0023 -> 0024 / query plans | PASS in schema integration tests |
| `git diff --check`; T08-base-to-head `--check` | PASS |

Trusted publish/fetch returned 13133b3; local HEAD equality PASS. Fresh fetch also
confirmed unchanged T08 8f8788c and main d1b0673. A separate detached worktree at
`/tmp/frigo-t09-remote-check` was created from fetched origin/T09 and ran the same
**507 tests / 6 files PASS** (13:51:53 UTC). Only the frozen installed node_modules
was temporarily shared via symlink; it was removed afterward and the worktree's
status/diff were clean. No source from uncommitted primary files was used.

Protected-path comparison against T08: routes, web, workflows, wrangler config
and payment migration unchanged. No hosted-CI PASS is claimed; branch push filters
do not select this feature branch, and no PR or workflow was dispatched.
All remaining work is D–H: native authority review/hardening, FEFO, explicit
adoption/all-writer integration, complete races/tenancy, final freeze and review.

## T09D final local verification — 2026-09-10

Scope: native receipt/idempotency/event authority, not FEFO or live writer cutover.
Code checkpoint publication receipt follows; final T09 application is NOT FROZEN.

| Exact executed gate | Result |
| --- | --- |
| `pnpm exec vitest run tests/unit/inventory-lot-commands.test.ts tests/unit/inventory-truth.test.ts tests/integration/inventory-lot-commands.test.ts tests/integration/inventory-lot-schema.test.ts tests/integration/inventory-lot-d1.test.mjs tests/integration/inventory-truth.test.ts tests/integration/inventory-lot-authority.test.ts tests/integration/inventory-event-authority.test.ts` | PASS, **1,031 / 8 files**, 14:37:38 UTC, 52.87s |
| `pnpm test` | PASS, **2,518 / 95 files**, 14:37:02 UTC, 131.95s |
| `pnpm lint` | PASS, final code |
| `pnpm typecheck` | PASS, both projects, final code |
| `pnpm build` | PASS, web + Worker, no deployment |
| `pnpm check:migrations` | PASS, clean **26-migration** replay |
| `pnpm wrangler d1 migrations apply frigo-db --local` | PASS twice: additive 0025, then additive 0026; earlier applied migrations unchanged |
| `pnpm schema:check:local` | PASS, final 0026 event/poststate guards and FK checks |
| Populated 0024 -> 0025 -> 0026 | PASS in schema suite: retained stock/receipts/events unchanged byte-for-byte at both steps; historical unassociated events remain writable |
| `git diff --check`; protected-path comparison against T08 | PASS; routes/web/workflows/wrangler/payment migration/lockfile/settings unchanged |

Focused breakdown: 202 command-domain + 130 T08 + 146 native persistence +
26 schema + 25 actual local D1 + 306 receipt authority + 196 event authority.
D adds **524 tests** relative to C. Existing inventory/scan/shopping/cook/Week and
other regressions remain included in the full suite. Runtime D1 uses the actual
repository, a test-only pre-write barrier, isolated local binding, and no remote DB.

Corrected review findings (not deferred):

1. Matching fingerprint with valid-JSON `null`/`{}` or misbound retained receipt
   could return successful replay. Strict result/header/effect/event validation
   now returns sanitized CORRUPT_RECEIPT, including collision/response-loss recovery.
2. A no-op receipt or unrelated owned lot could acquire a command-associated event.
   0025 binds new event evidence to the declared effect and original envelope.
3. Matching forged receipt/event quantities could still disagree with written stock
   (USE 2, real 8, evidence 7). 0026 binds poststate and core projection at insert;
   replay also validates quantity intent. Paired corruption now rolls back on real
   D1 and SQLite. Independent review reran the reproducer and verified clean retry
   and replay return 8000/-2000. No remaining blocking finding in the reviewed D fixes.

Early gates (1,003 focused and 2,490 full) passed before finding 3; they are not
the final verification. Final results above supersede them. No failing check is
left unresolved. Wrangler's installed-version update warning is nonfatal; no
unrelated dependency upgrade was made. Logs retained privately under
`.hoplite/artifacts/t09-d-final-{focused,full-tests,build}.log`.

No HTTP exposure or UI change; no browser proof is claimed. No PR/CI workflow
dispatch, main mutation, legacy access, staging/production, remote D1 or PayOS
operation. E–H and final independent-review readiness remain pending.

## T09D publication and fetched-source receipt

T09D_CODE_CHECKPOINT_SHA=b036b257a8ad775dd6f1a445dcfdcce38a6babf1

Trusted publish and explicit branch fetch both returned that exact SHA; shell
comparison to local HEAD and origin/T09 PASS. Fresh authorized fetch also returned
unchanged T08 8f8788c1a0c9e486657751ef3875a5baa5334dec and main
d1b06732f8a80db4e77986df31ff28d9f04641fa. No remote reference outside the canonical
development repository was accessed or changed.

Created a separate detached worktree from fetched origin/T09 at
`/tmp/frigo-t09d-remote-check-LW4gBc`. Ran the exact eight-file focused command above:
**1,031 / 8 files PASS**, 14:44:39 UTC, 36.33s. `pnpm typecheck` PASS for both
projects. Only installed frozen-lockfile dependencies were shared temporarily by
node_modules symlink; source came entirely from fetched Git. Removed the symlink;
`git diff --exit-code b036b25` and empty `git status --porcelain` PASS.
Log: `.hoplite/artifacts/t09-d-remote-verification.log`.

D is complete as a published native-authority milestone. This following
documentation-only receipt records its SHA and does not alter the verified code.
Latest docs HEAD resolves through Git; no final T09 application-freeze SHA or
READY FOR INDEPENDENT REVIEW claim is made. Next implementation phase: T09E FEFO.

## 2026-09-11 — continuation baseline

Current remote identity green-1a/frigo-dev; frozen D base 811f7e8463303e010199741d66f88ab8a817212d.
User-authorized writable successor hoplite/orchemenos-e002591e has exact base
ancestry. Fresh checks: frozen install PASS, 835+196 tests / eight files PASS
(including 25 actual isolated D1 tests), typecheck PASS. Exact commands and
correction of the initially misnamed event-authority filter: CONTINUATION.md.
No application changes or fresh full-suite/CI claims. Docs-only publication proof
must precede E implementation; base publication denial is preserved in that file.

## 2026-09-11 — T09E local implementation and corrected review findings

Publication-first successor docs: `8bf32ed4e41ed3341215c6376e0c13ef13043616`,
published/fetched before E code on `hoplite/orchemenos-e002591e` in green-1a/frigo-dev.
Frozen D base: `811f7e8463303e010199741d66f88ab8a817212d`; merge-base equality
PASS. E source is uncommitted; final independent review/regates and publication
remain pending. This section does not declare E complete or T09 review-ready.

Implementation: pure deterministic FEFO USE plus one atomic 1–32-effect batch;
version-2 ordered receipt/event evidence; additive 0027 retains v1 predicates.
Exact g/ml/piece, kg/l normalization, contextual-unit rejection, 1,000-row snapshot
bounds, 16 KiB fingerprint and 256 KiB receipt/event JSON bounds are explicit.
No single-lot commit loop, adoption, live writer, HTTP, read or UI cutover.

Corrected findings (earlier failing evidence remains under
`.hoplite/artifacts/t09-takeover/`):

1. Real D1 rejected the first authority expression with `Expression tree is too
   large (maximum depth 100)` although SQLite accepted it. Split validation into
   bounded statements without removing checks; actual D1 v1/v2 regressions and
   maximum 32-effect execution pass after correction.
2. Missing JSON/type checks could evaluate to SQL NULL rather than rejection.
   Explicit presence/type and NULL-safe predicates now reject missing, malformed,
   duplicate and forged evidence; valid reordered object-key controls still pass.
3. Replay review P1: a retained FEFO fingerprint with the wrong result envelope
   could be classified as a payload conflict before corruption was diagnosed.
   Fingerprint mode now selects/validates the stored result envelope before payload
   comparison. Genuine valid v1 key collisions still return IDEMPOTENCY_CONFLICT;
   misbound envelope returns CORRUPT_RECEIPT without effects or repair.

### Post-replay-fix gates inspected from completed logs

Focused selection (11 files):

```sh
pnpm exec vitest run tests/unit/inventory-lot-commands.test.ts tests/unit/inventory-truth.test.ts tests/integration/inventory-lot-commands.test.ts tests/integration/inventory-lot-schema.test.ts tests/integration/inventory-lot-d1.test.mjs tests/integration/inventory-truth.test.ts tests/integration/inventory-lot-authority.test.ts tests/integration/inventory-event-authority.test.ts tests/unit/inventory-fefo.test.ts tests/integration/inventory-fefo.test.ts tests/integration/inventory-fefo-schema.test.ts
```

| Command / evidence | Result |
| --- | --- |
| Focused selection above; `t09e-final/focused.log` | PASS **1,170 / 11 files**, start 01:50:44 UTC, 92.07s |
| `pnpm test`; `t09e-final/full.log` | PASS **2,657 / 98 files**, start 01:53:02 UTC, 170.79s; completion summary inspected, not inferred from progress |
| `pnpm lint`; `t09e-final/lint.log` | PASS |
| `pnpm typecheck`; `t09e-final/typecheck.log` | PASS, both projects |
| `pnpm build`; `t09e-final/build.log` | PASS, Vite + Worker TypeScript; no deployment |
| `pnpm check:migrations`; `t09e-final/check-migrations.log` | PASS, `migration-smoke=ok`, current 27-migration chain |
| Isolated local D1 apply log, `t09e-final/d1-apply.log` | PASS, all 27 migrations; local store `t09e-final/d1`, no remote DB |
| `pnpm exec wrangler d1 execute frigo-db --local --persist-to .hoplite/artifacts/t09e-final/d1 --file scripts/d1-schema-gate.sql --json` | PASS, read-only docs-agent rerun returned `success: true`, empty violation results |

Artifact paths above are relative to ignored `.hoplite/artifacts/`; they are not
committed artifacts or hosted-CI evidence. Focused count breakdown: 202 command
unit, 76 truth unit, 146 command repository, 26 lot schema, 34 actual D1, 54 truth
integration, 306 receipt authority, 196 event authority, 20 FEFO unit, 34 FEFO
repository and 76 FEFO schema. The prior 1,031 baseline already includes 25 D1
tests; the increase is 20 + 34 + 76 + nine additional D1 tests, not 34 extra D1.
Populated 0026 -> 0027 preservation and unchanged v1 behavior are covered in schema
and regression tests. No temporary/duplicate migration files remain in `migrations/`.

### Later ordered-receipt fence — separate, not covered by the earlier full run

A reordered and renumbered receipt/event pair could contradict the intended
allocation order while retaining participants/poststate. The completion fence now
compares the complete stored ordered receipt to the intended result using JSON-tree
equality before commit. One new schema regression raises that file to 77 tests.

```sh
pnpm exec vitest run tests/unit/inventory-fefo.test.ts tests/integration/inventory-fefo.test.ts tests/integration/inventory-fefo-schema.test.ts
```

PASS **131 / 3 files** (20 + 34 + 77), start 01:59:53 UTC, 28.87s;
`.hoplite/artifacts/t09e-final/ordered-fence.log`. Do not relabel the earlier
1,170/2,657 totals as post-fence full verification or invent 1,171/2,658 results.
Final full/static/D1 regates and independent review of the latest fence remain
pending before E publication.

Docs-agent verification also executed:

```sh
git diff --check
git diff --exit-code 811f7e8463303e010199741d66f88ab8a817212d -- migrations/0023_inventory_truth_foundation.sql migrations/0024_inventory_lot_commands.sql migrations/0025_inventory_event_authority.sql migrations/0026_inventory_event_poststate.sql
git rev-parse HEAD origin/hoplite/orchemenos-e002591e origin/hoplite/euhesperides-d77023a5
git merge-base HEAD origin/hoplite/euhesperides-d77023a5
```

Diff checks PASS; HEAD/tracking successor both 8bf32ed4e41ed3341215c6376e0c13ef13043616;
base and merge-base both 811f7e8463303e010199741d66f88ab8a817212d. These last
read-only Git checks did not fetch or publish E. No E code SHA/freeze, remote-source
test, hosted-CI or UI/browser claim is made. Next: finish E review/gates, commit,
publish only successor, fetch and verify local == remote before F. F–H remain
incomplete; no main/base push, legacy access, staging/production, remote D1, PayOS
or T10 work.
