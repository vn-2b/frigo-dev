# T09 verification (append-only evidence)

## Independent review follow-up — 2026-09-11

Published application `27427383d61930ea1b67ccbc1d69bb1cc069f931` follows the GLM
freeze on `hoplite/kydonia-2785bb72`. Review reproduced that an adopted PATCH with
a valid idempotency key could commit, then return stale `409` on an exact retry
because the route checked the legacy version before the native receipt. The fix
reads and validates the retained canonical CORRECT receipt first; exact retries
return 200 replay, altered payload/version reuse returns `IDEMPOTENCY_CONFLICT`, and
a distinct key still requires the current version. Regression suite: 43/43 across
adoption/writer-fence/concurrency tests PASS. Full `pnpm test`: 2,838/2,838 tests / 105
files PASS (165.25s). `pnpm lint`, `pnpm typecheck`, `pnpm check:migrations`, and
`pnpm build` PASS. No remote D1, deployment, payment, or T10 work occurred.

## Clean-checkout verification — 2026-09-11

Separate worktree created from the exact published remote SHA `9bf9ac0fe7b5e0d39615f39ae5cc30f84569af2f`
(origin/hoplite/kydonia-2785bb72); `pnpm install --frozen-lockfile` with no lockfile
change. Clean typecheck PASS (both projects). Clean focused T09 gate: **716/716
tests / 10 files PASS** (adoption, concurrency, writer fence, FEFO, native commands,
lot authority, event authority, real local D1, truth/schema). Remote SHA == local
clean SHA equality: PASS. The result does not depend on dirty local state.

## T09F/T09G/T09H final verification — 2026-09-11

Application freeze: `9bf9ac0fe7b5e0d39615f39ae5cc30f84569af2f`, committed and published on **hoplite/kydonia-2785bb72**
in canonical `vn-2d/frigo-dev` (platform refused publication to the configured base
`hoplite/kos-2a686759`, which stays read-only at `aa44d2a2f80ea33fd4b328aba906660c0129051e`); fetched equality
local == remote PASS. Branch ahead of main `d1b0673` by 22, behind 0 (recalculated).

Implemented in this checkpoint: atomic receipt-backed adoption (executor + 0028),
empty-household activation evidence, fail-closed writer admission for every
inventory mutation, functional adapters for manual/scan/shopping/cook writers on
adopted households, composed edit+move, FEFO-ordered cook allocation, and the G
concurrency/tenancy matrix with property sweeps.

Executed fresh gates (this workspace, Node 24/pnpm 10):
- `pnpm test`: **2,837/2,837 passed, 105 files PASS**, 155.11s; 0 failed, 0 skipped.
- `pnpm exec vitest run tests/integration/inventory-lot-d1.test.mjs`: 38/38 PASS
  (isolated real local D1 via wrangler unstable_dev; full schema replay).
- `pnpm lint`: PASS. `pnpm typecheck`: PASS (both projects).
- `pnpm build`: PASS (vite + worker tsc).
- `pnpm check:migrations`: PASS — 28-migration replay smoke.
- `pnpm schema:check:local`: PASS — required migrations 0001–0028, inventory truth,
  lot command/event authority guards, foreign keys valid (after clean local
  `wrangler d1 migrations apply`; remote D1 never touched).

Known limitations (explicit): adoption receipts are a separate versioned table, so
adoption effects do not write inventory_events rows (receipt carries the full
before/after evidence instead); first native command on a legacy kg/l row rewrites
the projection to canonical units (quantity preserved exactly); cook uses FEFO-ordered
per-lot USE receipts rather than the single-ingredient FEFO command because cook
deductions may be name-keyed and multi-ingredient; PATCH replay after a committed
edit returns 409 CONFLICT at the version preflight (legacy contract). DEC-012 guest
transfer remains SAFE-DEFERRED.

## Transferred-repository F recovery checkpoint — 2026-09-11

Application: `aa43e069edbff7843e9eb7532ff386b27be96a17`, published/fetched on
`hoplite/kos-2a686759` in canonical `vn-2d/frigo-dev`. Recovery documentation
`2b138cc567cb81eef9bab16e24d6dbd60b296814` was published before source changes.
Exact fetched equality and `66858c5` ancestry passed. Required prior continuation,
frozen D and main remained `66858c5`, `811f7e8`, `d1b0673` respectively. Application
ahead/behind current main: 20/0. Full transfer proof and baseline: CONTINUATION.md.

Implemented: pure adoption preflight/plan, full projection/source preservation,
32-effect and 1,000-row limits, independent mapping/legacy versions, explicit
terminal-zero evidence, detached deterministic outputs and empty activation intent.
No adoption persistence or activation. Legacy manual/scan/shopping/cook batches now
refuse mapped authority atomically. Scan/shopping capture/recheck stock revision
while their source predicate allows writes. Shopping validates raced first claims,
preserves expired-lease winner replay and recovers post-COMMIT results. Server-scan
recovery retains original path/body/owner after fetch/body transport loss without
inventing manual additions or cached stock. DEC-012 unchanged.

Executed at this application tree:

```sh
pnpm exec vitest run tests/unit/inventory-lot-commands.test.ts tests/unit/inventory-truth.test.ts tests/unit/inventory-fefo.test.ts tests/unit/inventory-adoption.test.ts tests/integration/inventory tests/integration/scan-response-loss.test.ts tests/integration/shopping-command-race.test.ts tests/unit/sync.test.ts tests/unit/command-route-integrity.test.ts tests/integration/week-core-flow.test.ts
pnpm test
pnpm lint
pnpm typecheck
pnpm check:migrations
pnpm build
git diff --check
git diff --exit-code 66858c5296b38715e4bfca77fca5eefe5adadf5a -- migrations src/worker/routes/auth.ts src/worker/routes/billing.ts src/worker/routes/payments.ts .hoplite/settings.json pnpm-lock.yaml .github wrangler.jsonc
```

- Combined focused: **1,347 / 19 files PASS**, 04:15:49 UTC, 134.83s.
- Full: **2,808 / 103 files PASS**, 04:16:19 UTC, 189.92s.
- All listed static/build/migration/diff gates PASS; 27 migrations unchanged.
- Includes **38 actual isolated local-D1 tests** (35 prior + 3 fence cases),
  70 adoption-planner cases, 13 writer-fence HTTP/race cases and 8 shopping
  claim/lease/response-loss cases across legacy and dual Week modes.
- Scoped independent review: two P2 findings repaired and re-reviewed; **144 tests
  / six files**, typecheck and diff check PASS on re-review. No remaining P1/P2
  in this partial increment. This is not a final T09 independent-review verdict.
- Logs: ignored `.hoplite/artifacts/t09-recovery/` (`focused-final.log`,
  `full-final.log`, `static-final.log`, earlier failure logs).

Failures and corrections (retained, not hidden):

1. First new writer test run: 4/11 failed due to invalid new fixtures (missing scan
   user, wrong cooking quantity field/parameterization, wrong shopping table name).
   Corrected to actual contracts; no product assertion relaxed.
2. First full recovery run: 4 failed / 2,704 passed, 101 files. The command-route
   fake selected the newly prepended abort-fence INSERT as a successful effect
   event. Fixed fake statement handling and added an assertion for the real stable
   effect ID; all replay/conflict assertions retained. Real SQLite replay passed.
3. First expanded D1 run: 2 failed / 49 passed because new populated tests preceded
   existing empty-database assertions. Moved new cases after the original baseline;
   original assertions unchanged. Rerun: 51/51 across D1 and HTTP fence files.
4. Adoption boundary tests initially exposed three planner failures; added derived
   collection bounds and duplicate catalog-ID guards. Final adoption suite: 70 PASS.
5. Independent review reproduced stale shopping lease / lost committed-response
   misclassification. Source-predicate admission and durable replay recovery fixed
   both; executable regression coverage includes both Week modes.
6. Review reproduced a scan response-body disconnect after headers/commit. Scoped
   confirmation transport handling now covers TypeError/AbortError; malformed JSON,
   HTTP failures, owner changes and cache-write exceptions do not queue recovery.
7. A child accidentally used unfiltered `pnpm test -- …` during planner work and
   canceled it. No result is claimed for that canceled command.

Still incomplete: v3 atomic adoption/activation, functional mapped-household writer
adapters, retained scan confirmation intent/result validation (2→9 retry currently
falsely replays), membership/source matrix, contextual cook policy, G and H. No
freeze, readiness, production/staging/remote-D1/PayOS/main/T10 claim or operation.

### F safety checkpoint clean fetched-source proof

`git worktree add --detach .hoplite/artifacts/t09-recovery/remote-checkout origin/hoplite/kos-2a686759`
resolved exact `aa43e069edbff7843e9eb7532ff386b27be96a17`, after a trusted fetch.
Inside that separate tree, `pnpm install --offline --frozen-lockfile`,
`pnpm typecheck`, and the exact combined focused command above all PASS:
**1,347 tests / 19 files**, 04:21:15 UTC, 92.13s. `git status --porcelain` was
empty and `git rev-parse HEAD` matched the fetched application. Logs:
`remote-install.log`, `remote-typecheck.log`, `remote-focused.log` in recovery
artifacts. This is fresh checkpoint verification, not a final H freeze.

## F guest-safety final prepublication gates

Current F safety application tree: `pnpm test` **PASS 2,685 / 99 files**,
02:21:16 UTC, 159.97s. Log `.hoplite/artifacts/t09f-guest/full.log`. This includes
all 1,172 E focused cases, the 25 new guest route cases and the new outbox case.
`pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm check:migrations` and
`git diff --check`: all PASS (logs in the same directory).

`git diff --exit-code 9bd1e6bc000cd2e94121469babb1a5eb63a5047f -- migrations packages/db packages/domain .hoplite/settings.json pnpm-lock.yaml`
PASS: no native/schema/setup/dependency changes in this bounded F checkpoint.
The only application changes are removal/deferral of the guest transfer path and
the schema's explanatory comment. Other auth, Week, inventory, scan, shopping,
cook and payment paths are unchanged. Full regression tests include their
existing coverage; no real payment, remote D1, deployment or live service used.

This is an intermediate F safety checkpoint, not the required completed F
adoption/writer milestone. Next: publish this verified checkpoint, then implement
explicit adoption and every remaining live-writer adapter before G/H acceptance.

## Published E source-isolation proof

Created detached worktree `.hoplite/worktrees/t09e-9bd` from fetched
`origin/hoplite/orchemenos-e002591e` at E SHA `9bd1e6bc000cd2e94121469babb1a5eb63a5047f`.
Reused installed lockfile dependencies through a temporary node_modules symlink;
this is fresh-source verification, not a second dependency-install claim.
Executed the same 11-file focused command then `pnpm typecheck`: **1,172 PASS**,
02:15:43 UTC, 82.44s, both TS projects PASS. Log:
`.hoplite/artifacts/t09e-publish/remote-worktree.log`. Removed the temporary
dependency symlink, confirmed clean source with `git status --short`, then
removed the detached verification worktree. No application branch was created.

## F guest safety focused proof — 2026-09-11

```sh
pnpm exec vitest run tests/unit/sync.test.ts tests/unit/auth.test.ts tests/integration/auth-hardening.test.ts tests/integration/auth-me-quota.test.ts tests/integration/inventory-guest-transfer.test.ts
```

PASS **143 / 5 files**, 02:20:47 UTC, 8.96s. Breakdown: guest transfer 25,
auth hardening 72, auth-me/quota 17, JWT/auth unit 19, sync/outbox 10. Log:
`.hoplite/artifacts/t09f-guest/focused-final.log`. Initial run was 142 PASS / one
new sync assertion failure: existing `ApiError` carries response JSON/code in
`message`, not a `code` property. Corrected the test to assert actual unchanged
`kind`, status and code-bearing message; no HTTP transport behavior was weakened.

All requested guest transfers reject before OTP consumption/account activation/
session creation, stock/history ownership changes and business cache operations.
Existing rate-limit bookkeeping remains active. Ordinary non-migration verify and
forgot-password/reset controls PASS. This does not implement general adoption or
manual/scan/shopping/cook authority migration. Full/static checkpoint gates are
recorded in the subsequent receipt; F/G/H completion is not claimed here.

## T09E publication receipt

Committed E `9bd1e6bc000cd2e94121469babb1a5eb63a5047f`, published through the
trusted broker to `hoplite/orchemenos-e002591e` using the prior remote lease
`8bf32ed4e41ed3341215c6376e0c13ef13043616`, fetched, then executed equality and
ancestry assertions. Both `git rev-parse HEAD` and remote tracking HEAD returned
the E SHA; merge-base remained `811f7e8463303e010199741d66f88ab8a817212d`; tree
was clean. This completed the required E publication gate before F code.

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
