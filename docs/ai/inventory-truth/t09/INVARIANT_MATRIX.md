# T09 invariant matrix

## Current FEFO mapping invariants — bf391c5fdcdd9e9c2f2257db515815e082cb4381

| Invariant | Current evidence |
| --- | --- |
| v2 FEFO lot identity is the native lot; projection identity is legacy_item_id | Receipt effects carry `after.id` (native) and `legacyItemId` (projection); events insert the projection ID |
| Synthetic mapping must be proven, never inferred | 0029 SQL: LEGACY_BACKFILL + source_id = legacy_item_id + adoption receipt evidence (household/actor/source version, lot/legacy effect match, createdAt/provenance, version >= evidence, preserved offset); TS requireParity/authoritativeMapping admission and replay authentication |
| Native equal-ID lots unchanged | First branch of every 0029 mapping check; all native FEFO/PATCH/replay/concurrency suites PASS unchanged |
| Prestate projection parity authoritative | Exact canonical parity or the exact kg/l display aliases; any other unit/quantity is drift; poststate guards stay strict and the first native write canonicalizes |
| No cross-tenant or foreign stock | Foreign actor FORBIDDEN; foreign household stock untouched; household-bound receipt joins retained |
| Drift stays fail-closed | Wrong ingredient/unit INSUFFICIENT_INVENTORY; tampered receipt CORRUPT_RECEIPT; broken version offset DRIFT_DETECTED; deleted receipt ADOPTION_REQUIRED; SQL receipt/event mismatch aborts |
| Multi-lot atomicity and one race outcome | Household CAS fences racers; FEFO/FEFO, FEFO/CORRECT, FEFO/DISCARD, FEFO/MOVE and multi-lot races leave one receipt, no overspend, no partial effects |
| Receipt replay and idempotency | Same key+intent exact replay; changed quantity or expected version IDEMPOTENCY_CONFLICT; distinct stale key STALE_SNAPSHOT; lost response replays the committed receipt once |
| Version offset semantics | Adoption offset preserved across FEFO → CORRECT → MOVE → FEFO and later-writes replay; lot.version - evidence.version = legacyVersion delta asserted in TS and SQL |

13 new backfilled-FEFO tests; 1,237 focused/15 files; 2,926 full/108; 44 real-D1
PASS; clean exact-SHA checkout repeats every gate. Historical migrations 0023-0028
byte-untouched. **READY FOR FINAL MAIN MERGE REVIEW**.

## Historical PATCH mapping invariants — superseded by bf391c5

| Invariant | Current evidence |
| --- | --- |
| Identity is exact persisted projection mapping, not equal lot ID | 0024 unique FK/immutable tenant guards; complete adoption witness crosslinks both IDs |
| Synthetic identity needs legitimate backfill provenance | Bounded v3 evidence; deterministic ID, source, household, unique effects and version offset |
| Live stock still matches current projection | Ingredient/name/quantity/unit/storage/version/expiry/opened/lifecycle/reference checks retained |
| No cross-tenant/nonexistent/arbitrary mapping | DB tamper rejection plus corrupted-fixture fail-closed tests |
| CORRECT/MOVE/metadata atomicity and historical replay | Full backfilled PATCH matrix, injected rollback, original result and receipt/event counts |
| Native equal-ID behavior unchanged | Original 25 PATCH cases, native receipt/concurrency suites PASS |
| v2 FEFO still requires equal IDs | Unchanged 0027 SQL and replay; explicit preflight rejection with no effects |

43 new backfill tests; 619 focused/nine files; 2,910 full/107; 42 real-D1 PASS.
Exact-SHA clean gates PASS. **All-writer synthetic compatibility is NOT complete**:
the remaining FEFO restriction is a P1 and prevents main readiness. Full receipt:
`FINAL_PATCH_VERIFICATION.md`.

## Historical COMPLETE claim — superseded (9bf9ac0fe7b5e0d39615f39ae5cc30f84569af2f)

All-writer invariants now hold with executable evidence: atomic adoption, mapped
lifecycle (ACTIVE positive / terminal zero), stale CAS denial with no partial
effects, one idempotency effect per key with payload conflicts, immutable events
bound to receipts, legacy projection compatibility (kg/l aliases exact), tenant
isolation for every command, and no-writer bypass (fail-closed admission). The G
sweep verifies poststate/lot quantity agreement, monotonic versions and receipt/
event agreement. 2,837 tests / 105 files PASS (155s), 38 isolated real local-D1 tests, lint, typecheck, build, 28-migration smoke and local D1 schema gate PASS. The historical checklist below is retained.

E native scope is now published and verified at `9bd1e6bc000cd2e94121469babb1a5eb63a5047f`
(1,172 focused / 2,659 full PASS). Receipt mode dispatch and ordered stored-result
fencing have regression proofs; no remaining E P1/P2 review finding. The full
all-writer invariants below remain pending F/G/H, not a final readiness claim.

Status: A–D published; E implemented locally with final full gate/review/publication
pending. No full T09 PASS is claimed. E evidence below is internal native scope,
not all-writer/HTTP adoption. Native
proof lives in inventory-lot-commands unit/integration, inventory-lot-schema and
inventory-lot-d1 tests: mapped lifecycle, membership/location, stale CAS/snapshot,
receipt replay/conflicts, event immutability, atomic projection/event/result,
exact quantity, identity, expiry/money and timestamp validation.
Historical unmapped T08 ACTIVE-zero snapshots remain unchanged and unusable by
the native executor until explicit adoption; T09F owns that transition.

D evidence: retained result/header/effects/events are validated in one authorized
read batch; new events match their declared receipt and actual written lot/core
projection. Same-key/no-op/actor races and paired corruption rollback PASS in
native tests, with real D1 proof. These guarantees are not a claim that unadapted
legacy writers already use the authority; the all-writer table remains pending.

## T09E local invariant evidence

| Invariant | Implementation / evidence | Scope |
| --- | --- | --- |
| Deterministic exact FEFO | Same household/canonical ingredient/unit, ACTIVE positive; expiry, certainty, purchase, creation, binary-ID ties; domain/FEFO integration tests | LOCAL E |
| No speculative conversion | g/ml/piece only, kg/l normalized exactly; contextual units and unrepresentable milli-units rejected | LOCAL E |
| Bounded work, no partial prefix | 1–32 effects, 1,000-row snapshot bounds, 16 KiB fingerprint / 256 KiB receipt/event JSON; boundary tests | LOCAL E |
| One atomic logical command | Membership/revision fence, per-projection/lot CAS guards, all stock writes before events, final cardinality/poststate/ordered-receipt fence | LOCAL E; SQLite + actual D1 |
| Immutable historical evidence | v2 ordered effects biject to events; replay never reallocates from newer stock; v1 predicates retained in additive 0027 | LOCAL E |
| Corruption != genuine key collision | Fingerprint mode selects stored-result schema before payload comparison; mismatched envelope is CORRUPT_RECEIPT, genuine v1 key collision remains IDEMPOTENCY_CONFLICT | LOCAL E |
| Missing JSON cannot pass SQL NULL | Explicit type/presence and NULL-safe predicates; malformed/duplicate/forged evidence rollback tests | LOCAL E |

Latest post-fence 1,172 focused / 11 files PASS, including 35 actual D1 tests.
Latest full rerun pending; earlier full PASS predates the ordered-receipt fence.
Gate chronology and remaining final review/publication: VERIFICATION.md.

## Historical initial checklist — full writer/HTTP acceptance remains pending

| Invariant | Implementation / DB / domain / test | Status |
| --- | --- | --- |
| quantity >= 0 | T08 integer foundation; T09 decrement/CAS tests pending | PENDING |
| ACTIVE quantity > 0; terminal quantity = 0 | DEC-008 live lifecycle; persistence protection pending | PENDING |
| household and location isolation | T08 composite FK retained; live authorization tests pending | PENDING |
| stale version denied; no reread race | Version-predicate writes and returned written row required | PENDING |
| one idempotency effect; payload conflict | Existing command ledger reuse, complete fingerprint | PENDING |
| immutable event; success has event; failure has none | Existing inventory_events, single atomic boundary | PENDING |
| legacy parity | Lots/events/projection/command result commit together | PENDING |
| deterministic FEFO | Dated before unknown, stable ties; allocation evidence | PENDING |
| unknown expiry and money preserved | T08 domain reused; live validation strengthened | PENDING |
| unsupported units and silent rounding denied | Exact quantity adapter reused | PENDING |
| anonymous new lot denied | Known ingredient or nonblank rawName, live only | PENDING |
