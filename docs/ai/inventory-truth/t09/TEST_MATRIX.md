# T09 test matrix

## Current targeted PATCH final gate — e796f695bdb4228853992cdedc4e3cecf3437adb

| Proof | Evidence |
| --- | --- |
| Exact combined replay and retained historical response | `inventory-patch-parity.test.ts` |
| Every supported field's changed value/presence, null expiry and version | Same suite; 25 tests total |
| Category-only and storage-only durable parity/version/location | Same suite |
| Combined rollback: zero-row category write, late MOVE failure, metadata drift | Same suite |
| Known-winner same/changed-key races, lost committed response | Same suite |
| Strict distinct-key stale CAS, foreign-household replay denial | Same suite |
| Metadata-only correction and CORRECT+MOVE in actual workerd/D1 | `inventory-lot-d1.test.mjs`; 40 total, two new |
| Focused native/manual/receipt/concurrency regressions | 515 tests / six files PASS |
| Full suite | 2,865 tests / 106 files PASS |

Exact clean-source results and separate inherited failing diagnostic:
`FINAL_PATCH_VERIFICATION.md`. A passing suite is not a claim that the separately
reproduced backfilled-lot mapping refusal is fixed.

## Historical test evidence (superseded)

## COMPLETE — 2026-09-11 (9bf9ac0fe7b5e0d39615f39ae5cc30f84569af2f)

Fresh full gate: **2,837 tests / 105 files PASS** (155.1s), including:
- F adoption executor + adapters: `tests/integration/inventory-adoption.test.ts`
  (19) — atomic activation, empty-household evidence, terminal evidence, replay/
  conflict, stale-race rollback, single-winner adoption, G12 stale legacy,
  tenancy, adapter behavior for manual/scan/shopping/cook.
- G matrix: `tests/integration/inventory-concurrency.test.ts` (9) — barrier races
  G1–G12 subsets + property sweeps.
- Rewritten `inventory-writer-fence.test.ts` (14) — authority-served writers and
  the fail-closed unmapped-row refusal.
- Existing native/FEFO/event-authority/schema suites unchanged and passing;
  migration-count/upgrade fixtures updated to the 28-migration chain; real local
  D1 worker suite 38 PASS. lint/typecheck/build/migration smoke/schema gate PASS.

F safety: 25 new Hono/SQLite guest-transfer cases plus one client no-rebind case;
combined auth/guest/outbox suite **143 / 5 files PASS**. Existing crypto assertions
remain unchanged, renamed to avoid claiming that valid guest tokens authorize
transfers. Full adoption and other writer/race matrices are still pending.

Final published E proof supersedes the intermediate counts below: **1,172 tests /
11 files**, including FEFO unit 20, FEFO repository 34, FEFO schema 77 and actual
local D1 35; **2,659 / 98 files** full PASS. Lint/typecheck/build/migration gates
PASS. Source: `9bd1e6bc000cd2e94121469babb1a5eb63a5047f`; publication equality
PASS. F all-writer and G/H acceptance remain pending, not hidden by E test totals.

T09A–D published; E local implementation has final full gate/review/publication
pending. Full T09 integration gates remain PENDING. Historical
T08 counts are not fresh T09 evidence; executed commands are in VERIFICATION.md.

## T09E current evidence

Latest post-fence focused run: **1,172 tests / 11 files PASS** — prior eight-file
1,031 plus 20 domain FEFO, 34 FEFO repository, 77 FEFO schema and ten additional
real D1 tests (D1 total 35). Lint/typecheck/build/migration smoke PASS. The latest
full rerun is pending; do not infer its total from focused counts.

Historical post-replay-fix run: **1,170 / 11 files**, **2,657 / 98 files PASS**,
before the ordered-receipt fence; then **131 / 3 files PASS** for that fence's
initial regression. The latest focused run includes its additional actual D1
regression. Final full gate and independent review/publication remain pending.
Logs/chronology: VERIFICATION.md.

E covers deterministic ties, exact units, insufficient stock, 32/33 effects,
1,000/1,001-lot bounds, same-key v1/v2 collisions, retained replay after later stock,
fingerprint-mode corruption, paired receipt/event corruption, SQL NULL/JSON checks,
whole-snapshot phantoms, late writes/events and actual D1 rollback. Populated
0026 -> 0027 preserves historical v1 receipt/event bytes. These tests do not imply
legacy writer adoption, HTTP integration or completion of the G concurrency matrix.

## Historical T09D gate and full T09 checklist

At D: 202 domain contract tests, 146 native repository tests, 26 additive
schema tests, 25 actual local D1 tests, 306 receipt authority tests and 196 event
authority tests. Combined with T08: 1,031 focused; full: 2,518 / 95 files PASS.
Full suite includes existing inventory,
scan, shopping, cook, auth and Week regressions. No live writer changed yet.

- Contracts: CREATE, USE, DISCARD, OPEN, MOVE, CORRECT; quantity/expiry/money,
  identity, transitions, explicit revive, strict timestamps and unknown evidence.
- Persistence: exact returned CAS row, rollback, result/event/projection coupling.
- Idempotency: same payload retry; different payload conflict; concurrent same key.
- D authority: all validated intent fields/nested money and explicit defaults;
  all six command types and no-op races; revoked membership and actor conflicts;
  byte-identical effects after rejection; corrupt retained receipts/events across
  initial replay, collision and response-loss recovery; paired evidence versus
  actual poststate, malformed/duplicate JSON and historical upgrade preservation.
- FEFO: stable ties, unknown expiry last, units/tenancy, exact allocations,
  insufficient stock has no partial effect.
- Integration: every writer in WRITER_MAP; all command classes preserve parity.
- Tenancy: nonmember, spoofed household, foreign lot/location, direct composite FK.
- Controlled races: see CONCURRENCY_MATRIX.md; barriers, not timing luck.
- Final: focused T09; T08+T09; inventory/scan/shopping/cook; full test suite;
  lint; typecheck; build; clean migration replay; populated upgrade if applicable;
  local schema; relevant query plans; git diff --check; fresh remote checkout gate.
