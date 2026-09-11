# T09 final targeted PATCH verification — 2026-09-11

## Current authority — FEFO v2 backfill compatibility

| Field | Current value |
| --- | --- |
| Repository / branch | `vn-2e/frigo-dev` (live origin `vb-2f/frigo-dev`) / `hoplite/himera-6d3eda84` (successor at docs HEAD `8552fe5337245f2ac8349933c02946bf7d9dcc8f`; kydonia tip unchanged) |
| Starting docs HEAD | `8552fe5337245f2ac8349933c02946bf7d9dcc8f` |
| Historical GLM freeze | `9bf9ac0fe7b5e0d39615f39ae5cc30f84569af2f` |
| Historical Astra replay fix | `27427383d61930ea1b67ccbc1d69bb1cc069f931` |
| Historical PATCH parity freeze | `e796f695bdb4228853992cdedc4e3cecf3437adb` |
| Previous backfill PATCH freeze | `df73bc035c2938b6fd082c57f6bca89a82d8e443` |
| **New final FEFO application freeze** | **`bf391c5fdcdd9e9c2f2257db515815e082cb4381`** (published/fetched, local == remote) |
| Docs HEAD | Following docs-only commit containing this section; exact fetched SHA in the final operator report |
| Main | `d1b06732f8a80db4e77986df31ff28d9f04641fa` (unchanged) |
| Ahead / behind main | Start 29/0; application 30/0; following docs checkpoint 31/0 |
| P1 reproduction | REPRODUCED — 13/13 new tests fail `DRIFT_DETECTED` at `prepareInventoryFefoCommand:818` on the pre-fix tree, zero mutation |
| Equal-ID assumptions found | TS admission guard; TS replay `legacyItemId === after.id`; TS lot CAS default; SQL 0027 receipt `l.id IS NOT l.legacy_item_id` + strict prestate parity; SQL 0027 event `l.id = l.legacy_item_id` |
| Migration decision | 0029 ADDED — TS-only fix insufficient: 0027's v2 receipt/event triggers abort synthetic inserts at the SQL boundary |
| Verdict | **READY FOR FINAL MAIN MERGE REVIEW** — no P0/P1 or known merge-blocking P2 remains |

### FEFO identity model

- Native lot identity: `inventory_lots.id` (for example `t08-legacy:patch-rice`).
- Projection identity: `inventory_lots.legacy_item_id` → `inventory_items.id`
  (for example `patch-rice`); FEFO events reference the projection identity.
- Authoritative mapping evidence: the immutable 0028 adoption receipt effects
  (`lotId`, `legacyItemId`, `after`, `projectionAfter`) bound to household/actor/
  source version, checked by TS `requireParity`/`authoritativeMapping` admission
  and replay, and independently by the 0029 SQL mapping guards (provenance, source
  identity, createdAt, version ceiling and preserved `version - legacy_version`
  offset). Never name/ingredient/quantity/household-only or caller-provided IDs.

### Executed verification (exact)

- Reproduction (pre-fix tree): `pnpm exec vitest run
  tests/integration/inventory-backfilled-fefo.test.ts` — 13 failed (13),
  all `DRIFT_DETECTED` at `prepareInventoryFefoCommand:818`, facts unchanged.
- Focused (fixed tree): 15 files listed in the packet — **1,237/1,237 PASS**
  (59.52s), including the new 13-test backfilled-FEFO matrix, the extended
  78-test FEFO schema authority suite and all native FEFO/PATCH/adoption/
  concurrency/writer-fence suites.
- Full: `pnpm test` — **2,926/2,926 PASS, 108 files, 118.20s**.
- `pnpm lint` PASS; `pnpm typecheck` PASS; `pnpm build` PASS.
- `pnpm check:migrations` PASS — 29 migrations replay (0028 was previously missing
  from the smoke and is now included with 0029; adoption objects asserted).
- `pnpm exec wrangler d1 migrations apply frigo-db --local` — all 29 applied.
- `pnpm schema:check:local` PASS (requires 0029).
- `pnpm exec vitest run tests/integration/inventory-lot-d1.test.mjs` —
  **44/44 PASS** (real workerd/D1, both trees).
- `git diff --check` clean.
- Clean detached checkout at exact remote `bf391c5fdcdd9e9c2f2257db515815e082cb4381`: frozen install (1.9s);
  full **2,926/108 PASS (119.10s)**; lint/typecheck/build PASS; 29-migration
  smoke PASS; local D1 apply + schema gate PASS; **44/44 D1 PASS**;
  `git diff --check` clean; `git status --porcelain` **empty**.
- GitHub CI: **NO GITHUB CI STATUS** (zero runs for the branch).

### Failure chronology corrected during this task

1. First 0029 draft nested the new mapping/parity predicates inside 0027's deep
   guards; node:sqlite accepted it but real D1 aborted every receipt insert with
   `D1_ERROR: Expression tree is too large (maximum depth 100)` (SQLite compiles
   all trigger bodies when preparing inserts). Restructured into separate shallow
   trigger statements; bisected through the D1 worker; all D1 tests then passed.
2. The FEFO lot CAS defaulted `legacy_item_id` to the native lot ID, so synthetic
   updates matched zero rows (`STALE_VERSION`); fixed by binding the mapped
   projection identity, mirroring the v1 executor.
3. Migration-head assertions in three suites and the migration smoke/gate were
   extended from 28 to 29 migrations (0028 was never in the smoke; now included).

## Historical PATCH authority — superseded by bf391c5

| Field | Current value |
| --- | --- |
| Repository / branch | `vn-2e/frigo-dev` / `hoplite/kydonia-2785bb72` |
| Starting docs HEAD | `f06289b8d440071b213604c360b8839dbbf350cb` |
| Historical GLM freeze | `9bf9ac0fe7b5e0d39615f39ae5cc30f84569af2f` |
| Historical Astra first replay fix | `27427383d61930ea1b67ccbc1d69bb1cc069f931` |
| Historical PATCH parity freeze | `e796f695bdb4228853992cdedc4e3cecf3437adb` |
| **Final backfill compatibility application freeze** | **`df73bc035c2938b6fd082c57f6bca89a82d8e443`** |
| Docs HEAD | Following docs-only commit containing this section; exact fetched SHA in the final operator report |
| Main | `d1b06732f8a80db4e77986df31ff28d9f04641fa` (unchanged) |
| Ahead / behind main | Start 27/0; application 28/0; following docs checkpoint 29/0 |
| Verdict | **NOT READY FOR MAIN** — backfilled PATCH P1 fixed; shared v2 FEFO limitation remains |

Startup remote/status/branch/HEAD/main/merge-base/count/log and every requested
ancestor passed. Application publish → fetch → exact local/remote equality passed.
No history rewrite, successor, merge, deployment, remote D1, PayOS, guest transfer
or T10 operation. `.hoplite/settings.json` remained uncommitted, SHA-256
`6d8f5b45041a5f41bfa6463a5f88fe1e0f5602822ecb403a5d949961f00bbee7` unchanged.

### P1 reproduction and root cause

**REPRODUCED before editing application source.** Permanent regression file
`tests/integration/inventory-backfilled-patch.test.ts` creates an authorized household
and `patch-rice` (RICE, 2000 g, grain, pantry, projection version 1), executes real
adoption, and verifies `t08-legacy:patch-rice → patch-rice`, lot version 2 / legacy
version 1. Both variants—adoption-created snapshot and existing T08 backfill—returned
`500 {error:"DRIFT_DETECTED",code:"DATABASE_ERROR"}` for category-only PATCH.
The initial two tests failed on unchanged e796f69 application source at f06289b.

Root cause was the invalid equal-ID predicate in `requireParity`, plus equal-ID
assumptions downstream in lot CAS, event projection ID, replay and composed snapshot
advancement. Removing only the first check would not produce a correct atomic command.

### Proven identity model and minimal fix

- 0024 defines `inventory_lots.legacy_item_id REFERENCES inventory_items(id)` and
  the unique non-null projection mapping. Its live triggers enforce same-household
  ownership and immutable lot/mapping/provenance identity after activation.
- T08's `legacyInventoryToLot` intentionally generates a deterministic synthetic
  lot ID and retains the projection ID in `sourceId`. Actual adoption records
  `lotId`, `legacyItemId`, before/after lots and projections in one retained v3
  receipt, committing that witness with its exact mapping and poststate fence.
- v1 SQL in 0027 joins `NEW.inventory_item_id` through `legacy_item_id`, while
  command/result/effect IDs name the native lot. Its v1 guards already support
  the distinct IDs: **no migration is needed for this PATCH fix**.

The only application file changed is `packages/db/src/inventory-lot-commands.ts`:
bounded v3 mapping evidence is checked against household/actor/source-version,
unique exact deterministic lot/projection IDs and backfill provenance. Current
version advancement is checked against the retained adoption offset. Live parity
still checks ingredient/reference, name, exact quantity/display-unit compatibility,
location, projection version, expiry, opened state and lot lifecycle. Mutable stock
is compared to its current projection, never forced back to the historical snapshot.

Lot CAS and event columns now use the validated projection ID. Command/effect IDs
remain native lot IDs. Replay authenticates the historical mapping, and composition
advances that projection rather than constructing a duplicate virtual row.
No caller-supplied mapping, arbitrary household row, name/ingredient matching, repair
fallback or weakened tenant guard was introduced. Existing native equal-ID stock
retains its behavior. Migrations 0023–0028, adoption executor and routes are unchanged.

### Backfilled PATCH, drift and tenancy matrix

| Requirement | Result / durable assertions |
| --- | --- |
| Category-only, existing/missing T08 snapshot | PASS; category, lot/projection versions, mapping and receipt/event IDs |
| Quantity | PASS; exact native milli and projection quantities; one row/lot only |
| Storage | PASS; location and projection storage, unchanged mapping |
| Combined quantity/category/storage/expiry | PASS; all fields and both CORRECT/MOVE receipts/effects |
| Exact replay, including after later stock changes | PASS; original result, no duplicate command/event/effect |
| Changed category/storage/quantity/version under same key | PASS; 409 IDEMPOTENCY_CONFLICT, no mutation |
| Distinct-key stale CAS | PASS; 409 CONFLICT, no mutation |
| Zero-row category write, late MOVE failure, poststate metadata corruption | PASS; all effects roll back |
| Error thrown after commit | PASS; receipt-backed recovery, no second mutation |
| Legacy kg display | PASS; exact canonical conversion, identity retained |
| Foreign actors and caller-selected foreign projection/native IDs | PASS; FORBIDDEN/404, no foreign data or changes |
| Tampered null/nonexistent/foreign mapping | PASS; database guards reject; state unchanged |
| Corrupted same-household/foreign/missing mapping or projection | PASS; fails closed, not silent repair |
| Ingredient/quantity/storage/unit/version/name/expiry/opened drift | PASS; DRIFT_DETECTED and unchanged durable state |
| Invalid state/ingredient reference | PASS; fails closed |
| Missing/mismatched adoption effect, lot, projection, household or source | PASS; no synthetic admission |
| Shared v1 USE/DISCARD/OPEN/MOVE and replay | PASS; native/projection identities and evidence retained |
| Original native equal-ID PATCH suite | PASS, all 25 tests unchanged |

New permanent backfill suite: **43 tests**. Test-only local-D1 harness adds actual
adoption; two new workerd/D1 cases verify category-only and combined synthetic
mapping writes/replay under the unchanged real SQL guards.

### Bounded shared-caller check and remaining P1

`requireParity` has only single-lot and FEFO preparation callers. The common v1
paths are covered above. **v2 FEFO is separately incompatible with synthetic IDs**:
0027 receipt prestate line 270 rejects `l.id IS NOT l.legacy_item_id`, event
poststate line 453 requires `l.id = l.legacy_item_id`, and retained v2 replay also
requires equal IDs. These are unchanged authority contracts, not merely a TypeScript
predicate that this task can safely remove.

An explicit FEFO preflight restriction now preserves the former fail-closed behavior
after shared parity is corrected. A real-adoption regression verifies FEFO returns
DRIFT_DETECTED with no stock/receipt/event changes. That test is a boundary proof,
**not a claim that FEFO/cooking on backfilled stock works**. No cook route redesign
or v2 guard bypass was attempted. Removing this separate inherited P1 requires
separately authorized additive schema compatibility work; stopped before any such
migration. No 0029 was created. This prevents a main-ready recommendation.

### Exact executed verification

Runtime: Node `v24.19.0`, pnpm `10.26.0`. Commands from repository root:

```sh
pnpm exec vitest run tests/integration/inventory-patch-parity.test.ts tests/integration/inventory-backfilled-patch.test.ts tests/integration/inventory-lot-commands.test.ts tests/integration/inventory-lot-authority.test.ts tests/integration/inventory-writer-fence.test.ts tests/integration/inventory-adoption.test.ts tests/integration/inventory-concurrency.test.ts tests/unit/command-route-integrity.test.ts tests/integration/inventory-lot-d1.test.mjs
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm check:migrations
pnpm schema:check:local
pnpm exec vitest run tests/integration/inventory-lot-d1.test.mjs
git diff --check
```

| Gate | Result |
| --- | --- |
| Required focused gate | **619/619, nine files, 48.34s**, zero failures/skips |
| Full fresh rerun | **2,910/2,910, 107 files, 168.05s**, zero failures/skips |
| Isolated actual local-D1 | **42/42, one file, 5.10s**, zero failures/skips |
| Lint / both typechecks / build | PASS |
| Migration smoke / local schema / diff | PASS; 28 migrations, none modified |
| Scoped independent review | No additional issue; **179 tests/four files, 33.95s**, zero failures/skips |
| GitHub CI | **NO GITHUB CI STATUS**; zero provider contexts/completed push runs for application SHA |

Independent reviewer executed backfilled PATCH, native PATCH, inventory FEFO and
FEFO-schema suites with `pnpm exec vitest run ... --reporter=dot`. No review edits.
CI's checked-in push filters do not include this branch; no PR/workflow/deployment
was created. Local gates are not described as hosted CI.

### Clean exact remote application checkout

After publishing and fetching `df73bc035c2938b6fd082c57f6bca89a82d8e443` with local
equality, created a fresh detached worktree and ran:

```sh
git worktree add --detach /tmp/frigo-t09-backfill-clean-df73bc0 df73bc035c2938b6fd082c57f6bca89a82d8e443
cd /tmp/frigo-t09-backfill-clean-df73bc0
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm check:migrations
pnpm exec wrangler d1 migrations apply frigo-db --local
pnpm schema:check:local
pnpm exec vitest run tests/integration/inventory-lot-d1.test.mjs
git diff --check
git status --porcelain
```

**All PASS at exactly df73bc035c2938b6fd082c57f6bca89a82d8e443.** Frozen install
did not alter the lockfile. Full suite **2,910/107, 163.39s**, zero failures/skips.
Lint/typecheck/build/migration smoke passed; all 28 migrations applied to this
worktree's fresh **local-only** D1 and schema passed. Isolated D1 rerun **42/one file,
5.17s**, zero failures/skips. Final porcelain status empty.

### Failed attempts and recoveries

- The initial two permanent backfill tests failed at the intended 500 response
  before source edits. After the fix, their event assertion initially included
  migration-seeded events from another household; corrected to assert only this
  fixture's household, with no production change.
- First full run: 2,910 tests/107 source files passed, but an extra suite failed
  to load. The previous turn's ignored `.hoplite/artifacts/t09-final-patch/backfill-probe.test.ts`
  archive was discovered by Vitest, with invalid relocated relative imports.
  Preserved its bytes as `backfill-probe.test.ts.txt`; did not alter test configuration
  or exclude source coverage. Its intended failing scenario is now permanently
  covered by the new suite. Fresh `pnpm test` and independent clean source both pass.
- Frozen install emitted the existing ignored-dependency-build-script warning;
  actual build/workerd/D1 gates passed without setup/config changes.

Local evidence logs: `.hoplite/artifacts/t09-backfill-p1/{reproduction,initial-fix,
expanded,focused,full-first-attempt,full,d1,clean-full,clean-d1,clean-d1-apply}.log`.
Historical diagnostic paths below reflect the prior checkpoint; the probe is now
archived as text, not the sole regression source.

Remaining P0: **NONE identified in this scope**. Targeted manual PATCH P1: **FIXED**.
Remaining P1: **v2 FEFO synthetic mapping compatibility**, as proven above.
Remaining relevant P2 blockers: **NONE additional identified**.
Final verdict: **NOT READY FOR MAIN**. Next action is separate authorization for
that FEFO/schema compatibility follow-up, not merge/deploy/remote D1/T10.

---

## Historical PATCH-parity authority and verdict — superseded by df73bc0

| Field | Value |
| --- | --- |
| Repository | `vn-2e/frigo-dev` |
| Branch | `hoplite/kydonia-2785bb72` |
| Start/docs checkpoint | `6999b64aff0786827637b0a85f2de28c196ca288` |
| Historical GLM freeze | `9bf9ac0fe7b5e0d39615f39ae5cc30f84569af2f` |
| Historical Astra first fix | `27427383d61930ea1b67ccbc1d69bb1cc069f931` |
| **Final application freeze** | **`e796f695bdb4228853992cdedc4e3cecf3437adb`** |
| Docs HEAD | Docs-only commit containing this report; exact SHA is returned in the final operator report and fetched branch tip |
| Main | `d1b06732f8a80db4e77986df31ff28d9f04641fa` (unchanged) |
| Ahead/behind | Start 25/0; application freeze 26/0; following docs checkpoint 27/0 |
| Recommendation | **NOT READY FOR MAIN** — targeted fixes pass, separate inherited P1 remains |

Application publish/fetch/local equality passed. All required ancestors remain in
the same lineage. No successor, rebase, force push, merge, deployment, remote D1,
PayOS, scan/shopping/cook change or T10 work occurred. Migrations are unchanged.
The external `.hoplite/settings.json` overlay remains uncommitted and byte-identical:
SHA-256 `6d8f5b45041a5f41bfa6463a5f88fe1e0f5602822ecb403a5d949961f00bbee7`.

## Findings A and B: reproduced, fixed

**A — storage replay (P1): REPRODUCED.** Before editing application source, an
activated household's native item accepted `{version:1, quantity:3, storage:"freezer"}`.
An exact retry replayed, but changing storage to `pantry` under the same key also
returned 200 replay. No request-presence evidence was retained.

**B — category parity (P2): REPRODUCED.** A category-only PATCH returned 200 while
the durable category remained `grain` and projection version remained 1 instead of
advancing to 2. It was a native CORRECT no-op that dropped projection-only intent.

Fixes are confined to the manual PATCH route, native receipt/composition support,
and targeted tests. The opt-in `manualPatch` fingerprint envelope records the
complete normalized PATCH request, category/freshness, resulting projection, and
optional MOVE receipt key in the existing immutable `inventory_commands` receipt.
Existing event metadata binds that fingerprint; no new table, ledger, migration or
change to historical v1/v2 result/event interpretation is introduced.

Category and freshness use the same guarded projection write as the lot correction.
A metadata-only manual correction advances lot/projection versions and emits a
zero-delta effect; ordinary native no-op commands without PATCH metadata are unchanged.
CORRECT and MOVE execute together; complete projection poststate guards reject
metadata drift. Replay validates the retained pair and returns its original
projection, even after a later edit, without deriving history from today's row.
Hashed operation keys keep the supported 200-character caller keys within native
key limits. Pre-fix receipts without a complete request fingerprint fail closed
on reuse rather than guessing original field presence.

| Contract | Result |
| --- | --- |
| Exact same normalized request/key | 200, `idempotentReplay:true`; no durable changes |
| Changed storage/category/version or any other supported field | 409 `IDEMPOTENCY_CONFLICT` |
| Added/removed name/quantity/unit/category/storage/expiryDate | Conflict; presence is significant |
| Omitted expiry vs explicit null | Distinguished |
| Distinct key + stale version | 409 `CONFLICT` |
| Category-only / storage-only | Durable success, coherent versions and mapping/location |
| Combined quantity/category/storage/expiry | Atomic success; failures roll back every effect |
| Foreign-household replay | 404, no response data or mutations |

Combined PATCH atomicity: **PASS**. Tests assert rows, lots, locations, versions,
receipts and events; exercise exact and changed-intent barrier races; inject a
zero-row category update, late MOVE failure and post-write metadata corruption;
and recover an error raised after COMMIT. Scoped independent re-review reported
no additional finding and executed all 25 new route tests successfully.

## Executed gates

Runtime: Node `v24.19.0`, pnpm `10.26.0`. Logs below are ignored local artifacts,
not hosted CI evidence, under `.hoplite/artifacts/t09-final-patch/`.

```sh
pnpm exec vitest run tests/integration/inventory-patch-parity.test.ts tests/integration/inventory-writer-fence.test.ts tests/integration/inventory-lot-commands.test.ts tests/integration/inventory-lot-authority.test.ts tests/integration/inventory-concurrency.test.ts tests/unit/command-route-integrity.test.ts
pnpm exec vitest run tests/integration/inventory-lot-d1.test.mjs
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm check:migrations
pnpm schema:check:local
git diff --check
```

| Gate | Fresh result |
| --- | --- |
| Focused | **515/515, six files**, 41.96s (`focused.log`) |
| New PATCH route tests | **25/25** (included above) |
| Isolated actual workerd/D1 | **40/40, one file**, 5.44s (`d1.log`); two new metadata/combined cases |
| Full repository | **2,865/2,865, 106 files**, 172.97s (`full.log`) |
| Lint/typecheck/build | PASS |
| Migration smoke | PASS, 28 migrations |
| Workspace local schema | PASS (`schema.log`); no remote operation |
| Diff/protected paths/settings hash | PASS |

The schema script's printed label still ends at 0027, but its SQL requires 0028;
the clean local replay below applied all 28. The label was not changed in this task.

## Clean detached-checkout gate

After publishing and fetching, local application SHA equaled the remote application
SHA. Created `/tmp/frigo-t09-patch-clean-e796f69` with:

```sh
git worktree add --detach /tmp/frigo-t09-patch-clean-e796f69 e796f695bdb4228853992cdedc4e3cecf3437adb
cd /tmp/frigo-t09-patch-clean-e796f69
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm check:migrations
pnpm exec wrangler d1 migrations apply frigo-db --local
pnpm schema:check:local
pnpm exec vitest run tests/integration/inventory-lot-d1.test.mjs
git diff --check
git status --porcelain
```

**All PASS at exactly `e796f695bdb4228853992cdedc4e3cecf3437adb`.** Frozen install
did not change the lockfile. Full clean suite: **2,865 tests / 106 files, 161.28s**.
Lint, both typechecks, build and migration smoke passed. Local D1 applied all
28 migrations and passed the schema gate. Isolated D1 rerun: **40 tests / one file,
5.04s**. Git status remained empty, including after local database gates.
Logs: `clean-full.log`, `clean-d1-apply.log`, `clean-d1.log`.

GitHub CI: **NO STATUS**. Provider commit-status lookup returned zero contexts;
no completed push run exists for the application SHA. The checked-in workflow
only runs push CI on main/master/codex-security branch and PRs targeting main/master;
this task did not create a PR or modify workflow triggers. Local PASS is not hosted PASS.

## Failures and remaining blocker

1. Initial reproduction fixture used a too-short test JWT secret; fixed to the
   existing authentication contract before drawing product conclusions.
2. A populated-household fixture then exposed the inherited mapping blocker below.
   The two requested findings were isolated using native stock created after empty
   adoption, matching the existing adapter test setup. Both failed for the intended
   assertions before the application fix (`reproduction.log`).
3. Expanded tests initially accumulated 60 requests under the same fixture account
   and hit 429. Each test now has a unique actor; rate-limit policy is unchanged.
   All 25 tests pass. No coverage or production guard was relaxed.
4. Frozen install emitted pnpm's ignored-dependency-build-script warning; all binary,
   build and actual workerd/D1 gates nevertheless passed without a configuration change.

**Remaining P0: NONE identified in this scope.**

**Remaining P1: inherited backfilled-lot PATCH mapping refusal.** A bounded
expected-success diagnostic still returns `500 {error:"DRIFT_DETECTED",code:"DATABASE_ERROR"}`:

1. Create an authorized household and legacy inventory row `patch-rice`, RICE,
   2000 g, category grain, pantry, version 1.
2. Execute authorized adoption. It produces the legitimate mapping
   lot `t08-legacy:patch-rice` → projection `patch-rice`, lot version 2/legacyVersion 1.
3. PATCH `/inventory/patch-rice` with `{version:1,category:"vegetable"}`.
4. `requireParity` in `packages/db/src/inventory-lot-commands.ts` rejects
   `lot.id !== legacyItemId`, even though the mapping is the adopted source identity.
   Response is 500; original row/stock remain unchanged.

That predicate predates this task and is unchanged. The diagnostic's expected 200
assertion failed (one failed / 24 unselected), retained in ignored
`backfill-probe.test.ts` / `backfill-probe.log`. It is a separately recorded failing
probe, not hidden as a passing suite test. Native equal-ID stock passes the full
targeted regression suite; backfilled stock does not. No adoption or migration
compatibility redesign was attempted. This blocker prevents a main-ready claim.

**Remaining P2: NONE additional identified in the targeted changes.**

Next action: separately authorize the inherited mapping/receipt compatibility fix,
add its failing regression, and verify the relevant versioned SQL authority before
another merge recommendation. Do not merge, deploy, alter remote D1 or start T10.
