# T09F adoption and writer integration — implementation plan

## IMPLEMENTED — 2026-09-11 (9bf9ac0fe7b5e0d39615f39ae5cc30f84569af2f)

The adoption authority is live: `executeInventoryAdoption` owns the snapshot read,
validates authority/snapshot completeness independently, executes the pure plan in
ONE batch (household CAS bump, UNIQUE receipt, missing locations, missing snapshots,
mapping/terminal evidence, poststate fence) and replays response-loss retries from
the receipt. Empty households receive durable explicit activation evidence. Mapped
LEGACY_BACKFILL provenance is accepted only through that evidence. All required
proofs pass: adoption atomicity/failure rollback, mapping/provenance/display-unit
round trips, terminal evidence, metadata fingerprint conflicts, replay after later
stock changes, activation/writer races, G11/G12, guest byte preservation and all
writer-map classifications with executable evidence. F = COMPLETE.

## Current recovery increment — 2026-09-11

Canonical repository `vn-2d/frigo-dev`, successor `hoplite/kos-2a686759` directly
from interrupted `66858c5`; transfer/ancestry and baseline PASS. Authority and
publication receipts: CONTINUATION.md. Earlier owners are historical provenance.

Implemented preparation/safety, not full adoption:

- Pure `planInventoryAdoption` with full projection evidence, 32/1,000 bounds,
  missing-snapshot ordering, preserved identities/units/versions and explicit
  terminal-zero evidence. No executor, activation, receipt or route cutover yet.
- Legacy route families fence mapped authority inside their stock transaction;
  scan/shopping also fence stock revision. Mapped households are SAFE-DEFERRED
  until functional adapters exist, not silently mutated via the legacy projection.
- Server-scan transport loss retains confirmation identity; local-only drafts
  retain their manual flow. Shopping first-claim, lease and response-loss recovery
  preserve exact command identity and completion-last behavior.

Exact next implementation: additive, narrowly dispatched v3 adoption/compatibility
receipt authority without weakening v1/v2; persist the adoption plan in one authorized
fenced batch with immutable activation evidence, including empty households. Do not
execute planner output as separate inserts/mappings or activate before extending
writer admission. Then replace mapped-household refusals with functional adapters.

Outstanding reproduced invariant: confirming 2 eggs, then retrying the same scan
with 9 eggs, returns 200 replay while retaining 2. Original confirmation intent and
result must be retained and checked in all three confirmed-state branches; never
derive historical identity from today's stock or newly hydrated scan rows. Also
cover queued changed review, membership revocation, and contextual/name-based cook
demands. G/H cannot be declared complete from these partial safety tests.

## Original remaining F contract (unchanged)

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
