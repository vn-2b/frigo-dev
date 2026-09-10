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
