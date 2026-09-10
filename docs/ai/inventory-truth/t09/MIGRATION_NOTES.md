# T09 migration notes

T08 lineage ends at `0023_inventory_truth_foundation.sql`. T09C adds
`0024_inventory_lot_commands.sql`; no applied T08 migration was modified.
Do not modify applied migrations. Additive schema only when actual constraints
need it; clean replay and populated upgrade must pass locally.

Audit D1 batch rollback and CAS assertion behavior before asserting atomicity.
A zero-row CAS UPDATE is not itself a transaction failure.

POTENTIAL FUTURE MIGRATION NUMBER RECONCILIATION: legacy production may add an
identically numbered migration independently. Do not fetch/merge/cherry-pick it.
Resolve numbering only in the separately authorized final reconciliation task.
Remote D1 and staging/production operations are prohibited.

## T09A transaction audit

Cloudflare D1 documentation (2026-06-22 revision, consulted 2026-09-10):
https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
`batch()` executes sequentially as a SQL transaction; a statement failure rolls
back the whole sequence. Zero changed rows do not count as failure.

Existing cook uses an intentionally invalid inventory_events INSERT immediately
after a failed CAS to trigger NOT NULL rollback. T08 backfill similarly forces
NULL quantity on stale source. Reuse this fail-closed mechanism, not a post-commit
row-count check or `version = expected+1` postcondition (another writer can match).
The real SQLite D1 helper runs BEGIN IMMEDIATE with rollback and provides before/
after batch hooks for deterministic scheduling. Runtime local D1 proof is pending.

A narrow durable command receipt table is likely required: no uniform inventory
command table exists (only cooked_meals, scan status and shopping_import_commands).
One synchronous receipt INSERT + all effects in one batch avoids processing leases
and reuses the existing key/fingerprint/result pattern, not a new event framework.
Native lot-to-legacy identity must not overload provenance source_id. T08 schema
does not constrain terminal quantity/state or event immutability; final additive
design and populated-data preflight will be documented before implementation.
Strict FEFO must guard the entire eligible snapshot, including candidate phantoms,
not only CAS the allocated lots. Existing REAL projection requires exact round-trip
validation rather than SQL rounding.

## Implemented T09C schema

- `inventory_commands`: immutable synchronous household/key receipt, authenticated
  actor, complete fingerprint and stored result. No second event ledger or lease.
- Nullable unique `inventory_lots.legacy_item_id` links a mapped lot to its legacy
  row. Tenant guards protect both directions; mapped rows cannot be replaced,
  relinked, physically deleted or moved between households by old transfer SQL.
- Mapped lots enforce positive ACTIVE / zero terminal and version increments.
  Unmapped historical T08 snapshots retain their original permissive lifecycle.
- `inventory_events.command_id` links new immutable evidence; command/projection
  ownership is enforced. Old history remains readable and old unassociated event
  behavior unchanged. Immutability lasts for the household lifetime; explicit
  household cascade deletes its own stock/receipts/events as before.
- SQLite INSERT OR REPLACE cannot bypass mapped-row/receipt/event protections.
- Household inventory_version advances for inserts/updates/deletes on inventory
  items, lots and locations, including both households for old ownership moves.
- T08 backfill is rejected after a live mapping exists, including inside a racing
  batch, preventing synthetic duplicates of native projections. The C executor
  refuses mixed/unadopted households; no implicit activation or repair exists.

Fresh 24-migration SQLite/real local D1 replay and populated T08 upgrade are tested.
D1 denies `PRAGMA integrity_check` (SQLITE_AUTH); its runtime test uses supported
`quick_check` plus FK checks. Full integrity_check remains in real SQLite schema
and migration tests; no coverage was silently removed. Actual D1 tests prove
top-level changes(), exact RETURNING and rollback after a later CAS guard failure.
Final exact counts/commands are in VERIFICATION.md. No remote database touched.
