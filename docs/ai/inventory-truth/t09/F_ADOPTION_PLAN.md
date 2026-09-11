# T09F adoption and writer integration — implementation plan

E code `9bd1e6bc000cd2e94121469babb1a5eb63a5047f` was published/fetched on
`hoplite/orchemenos-e002591e`; local/remote equality and exact frozen-D ancestry
passed before F work. This file records remaining implementation, not acceptance.

## Explicit adoption

- One authorized, bounded, revision-fenced transaction owns snapshot creation,
  adoption mapping and evidence. Do not backfill and activate in separate commits.
- Preserve `t08-legacy:<itemId>`, `LEGACY_BACKFILL`, source identity and raw expiry/
  opening evidence. Never fabricate MANUAL provenance or rename historical lots.
- Validate full source parity before any write. Reject drift and unrepresentable
  quantities. Historical ACTIVE-zero snapshots need explicit terminal-state
  evidence; adoption must not guess whether they were consumed or discarded.
- Create any missing unlinked snapshots before establishing the first mapping:
  0024 blocks backfill inserts once a live mapping exists.
- Keep independent lot/projection versions and legacy kg/l display units. Native
  quantity arithmetic remains exact canonical milli-units.

## Compatibility authority

`requireParity`, both executor admissions, replay and SQL guards currently assume
native IDs equal legacy IDs and reject LEGACY_BACKFILL. Replace those assumptions
only through explicit evidenced adoption, not a blanket provenance bypass.

Historical v1 has no explicit legacy ID; v2 does. Adopted/route commands need a
versioned receipt carrying the immutable mapping and complete lot/projection
before-and-after evidence, with narrowly dispatched additive SQL guards. Historical
replay must not query today's mutable stock to recover a mapping. Existing v1/v2
validation remains supported; reuse inventory_commands and inventory_events.

## Route composition

Prepare all effects without committing, then execute one batch containing actor/
household/source fences, receipt, every projection/lot CAS, events, poststate checks
and final route completion. Never loop separately committed native executors.

- Manual: preserve IDs, optional idempotency keys, If-Match/version behavior and
  response contracts. Fingerprint category/dataSource and all mutable projection
  metadata; do not infer USE_BY from a bare expiryDate. A combined edit and move
  is one command, not multiple commits.
- Scan: reviewed draft changes and confirmed status remain atomic with stock.
  Offline recovery of an existing server scan retries its confirmation identity;
  it must not create differently keyed manual additions after response loss.
- Shopping: retain command fingerprint, lease/fence and completion-last semantics;
  add stock snapshot/CAS protection without changing Week compatibility behavior.
- Cook: plan all ingredient deductions with deterministic FEFO against one shared
  remaining-stock snapshot; commit cooked_meals and every lot effect together.
- Guest transfer: DEC-012 requires explicit preflight rejection, no swallowed
  partial ownership moves and no false migratedFromHouseholdId.
- Backfill/internal tools: stay insert-only; never refresh drift. Every legacy
  writer needs an in-transaction adoption fence so native/adopted households cannot
  fall back to inventory_items-only writes.

## Required proof before F completion

Adoption preservation and failure atomicity; mapping/provenance/display-unit
round trips; metadata fingerprint conflicts; historical replay after later stock
changes; controlled activation/writer and response-loss races; late rollback with
scan/shopping/cook completion state included; guest source/target byte preservation;
all writer-map classifications with executable evidence; actual local D1 gates.
Then publish/fetch/equality-check F before full G hardening and H freeze. F–H
remain incomplete; do not start T10 or declare independent-review readiness.
