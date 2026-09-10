# T09 migration notes

T08 lineage ends at `0023_inventory_truth_foundation.sql`. No T09 migration yet.
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
