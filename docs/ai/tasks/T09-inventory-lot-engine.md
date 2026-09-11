# T09 — Inventory Lot Engine & Event Authority

Current continuation authority (2026-09-11): `green-1a/frigo-dev`, writable
`hoplite/orchemenos-e002591e` from frozen D base
`811f7e8463303e010199741d66f88ab8a817212d`. See
`../inventory-truth/t09/CONTINUATION.md`; the phase contract below is unchanged.
A–D complete; E locally implemented, final review/regates/publication pending;
F–H pending. Only the successor may be published; never push the frozen base.

Historical authorization, 2026-09-10. Canonical repository vn-2b/frigo-dev
(explicit owner correction). Base exact T08 remote HEAD 8f8788c1a0c9e486657751ef3875a5baa5334dec;
canonical T09 branch hoplite/euhesperides-d77023a5, published before implementation.

## Outcome and phases

T09A audit/writer map/lifecycle; B command contracts; C persistence/CAS;
D existing idempotency and inventory_events authority; E deterministic FEFO;
F all legacy writer integration; G controlled concurrency/tenancy; H freeze,
final verification and independent-review packet. Commit/push/fetch/verify at
each checkpoint; do not leave major implementation only local.

Implement CREATE LOT, USE, DISCARD, OPEN, MOVE and bounded explicit CORRECT via
authenticated household-authorized command service. Mutable commands require
expectedVersion/CAS; stale failures cannot leave effects or events. Same key and
payload replay exact logical result; changed payload conflicts. Fingerprints cover
all mutation inputs. Reuse existing command/event architecture, no parallel ledger.
Atomic boundary includes lots, events, legacy projection and command result.
Multi-lot insufficient stock/CAS failure must have no partial commit. Validate
actual D1 semantics, not SELECT-then-unconditional-UPDATE assumptions.

Remaining usable quantity semantics: ACTIVE positive, CONSUMED/DISCARDED zero;
partial decrement stays ACTIVE. No row deletion for discard. Terminal revival
requires explicit correction, reason, authorization, expectedVersion and evidence.
New live lots require existing canonical ingredient or nonblank rawName; legacy
backfill remains compatible. Validate timestamps, units, money, expiry, location,
provenance and tenant boundaries. OPEN already-open is deterministic no-op.
FEFO: same household/ingredient/compatible unit, ACTIVE positive, dated expiry
before unknown, certainty/purchase/creation/stable ID ties, exact allocation evidence.

All writers must be MIGRATED, ADAPTED, DEFERRED WITH SAFE REASON or NOT LIVE;
no silent inventory_items-only divergence. Cover manual, scan, shopping, cook,
discard/delete, household transfer, internal tools and jobs. Retain scan draft ->
user confirmation, existing recipe/Week behavior and legacy reads; no read cutover.

## Completion gate

Review packet in inventory-truth/t09 with exhaustive files/invariants/writers/tests,
concurrency, migrations, exact freeze SHA and final T09_VERIFICATION.md. Controlled
USE/USE, USE/DISCARD, USE/CORRECT, DISCARD/DISCARD, MOVE/MOVE, OPEN/OPEN,
CORRECT/CORRECT, FEFO/FEFO and same/different-key races. Full tenancy, event,
parity and validation coverage. Run focused T09, combined T08+T09, relevant
inventory/scan/shopping/cook, full suite, lint, typecheck, build, migration replay,
populated upgrade if applicable, local schema/query-plan and diff gates. Record
exact counts/failures; fresh remote checkout focused/typecheck verification.
READY FOR INDEPENDENT REVIEW only after all gates, pushed checkpoints and clean
tree; reviewer decides PASS. No T10 start.

## Absolute exclusions

Do not modify/fetch application deltas from legacy Frigo; no sync/cherry-pick/rebase
or reconciliation. No main merge/push (including T08), deployment, remote D1,
staging configuration, production flags/secrets, PayOS/payments/billing/webhooks,
unrelated auth/infrastructure or UI redesign. Numbering conflicts are reserved for
separate production reconciliation. Legacy main observation unavailable is explicit,
not permission to cross repository access boundaries.
