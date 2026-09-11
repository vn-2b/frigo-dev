# T10 — Observations and Reconciliation

T10 adds the observation/evidence/reconciliation layer on top of the verified T09
Inventory Truth + Lot Authority foundation, without merging main, deploying,
touching remote D1/PayOS, starting T11, or introducing a hidden parallel stock
writer.

## Status

T10G COMPLETE. Application freeze
`6c28858acd0627d2d602998107c2e260c5e4f0d5` — `feat(t10): add inventory
observation reconciliation authority` — published/fetched on
`hoplite/himera-6d3eda84-t10-observation-reconciliation` (local == remote),
descended from the verified T09 lineage via the train-merge commit
`668920fa462524e65a79d31a7b0844720baf38e0` (all T09 freeze SHAs, including
`bf391c5fdcdd9e9c2f2257db515815e082cb4381` and docs HEAD
`d522769ae89496fd4b3f26419f1fdfe23d9e926a`, remain ancestors). Full gates PASS
from the exact remote SHA in a clean detached checkout with empty status.
**T10 COMPLETE — READY FOR INDEPENDENT REVIEW.** T11 is NOT STARTED.

## What T10 is

Deterministic evidence above T09 authority. It answers: what was observed, with
what evidence, how it compares with authoritative inventory, whether it is
consistent/ambiguous/stale/conflicting, what explicit action would reconcile it,
and who confirmed that action.

## Hard invariants (all enforced and tested)

- `UNKNOWN != ZERO`, `ESTIMATED != CONFIRMED`, `OBSERVED != VERIFIED`
- `OBSERVATION != inventory mutation` — observation persistence never writes
  `inventory_items` / `inventory_lots` / `inventory_events`
- Evidence is not truth merely because it exists; a reconciliation result never
  fabricates certainty
- T09 lot/event authority remains the ONLY stock mutation authority; decisions
  compose existing T09 `CORRECT`/`MOVE` commands, never raw SQL updates
- No name-only matching, no contextual unit conversion (pack/bunch/slice into
  mass/volume), no rounding, no estimated-over-confirmed expiry
- Read path unchanged: T09 truth remains the only inventory read authority;
  global read cutover belongs to T12

## Documents

| Document | Content |
| --- | --- |
| `OBSERVATION_SOURCE_MAP.md` | T10A exhaustive source audit and classifications |
| `CONTINUATION.md` | Lineage, freezes, exact next action |
| `INVARIANT_MATRIX.md` | Invariant → enforcement → test evidence |
| `TEST_MATRIX.md` | Every required test and its result |
| `VERIFICATION.md` | Exact commands, counts and clean-checkout receipt |
| `CHANGE_MANIFEST.md` | Every file added/changed and why |

## Boundary statements

- T11 (receipt/vision truth, Inventory UX V2): NOT STARTED. T10 only provides
  the generic evidence contract (`RECEIPT` is already a valid observation
  source type) that T11 will consume. No camera/OCR/vision code exists.
- T12 (closed-loop integration): NOT STARTED. No planner/cook/shopping/
  notification read path reads observations.
- HTTP API surface: none added. The T10 surface is the domain + db service
  layer (`packages/domain/src/inventory-observations.ts`,
  `packages/domain/src/inventory-reconciliation.ts`,
  `packages/db/src/inventory-observations.ts`,
  `packages/db/src/inventory-reconciliation.ts`), mirroring the T09 precedent
  (T09 also shipped authority without new routes). T11 owns the UX endpoints.
