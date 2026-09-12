# T12 change manifest (2026-09-12)

| File | Change |
| --- | --- |
| `tests/integration/inventory-closed-loop.test.ts` | New — 9 closed-loop tests (§15/§16/§19/§20/§21/§22/§23/§26/§28) |
| `packages/db/src/inventory-read-authority.ts` | Display alias now agreement-gated (projection row must round-trip to authority through the alias; tamper → canonical presentation) |
| `tests/integration/inventory-read-authority.test.ts` | Tamper expectation updated to stricter canonical fallback |
| `docs/ai/inventory-truth/t12/*` | FINAL_AUTHORITY_MAP, FINAL_WRITER_MAP, TEST_MATRIX, VERIFICATION, CHANGE_MANIFEST, CONTINUATION, README |

Behavior deltas: exactly one — tampered projection rows no longer lend their
unit label to presentation (canonical `g/ml/piece/…` shown instead of an exact
alias). Authority values, API identity, and all truth semantics unchanged.
