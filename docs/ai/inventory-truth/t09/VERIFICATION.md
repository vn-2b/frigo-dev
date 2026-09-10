# T09 verification (append-only evidence)

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
