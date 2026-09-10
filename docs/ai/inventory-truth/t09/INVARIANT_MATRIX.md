# T09 invariant matrix

Status: native C implementation verified, but no full T09 PASS is claimed. The
initial checklist below remains pending full writer/FEFO/HTTP acceptance. Native
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
