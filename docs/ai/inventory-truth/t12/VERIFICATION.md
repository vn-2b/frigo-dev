# T12 verification receipt (2026-09-12)

## Lineage

- Base: T11 docs HEAD `847b0363…` via train merge `14c02f8` (release train
  `hoplite/kydonia-2785bb72`; main `d1b0673` untouched, 0 ahead/behind unchanged).
- T12 branch: `hoplite/himera-6d3eda84-t10-observation-reconciliation-t11-inventory-read-authority-t12-inventory-closed-loop`.
- T11 freeze `c15c9a8` verified ancestor before any edit.

## Baseline before T12 edits (train base tree)

Full **3,063/3,063 across 116 files**; real local D1 **62/62**; lint/typecheck/
build PASS; `migration-smoke=ok` (30); schema gate PASS; T11 focused 39/39;
T10 focused 98/98; T09 focused 654/654. No unexplained regressions.

## What T12 changed (application)

- `packages/db/src/inventory-read-authority.ts`: retained display alias is now
  honored only while the projection row itself agrees with authority (label AND
  quantity round-trip through `toLotQuantity`); tampered rows drop to canonical
  presentation. No other behavior change.
- `tests/integration/inventory-read-authority.test.ts`: tamper expectation
  updated to the stricter canonical fallback (999 kg → 2000 g canonical).
- `tests/integration/inventory-closed-loop.test.ts`: new 9-test closed-loop suite
  (E2E reconciliation, DISMISS, recipe, planner, shopping, cook/FEFO,
  notifications, reconciliation-vs-manual race, drift matrix).
- No migration (count stays 30); no new production writers; no PayOS touch;
  no legacy removals.

## Gates at the T12 freeze

| Gate | Result |
| --- | --- |
| Full tests | **3,072/3,072 across 117 files** (169.87s) |
| Lint / typecheck / build | PASS / PASS / PASS |
| Migration smoke | `migration-smoke=ok`, 30 migrations |
| Local schema gate | PASS |
| Real local D1 (44 T09 + 7 T10 + 11 T11) | **62/62** |
| `git diff --check` | clean |

## Classification

- P0: NONE · P1: NONE · P2: NONE merge-blocking · P3: legacy compatibility
  paths remain for non-adopted households by design (FINAL_AUTHORITY_MAP.md
  lists why/reach/removal/truth-risk for each).
- **UNKNOWN production readers = 0 · UNKNOWN production writers = 0.**

## Prohibitions

Main NOT merged · production NOT deployed · remote D1 NOT touched · PayOS
untouched · no historical migration edits · no force-push/reset/clean ·
`.hoplite/settings.json` overlay preserved byte-for-byte uncommitted ·
T12 is the final train task; no post-T12 task started.
