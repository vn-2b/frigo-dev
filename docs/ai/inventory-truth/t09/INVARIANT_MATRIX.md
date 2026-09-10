# T09 invariant matrix

Status: design checklist; no T09 implementation PASS is claimed.

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
