# T10 change manifest

## Composition fix freeze `4c414fa7eb33329ee12936c0899644af67e48f07` (3 files)

| File | Change |
| --- | --- |
| `packages/domain/src/inventory-reconciliation.ts` | `composeProposals` merges per-dimension CORRECTs into one CORRECT + at most one MOVE bound to the matched lot/version; `PROPOSAL_COMPOSITION_CONFLICT` on contradictory values; verdict priority (lone expiry / lone move / otherwise PROPOSE_CORRECTION) |
| `packages/db/src/inventory-reconciliation.ts` | `assertProposalSetInvariant` at the decision boundary (max one CORRECT, one MOVE, same lot/version, type consistency; fail closed); `decisionCommandSpecs` re-asserts uniqueness and composes MOVE with `useCurrentLotVersion` after CORRECT |
| `tests/integration/inventory-reconciliation-composition.test.ts` | New — 19 permanent regressions (16 fail pre-fix) |

No migration; 0023–0030 untouched (count 30). No unrelated files.

## Initial freeze `6c28858acd0627d2d602998107c2e260c5e4f0d5` (historical; 16 files, +2,465/−7)

## Added (application)

| File | Purpose |
| --- | --- |
| `packages/domain/src/inventory-observations.ts` | Observation contract: categorical evidence (UNKNOWN/ESTIMATED/OBSERVED/CONFIRMED/VERIFIED), status lifecycle, bounded claims, deterministic identity + canonical semantic fingerprint |
| `packages/domain/src/inventory-reconciliation.ts` | Pure deterministic reconciliation planner: 9 verdicts, descending-authority matching, exact milli comparison, contextual-unit refusal, expiry precedence, per-finding T09 command proposals (≤2, same-version) |
| `packages/db/src/inventory-observations.ts` | Observation persistence: idempotent record (replay / IDEMPOTENCY_CONFLICT), household-authoritative inventory version read from the household, bounded household-scoped reads, fail-closed row parsing |
| `packages/db/src/inventory-reconciliation.ts` | Decision authority: bounded snapshot reader, planner-through-db, `confirmReconciliationDecision` composing T09 CORRECT/MOVE via `composeInventoryLotCommands` in ONE atomic batch with decision receipt + observation lifecycle; fingerprint replay; fresh-plan equality fail-closed |
| `migrations/0030_inventory_observation_reconciliation.sql` | Additive: `inventory_observations` + `inventory_reconciliation_decisions`, 8 triggers (identity immutability, lifecycle transitions, lot/projection household guards, decision observation/command guards, decision immutability), bounded CHECKs |

## Added (tests)

| File | Coverage |
| --- | --- |
| `tests/unit/inventory-observations.test.ts` (33) | Schema/evidence/fingerprint/identity + full planner verdict matrix |
| `tests/integration/inventory-observations.test.ts` (22) | Persistence/replay/conflict, corruption, tenancy, decisions through T09, response loss, stale, rollback, backfilled synthetic + native equal-ID lots |
| `tests/integration/inventory-observation-concurrency.test.ts` (4) | Controlled races F1–F5 (reconcile/reconcile same+different, /FEFO, /CORRECT, /MOVE) |
| `tests/integration/inventory-observation-d1.test.mjs` (5) | Real workerd/local D1: atomic batch, replay, trigger battery, cross-household |

## Modified (application-adjacent)

| File | Change |
| --- | --- |
| `scripts/migration-smoke.sh` | Reads 0030; asserts T10 tables/columns/triggers; behavioral smoke: observation insert + dismissal decision |
| `scripts/d1-schema-gate.sql` | Requires 0030, both T10 tables, all 8 T10 triggers |
| `scripts/d1-schema-gate.sh` | Success message updated (0019-0030, observation/reconciliation objects) |
| `tests/helpers/inventory-lot-d1-worker.ts` | Test-only worker: `/observe` + `/reconcile` endpoints (never imported by the app or a deployment config) |
| `tests/integration/inventory-truth.test.ts` | Migration-head assertion 29 → 30 with 0030 filename |
| `tests/integration/recipe-foundation.test.ts` | Migration-head assertion → 0030 |
| `tests/e2e/planner-preview.test.mjs` | Migration-head assertion → 0030 |

## Documentation (docs-only commit)

| File | Change |
| --- | --- |
| `docs/ai/inventory-truth/t10/README.md` | New — T10 overview, status, boundaries |
| `docs/ai/inventory-truth/t10/CONTINUATION.md` | New — lineage, freezes, next action |
| `docs/ai/inventory-truth/t10/INVARIANT_MATRIX.md` | New — 23 invariants with enforcement + evidence |
| `docs/ai/inventory-truth/t10/OBSERVATION_SOURCE_MAP.md` | New — T10A exhaustive source audit |
| `docs/ai/inventory-truth/t10/TEST_MATRIX.md` | New — every required test and result |
| `docs/ai/inventory-truth/t10/VERIFICATION.md` | New — exact gate receipts + clean-checkout proof |
| `docs/ai/inventory-truth/t10/CHANGE_MANIFEST.md` | New — this file |
| `docs/ai/CURRENT_STATE.md` | T10 authoritative section; T11 NOT STARTED |
| `docs/ai/HANDOFF.md` | T10 handoff header |
| `docs/ai/TASK_BOARD.md` | T10 board; T11/T12 NOT STARTED |
| `docs/ai/inventory-truth/CURRENT_STATE.md` | T10 section |
| `docs/ai/inventory-truth/TASK_BOARD.md` | T10 entry |
| `docs/ai/inventory-truth/MASTER_CONTEXT.md` | Roadmap state (T10 done, T11 next) |

## Explicitly NOT changed

- PayOS, billing, subscriptions, checkout, payment webhooks — untouched
- Historical migrations 0023–0029 — byte-identical
- Any HTTP route, auth, or production infrastructure — no new routes
- `inventory_items` / `inventory_lots` / `inventory_events` writers — untouched
- T08/T09 authority modules — untouched (T10 composes them, never edits them)
- `.hoplite/settings.json` — preserved byte-for-byte as uncommitted workspace state
