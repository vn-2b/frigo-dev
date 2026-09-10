# T09 writer map

Status: audit in progress. No writer is considered migrated yet.

Required columns: Writer; Entry point; Files; Current tables mutated; Current
event emitted; Current CAS; Current idempotency; Migration required in T09?;
Final T09 status.

Audit covers manual add/edit/delete/discard, scan confirm/correction, shopping
import, cook completion, adjustment, household/guest transfer, seed scripts,
background jobs, tests/factories and raw SQL helpers/callers. Each final entry must
be MIGRATED, ADAPTED, DEFERRED WITH SAFE REASON or NOT A LIVE MUTATION.
An unadapted live legacy writer without safe rejection prevents completion.
