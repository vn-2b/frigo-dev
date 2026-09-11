# T09 final targeted PATCH verification — 2026-09-11

## Current authority and verdict

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
