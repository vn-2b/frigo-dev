# T12 continuation notes (2026-09-12)

- **T12 application freeze (current): `d15600186c3e73faba011eb690ac6cd70e8d3d2d`** — closed-loop runtime
  verification fix (real D1 suite, route-level suite, explicit race
  classification, adopted-cook replay ordering). `22f675d` is historical.
  Docs HEAD: docs-only commit on top.
- The closed-loop suite is the permanent regression harness for the loop
  observation → reconciliation → T09 → lots → T11 → consumers.
- Removal conditions for every LEGACY_COMPATIBILITY path are in
  FINAL_AUTHORITY_MAP.md. The only remaining product work after universal
  adoption is deleting those fenced legacy branches — no redesign required.
- Reviewer-cited behavior: the adopted cook route only replayed on batch
  failure; the new route-level suite exposed the response-loss regression and
  the fix mirrors the legacy branch's replay-first order.
- T12 packet arrived truncated mid-§31 (cache audit). §0–30 were implemented in
  full; the §31 cache audit was completed from the visible requirement
  (adopted reads must bypass stale KV) and documented in FINAL_AUTHORITY_MAP.md.
  No post-T12 task was started.
- **Post-review remediation (2026-09-12):** app freeze `64c5501ab0110658718b3752bd84e537f0854e12`
  closes review defects D3 (guest→register client contract, DEC-015) and D1
  (`.hoplite/settings.json` restored); D2 is documented as `SAFE_DEFERRED`.
  **Follow-up `MEAL_PLANNER_AUTHORITY_CUTOVER`** must land before
  `MEAL_PLANNER_ENABLED` is enabled for adopted households. See
  `docs/ai/release/INVENTORY_TRUTH_REMEDIATION.md`.
