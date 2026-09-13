# T13 test matrix

All tests are permanent and run in the default suite. No test was weakened,
skipped or deleted to obtain a pass.

## Suites added

| File | Tests | Kind |
| --- | --- | --- |
| `tests/unit/t13-receipt-vision-truth.test.ts` | 25 | Truth mapping, no-fabrication guards |
| `tests/unit/t13-inventory-ux.test.tsx` | 14 | Presentation truth, decision key bounds |
| `tests/integration/t13-receipt-vision-truth.test.ts` | 35 | Real Hono handlers, AC-tagged |
| `tests/integration/t13-receipt-vision-d1.test.mjs` | 11 | Real workerd + real D1, migrations 0001–0031 |

## Acceptance criteria

| AC | Requirement | Covered by |
| --- | --- | --- |
| AC1 | No fabricated confidence | unit: fabrication guards |
| AC2 | No fabricated merchant / date | unit: fabrication guards; D1: purchase facts |
| AC3 | No fabricated price; VND minor-unit exactness | unit: `receiptPurchasePrice` |
| AC4 | Provenance from server-side `scan_type` only | integration: provenance; D1 |
| AC5 | Fridge scans carry no purchase facts | integration: provenance |
| AC6 | Raw OCR retained beside reviewed value | D1: `ocr_*` columns, `review_state` |
| AC7 | Per-line rejection yields no stock and no evidence | integration: rejection |
| AC8 | Observations carry deterministic T10 verdict; decisions apply/dismiss | integration: reconciliation decisions |
| AC9 | Evidence and stock commit atomically | D1: atomic batch |
| AC10 | Storage MOVE through authority; stale write conflicts | integration: manual authority loop |
| AC11 | Expiry truth: `KNOWN` / `ESTIMATED` / `UNKNOWN`; correction upgrades | integration + unit; verified in browser |
| AC12 | `UNKNOWN` never renders as fresh; readable errors | unit: presentation truth |
| AC13 | Tenancy: cross-household reads indistinguishable from absent | integration: tenancy |
| AC14 | Idempotent replay; no double-add on retry | integration: replay; D1 |

## Regression tests for defects found by browser verification

These four were **not** caught by the original unit/integration coverage; each
now has a permanent test.

| # | Defect | Test |
| --- | --- | --- |
| 1 | `canonicalId` rejected a server-emitted `null` | integration: review round-trip |
| 2 | Composed T09 client key exceeded the 200-char bound with a real 64-char scan id | integration + `scanCommandKey` |
| 3 | Truncated item ids collapsed every line of one receipt to the same lot id (`LOT_EXISTS`) | integration: distinct lots per line |
| 4 | `PATCH` carried the previous expiry kind forward, so `ESTIMATED` could never become `KNOWN` | integration: AC11 correction |

## Regression tests added in the final verification pass

| # | Defect | Test |
| --- | --- | --- |
| 5 | Mock provider emitted a `vi-VN` date, so a real purchase date was dropped in every preview/mock run | unit: "emits a mock purchase date the receipt truth mapper can actually accept" |
| 6 | Decision route bounded `observationId` at 200 chars; a real receipt observation id is ~210, making **every** receipt observation permanently undecidable | integration: "a realistic receipt-length observation id is still decidable" + "the decision bound accepts the longest identity T10 can construct" |
| 7 | Client composed `decisionKey` from the observation id, blowing the server's 160-char bound, so reconciliation decisions failed validation from the UI | unit: "a real observation id still yields a decision key the server accepts" + determinism/collision test |

Defect 6 escaped because the existing decision tests used short synthetic ids.
The new test uses a realistic 64-char digest scan id.

## Executed results at the freeze commit

| Gate | Command | Result |
| --- | --- | --- |
| Full suite | `npx vitest run` | **3177 passed**, 124 files, 0 failed |
| Real D1 | 5 `*-d1.test.mjs` suites | **81 passed**, 0 failed |
| Lint | `pnpm lint` | PASS |
| Typecheck | `pnpm typecheck` | PASS |
| Build | `pnpm build` | PASS |
| Migrations | `pnpm check:migrations` | PASS (`migration-smoke=ok`) |
| Schema gate | `pnpm schema:check:local` | PASS |

Baseline before T13 was 3092 tests / 120 files and 70 real-D1 tests. T13 adds
tests and removes none.
