# T13 continuation notes

## What a follow-up task should know

### Evidence is not authority

This is the whole design. If a future change makes OCR output, a vision guess
or a heuristic write stock directly, it has broken T13 regardless of whether
tests still pass. The chain is:

```
OCR / vision -> user review -> T10 observation -> T09 command -> lots
```

There is exactly **one** inventory writer (T09). T13 added one new write
statement and it writes `inventory_observations` only.

### Bounded identities are load-bearing

Real scan ids are 64-character digests, so composed identifiers overflow the
contract bounds quickly. Three helpers collapse to a stable digest rather than
truncating:

- `scanCommandKey()` — T09 client key (200)
- `scanObservationSourceRef()` — T10 source ref (200)
- `boundedDecisionKey()` — decision key (160), client side

**Never truncate these.** Truncation caused the worst defect found during this
task: every line of one receipt collapsed to the same lot id, so a five-line
receipt produced a `LOT_EXISTS` conflict instead of five lots.

Note the asymmetry that caused two more defects: a T10 *source ref* is bounded
at 200, but a T10 *observation id* is `t10-observation:<household>:<type>:<ref>`
and is therefore **longer** — about 210 characters in practice. The decision
route now derives its bound from `observationIdentity()` instead of restating a
number.

### Test with realistic ids

Defect 6 (every receipt observation permanently undecidable) survived a full
green suite because the existing decision tests used short synthetic ids like
`fridge-4` / `line-17`. Any new test that touches an identifier bound should
use a realistic 64-char digest id.

## Defects found only by verifying against the running app

Seven defects reached a fully green test suite and were caught only by driving
the real application. Four were found earlier in the task; three more were
found during final verification:

| # | Defect | Severity |
| --- | --- | --- |
| 1 | `canonicalId` rejected a server-emitted `null` | P2 — review page broken for unmapped ingredients |
| 2 | Composed T09 client key exceeded 200 chars with a real scan id | P1 — hard `INVALID_COMMAND` failure |
| 3 | Truncated item ids collapsed all lines of a receipt to one lot id | **P1 — identity collision / data correctness** |
| 4 | `PATCH` carried the previous expiry kind forward | P2 — `ESTIMATED` could never become `KNOWN`; violates AC11 |
| 5 | Mock provider emitted a `vi-VN` date | P2 — a real purchase date was dropped in every preview / `AI_MOCK_MODE` run |
| 6 | Decision route bounded `observationId` at 200 | **P1 — every real receipt observation undecidable** |
| 7 | Client `decisionKey` blew the 160-char server bound | P1 — reconciliation decisions failed validation from the UI |

All seven now have permanent regression tests. The lesson worth carrying
forward: **a green suite did not prove the feature worked.** Bound and identity
errors only appear with production-shaped data.

## Known limitations of this verification

- **Viewport emulation unavailable.** `set viewport` and `set device` both left
  `innerWidth` at 1440 in this sandbox, so the 360 / 390 / 430 check is a
  computed layout-overflow probe (0 offenders at each width), not a visual
  check at those widths. A follow-up with working device emulation should
  confirm visually.
- **Accept (`CORRECT` / `MOVE`) decisions were exercised through tests and the
  API, not through a UI click**, because the seeded preview data produced
  `STALE_OBSERVATION` verdicts with no safe proposal, which correctly disables
  the "Áp dụng" button. A preview fixture that yields an actionable verdict
  would let the accept path be clicked end to end.
- **No hosted CI.** See the final report.
- Preview verification used the isolated in-memory preview
  (`scripts/security-preview.mjs`), never remote D1 and never a deployed
  environment.

## Not done, deliberately

- Not merged to `main`; not deployed anywhere.
- No remote D1 access, no `schema:check:remote`.
- `MEAL_PLANNER_ENABLED` and cutover flags untouched.
- PayOS / payments / billing / checkout untouched.
- Migrations `0001`–`0030` untouched.

## Preview harness notes

`scripts/security-preview.mjs` serves an isolated in-memory SQLite database
with `AI_MOCK_MODE=true` and external fetch disabled.

- Restart with `setsid ... &` detached; backgrounding inside a single shell
  call frequently leaves a stale process. Poll `/__preview` for HTTP 200.
- Vite SSR caches worker modules, so a **full restart** is required after
  editing worker code — a reload alone can serve stale handlers.
- The preview household starts in **legacy** authority mode. `POST
  /api/v1/inventory/adopt` activates native lot authority; the T13 truth routes
  return `INVENTORY_AUTHORITY_REQUIRED` until it does.
- The receipt review route is `/scan/receipt-review?scanId=...`.
