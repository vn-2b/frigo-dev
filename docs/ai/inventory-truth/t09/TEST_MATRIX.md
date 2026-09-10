# T09 test matrix

All T09 gates PENDING. Historical T08 counts are not fresh T09 evidence.

- Contracts: CREATE, USE, DISCARD, OPEN, MOVE, CORRECT; quantity/expiry/money,
  identity, transitions, explicit revive, strict timestamps and unknown evidence.
- Persistence: exact returned CAS row, rollback, result/event/projection coupling.
- Idempotency: same payload retry; different payload conflict; concurrent same key.
- FEFO: stable ties, unknown expiry last, units/tenancy, exact allocations,
  insufficient stock has no partial effect.
- Integration: every writer in WRITER_MAP; all command classes preserve parity.
- Tenancy: nonmember, spoofed household, foreign lot/location, direct composite FK.
- Controlled races: see CONCURRENCY_MATRIX.md; barriers, not timing luck.
- Final: focused T09; T08+T09; inventory/scan/shopping/cook; full test suite;
  lint; typecheck; build; clean migration replay; populated upgrade if applicable;
  local schema; relevant query plans; git diff --check; fresh remote checkout gate.
