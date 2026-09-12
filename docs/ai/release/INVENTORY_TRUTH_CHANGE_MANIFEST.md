# Inventory Truth release train — application change manifest (2026-09-12)

Scope: `git diff --numstat -M d1b06732f8a80db4e77986df31ff28d9f04641fa d15600186c3e73faba011eb690ac6cd70e8d3d2d`
(main baseline → T12 application freeze = release candidate). Docs HEAD `5cb4caa`
adds 12 more `docs/` files only. Status column: A = added, M = modified, D = deleted.
Independent classification; generated from Git, not copied from task packets.

## Summary

| Class | Files | + | − |
| --- | ---: | ---: | ---: |
| DOMAIN | 8 | 1623 | 0 |
| DB | 7 | 2411 | 0 |
| MIGRATION | 8 | 1452 | 0 |
| WORKER_ROUTE | 7 | 917 | 144 |
| API | 2 | 17 | 9 |
| TEST | 38 | 11287 | 19 |
| DOC | 46 | 6418 | 5 |
| CONFIG | 1 | 0 | 6 |
| OTHER | 3 | 117 | 2 |
| **Total** | **120** | **24242** | **185** |

### DOMAIN (8)

| Status | Path | + | − |
| --- | --- | ---: | ---: |
| M | `packages/domain/src/index.ts` | 2 | 0 |
| A | `packages/domain/src/inventory-adoption.ts` | 168 | 0 |
| A | `packages/domain/src/inventory-fefo.ts` | 189 | 0 |
| A | `packages/domain/src/inventory-lot-commands.ts` | 289 | 0 |
| A | `packages/domain/src/inventory-observations.ts` | 155 | 0 |
| A | `packages/domain/src/inventory-read-authority.ts` | 131 | 0 |
| A | `packages/domain/src/inventory-reconciliation.ts` | 335 | 0 |
| A | `packages/domain/src/inventory-truth.ts` | 354 | 0 |

### DB (7)

| Status | Path | + | − |
| --- | --- | ---: | ---: |
| A | `packages/db/src/inventory-adoption-executor.ts` | 309 | 0 |
| A | `packages/db/src/inventory-lot-commands.ts` | 1026 | 0 |
| A | `packages/db/src/inventory-observations.ts` | 197 | 0 |
| A | `packages/db/src/inventory-read-authority.ts` | 230 | 0 |
| A | `packages/db/src/inventory-reconciliation.ts` | 425 | 0 |
| A | `packages/db/src/inventory-truth.ts` | 148 | 0 |
| A | `packages/db/src/inventory-writer-fence.ts` | 76 | 0 |

### MIGRATION (8)

| Status | Path | + | − |
| --- | --- | ---: | ---: |
| A | `migrations/0023_inventory_truth_foundation.sql` | 71 | 0 |
| A | `migrations/0024_inventory_lot_commands.sql` | 149 | 0 |
| A | `migrations/0025_inventory_event_authority.sql` | 110 | 0 |
| A | `migrations/0026_inventory_event_poststate.sql` | 41 | 0 |
| A | `migrations/0027_inventory_fefo_authority.sql` | 488 | 0 |
| A | `migrations/0028_inventory_adoption_authority.sql` | 24 | 0 |
| A | `migrations/0029_inventory_fefo_backfill_compatibility.sql` | 402 | 0 |
| A | `migrations/0030_inventory_observation_reconciliation.sql` | 167 | 0 |

### WORKER_ROUTE (7)

| Status | Path | + | − |
| --- | --- | ---: | ---: |
| M | `src/worker/routes/auth.ts` | 9 | 111 |
| M | `src/worker/routes/inventory.ts` | 375 | 5 |
| M | `src/worker/routes/notifications.ts` | 19 | 6 |
| M | `src/worker/routes/recipes.ts` | 161 | 4 |
| M | `src/worker/routes/scans.ts` | 112 | 9 |
| M | `src/worker/routes/week.ts` | 174 | 9 |
| A | `src/worker/utils/inventory-authority.ts` | 67 | 0 |

### API (2)

| Status | Path | + | − |
| --- | --- | ---: | ---: |
| M | `src/web/services/scans.ts` | 16 | 8 |
| M | `src/worker/validation/schemas.ts` | 1 | 1 |

### TEST (38)

| Status | Path | + | − |
| --- | --- | ---: | ---: |
| M | `tests/e2e/planner-preview.test.mjs` | 1 | 1 |
| A | `tests/helpers/inventory-lot-d1-worker.ts` | 277 | 0 |
| A | `tests/integration/inventory-adoption.test.ts` | 406 | 0 |
| A | `tests/integration/inventory-backfilled-fefo.test.ts` | 398 | 0 |
| A | `tests/integration/inventory-backfilled-patch.test.ts` | 274 | 0 |
| A | `tests/integration/inventory-closed-loop-d1.test.mjs` | 258 | 0 |
| A | `tests/integration/inventory-closed-loop-routes.test.ts` | 195 | 0 |
| A | `tests/integration/inventory-closed-loop.test.ts` | 274 | 0 |
| A | `tests/integration/inventory-concurrency.test.ts` | 272 | 0 |
| A | `tests/integration/inventory-event-authority.test.ts` | 418 | 0 |
| A | `tests/integration/inventory-fefo-schema.test.ts` | 415 | 0 |
| A | `tests/integration/inventory-fefo.test.ts` | 407 | 0 |
| A | `tests/integration/inventory-guest-transfer.test.ts` | 286 | 0 |
| A | `tests/integration/inventory-lot-authority.test.ts` | 646 | 0 |
| A | `tests/integration/inventory-lot-commands.test.ts` | 633 | 0 |
| A | `tests/integration/inventory-lot-d1.test.mjs` | 611 | 0 |
| A | `tests/integration/inventory-lot-schema.test.ts` | 236 | 0 |
| A | `tests/integration/inventory-observation-concurrency.test.ts` | 155 | 0 |
| A | `tests/integration/inventory-observation-d1.test.mjs` | 268 | 0 |
| A | `tests/integration/inventory-observations.test.ts` | 530 | 0 |
| A | `tests/integration/inventory-patch-parity.test.ts` | 203 | 0 |
| A | `tests/integration/inventory-read-authority-d1.test.mjs` | 275 | 0 |
| A | `tests/integration/inventory-read-authority.test.ts` | 560 | 0 |
| A | `tests/integration/inventory-reconciliation-composition.test.ts` | 333 | 0 |
| A | `tests/integration/inventory-reconciliation-fence.test.ts` | 260 | 0 |
| A | `tests/integration/inventory-truth.test.ts` | 289 | 0 |
| A | `tests/integration/inventory-writer-fence.test.ts` | 264 | 0 |
| M | `tests/integration/recipe-foundation.test.ts` | 1 | 1 |
| A | `tests/integration/scan-response-loss.test.ts` | 230 | 0 |
| A | `tests/integration/shopping-command-race.test.ts` | 193 | 0 |
| M | `tests/unit/auth.test.ts` | 11 | 13 |
| M | `tests/unit/command-route-integrity.test.ts` | 8 | 2 |
| A | `tests/unit/inventory-adoption.test.ts` | 336 | 0 |
| A | `tests/unit/inventory-fefo.test.ts` | 160 | 0 |
| A | `tests/unit/inventory-lot-commands.test.ts` | 484 | 0 |
| A | `tests/unit/inventory-observations.test.ts` | 360 | 0 |
| A | `tests/unit/inventory-truth.test.ts` | 214 | 0 |
| M | `tests/unit/sync.test.ts` | 146 | 2 |

### DOC (46)

| Status | Path | + | − |
| --- | --- | ---: | ---: |
| M | `docs/ai/CURRENT_STATE.md` | 292 | 1 |
| M | `docs/ai/HANDOFF.md` | 442 | 1 |
| M | `docs/ai/TASK_BOARD.md` | 188 | 3 |
| A | `docs/ai/inventory-truth/CURRENT_STATE.md` | 265 | 0 |
| A | `docs/ai/inventory-truth/DECISIONS.md` | 292 | 0 |
| A | `docs/ai/inventory-truth/MASTER_CONTEXT.md` | 199 | 0 |
| A | `docs/ai/inventory-truth/SESSION_LOG.md` | 147 | 0 |
| A | `docs/ai/inventory-truth/T08_VERIFICATION.md` | 140 | 0 |
| A | `docs/ai/inventory-truth/TASK_BOARD.md` | 164 | 0 |
| A | `docs/ai/inventory-truth/VERIFICATION.md` | 216 | 0 |
| A | `docs/ai/inventory-truth/t09/CHANGE_MANIFEST.md` | 222 | 0 |
| A | `docs/ai/inventory-truth/t09/CONCURRENCY_MATRIX.md` | 58 | 0 |
| A | `docs/ai/inventory-truth/t09/CONTINUATION.md` | 211 | 0 |
| A | `docs/ai/inventory-truth/t09/FINAL_PATCH_VERIFICATION.md` | 433 | 0 |
| A | `docs/ai/inventory-truth/t09/F_ADOPTION_PLAN.md` | 110 | 0 |
| A | `docs/ai/inventory-truth/t09/INVARIANT_MATRIX.md` | 99 | 0 |
| A | `docs/ai/inventory-truth/t09/MIGRATION_NOTES.md` | 156 | 0 |
| A | `docs/ai/inventory-truth/t09/README.md` | 63 | 0 |
| A | `docs/ai/inventory-truth/t09/REVIEW_INDEX.md` | 148 | 0 |
| A | `docs/ai/inventory-truth/t09/SESSION_LOG.md` | 277 | 0 |
| A | `docs/ai/inventory-truth/t09/TEST_MATRIX.md` | 139 | 0 |
| A | `docs/ai/inventory-truth/t09/VERIFICATION.md` | 547 | 0 |
| A | `docs/ai/inventory-truth/t09/WRITER_MAP.md` | 97 | 0 |
| A | `docs/ai/inventory-truth/t10/CHANGE_MANIFEST.md` | 84 | 0 |
| A | `docs/ai/inventory-truth/t10/CONTINUATION.md` | 79 | 0 |
| A | `docs/ai/inventory-truth/t10/INVARIANT_MATRIX.md` | 30 | 0 |
| A | `docs/ai/inventory-truth/t10/OBSERVATION_SOURCE_MAP.md` | 56 | 0 |
| A | `docs/ai/inventory-truth/t10/README.md` | 65 | 0 |
| A | `docs/ai/inventory-truth/t10/TEST_MATRIX.md` | 127 | 0 |
| A | `docs/ai/inventory-truth/t10/VERIFICATION.md` | 246 | 0 |
| A | `docs/ai/inventory-truth/t11/CHANGE_MANIFEST.md` | 40 | 0 |
| A | `docs/ai/inventory-truth/t11/CONTINUATION.md` | 42 | 0 |
| A | `docs/ai/inventory-truth/t11/LEGACY_READ_MAP.md` | 69 | 0 |
| A | `docs/ai/inventory-truth/t11/README.md` | 63 | 0 |
| A | `docs/ai/inventory-truth/t11/READ_CONSUMER_MAP.md` | 74 | 0 |
| A | `docs/ai/inventory-truth/t11/TEST_MATRIX.md` | 61 | 0 |
| A | `docs/ai/inventory-truth/t11/VERIFICATION.md` | 112 | 0 |
| A | `docs/ai/inventory-truth/t12/CHANGE_MANIFEST.md` | 12 | 0 |
| A | `docs/ai/inventory-truth/t12/CONTINUATION.md` | 13 | 0 |
| A | `docs/ai/inventory-truth/t12/FINAL_AUTHORITY_MAP.md` | 85 | 0 |
| A | `docs/ai/inventory-truth/t12/FINAL_WRITER_MAP.md` | 31 | 0 |
| A | `docs/ai/inventory-truth/t12/README.md` | 13 | 0 |
| A | `docs/ai/inventory-truth/t12/TEST_MATRIX.md` | 22 | 0 |
| A | `docs/ai/inventory-truth/t12/VERIFICATION.md` | 53 | 0 |
| A | `docs/ai/tasks/T08-inventory-truth-foundation.md` | 67 | 0 |
| A | `docs/ai/tasks/T09-inventory-lot-engine.md` | 69 | 0 |

### CONFIG (1)

| Status | Path | + | − |
| --- | --- | ---: | ---: |
| D | `.hoplite/settings.json` | 0 | 6 |

### OTHER (3)

| Status | Path | + | − |
| --- | --- | ---: | ---: |
| M | `scripts/d1-schema-gate.sh` | 1 | 1 |
| M | `scripts/d1-schema-gate.sql` | 58 | 1 |
| M | `scripts/migration-smoke.sh` | 58 | 0 |

## Findings from the manifest review

- **Dependencies / lockfile / build config:** `package.json`, `pnpm-lock.yaml`,
  `wrangler.jsonc`, `wrangler.staging.jsonc.example`, `tsconfig*.json`,
  `vite.config.ts`, `eslint.config.js`, `.dev.vars.example`, `public/_headers`
  are **byte-identical** to main. No dependency added/removed, no version change,
  no Cloudflare binding or environment-variable change. `pnpm install
  --frozen-lockfile` leaves the lockfile unchanged (SHA-256
  `e3be8dd0c31cfb40f6bd6c8c08906a47a17a6347d02108f5a44b0bd3c96ddea3`).
- **Binary / generated / local workspace files:** none in the diff (no `-` numstat
  rows; no `dist/`, `.wrangler/`, `node_modules/`, logs or artifacts).
- **Secrets:** none. All `secret`/`token`/`password` literals introduced are test
  fixtures inside `tests/**` (`test-only-…`, `integration-only-…`).
- **CONFIG (1 file, the only deletion of a tracked file):** `.hoplite/settings.json`
  — tracked on main (blob `3818a00`, setup `sqlite3 + pnpm install
  --frozen-lockfile`, run `node scripts/security-preview.mjs`) — is **deleted** from
  the RC tree by T11 commit `4553b8a`. See certification defect **D1**.
- **API (2 files):** `src/worker/validation/schemas.ts` — comment only on the
  retained `migrateFromHouseholdId` field; `src/web/services/scans.ts` — offline
  scan-confirm queueing hardening (T09F `aa43e06`), no contract change.
- **OTHER (3 files):** `scripts/migration-smoke.sh` and `scripts/d1-schema-gate.sql`
  extend the local gates to 0023–0030 and the inventory-truth tables/triggers;
  `scripts/d1-schema-gate.sh` message text only.
- **WORKER_ROUTE — the one cross-cutting product change:** `src/worker/routes/auth.ts`
  (+9/−111) removes the best-effort guest→account data migration inside
  `POST /auth/verify-otp` and returns `409 INVENTORY_TRANSFER_DEFERRED` whenever a
  register verification carries `migrateFromHouseholdId` (DEC-012, commit
  `66858c5`). The removed block was a non-atomic `UPDATE OR IGNORE` ownership rewrite
  under a swallowed-error catch, so removing it is correct for Inventory Truth —
  but the shipped web client still sends the field for every guest session (see
  certification defect **D3**).
- **Unrelated product changes:** none found. All other `src/` deltas are the
  adoption-gated inventory funnel/adapters (`inventory.ts`, `recipes.ts`,
  `scans.ts`, `week.ts`, `notifications.ts`, `utils/inventory-authority.ts`).
- **Tests modified (not only added):** `tests/unit/auth.test.ts`,
  `tests/unit/sync.test.ts`, `tests/unit/command-route-integrity.test.ts`,
  `tests/e2e/planner-preview.test.mjs`, `tests/integration/recipe-foundation.test.ts`
  — migration-head assertions moved from 0022 to 0030 and DEC-012 expectations;
  no assertion was weakened (the guest-transfer suite adds 25 explicit cases).
