# T12 change manifest (2026-09-12)

## Runtime-verification freeze `d15600186c3e73faba011eb690ac6cd70e8d3d2d`

| File | Change |
| --- | --- |
| `src/worker/routes/recipes.ts` | `completeAdoptedCooking` replays the durable `cooked_meals` receipt before re-planning (response-loss retry → `idempotentReplay`, altered key → `IDEMPOTENCY_CONFLICT`) |
| `tests/helpers/inventory-lot-d1-worker.ts` | Test-only endpoints `/plan`, `/reconcile-vs-manual` (TEST_TOKEN-gated) |
| `tests/integration/inventory-closed-loop-d1.test.mjs` | New — 8 real workerd/D1 closed-loop cases |
| `tests/integration/inventory-closed-loop-routes.test.ts` | New — 5 route-level cases through the real Hono handlers |
| `tests/integration/inventory-closed-loop.test.ts` | Race regression tightened to `STALE_SNAPSHOT` only + no-commit proofs |

No migration (count stays 30); no new SQL writers; no PayOS touch.

## First freeze `22f675d1cca76d05c93ebb2ed40bbaea11a72238` (historical)

| File | Change |
| --- | --- |
| `tests/integration/inventory-closed-loop.test.ts` | New — 9 closed-loop tests (§15/§16/§19/§20/§21/§22/§23/§26/§28) |
| `packages/db/src/inventory-read-authority.ts` | Display alias now agreement-gated (projection row must round-trip to authority through the alias; tamper → canonical presentation) |
| `tests/integration/inventory-read-authority.test.ts` | Tamper expectation updated to stricter canonical fallback |
| `docs/ai/inventory-truth/t12/*` | FINAL_AUTHORITY_MAP, FINAL_WRITER_MAP, TEST_MATRIX, VERIFICATION, CHANGE_MANIFEST, CONTINUATION, README |

Behavior deltas: exactly one — tampered projection rows no longer lend their
unit label to presentation (canonical `g/ml/piece/…` shown instead of an exact
alias). Authority values, API identity, and all truth semantics unchanged.
