# T09 test matrix

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
