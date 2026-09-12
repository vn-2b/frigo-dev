# T12 continuation notes (2026-09-12)

- T12 application freeze: recorded in VERIFICATION.md / parent docs (exact SHA
  in the final report). Docs HEAD: docs-only commit on top.
- The closed-loop suite is the permanent regression harness for the loop
  observation → reconciliation → T09 → lots → T11 → consumers.
- Removal conditions for every LEGACY_COMPATIBILITY path are in
  FINAL_AUTHORITY_MAP.md. The only remaining product work after universal
  adoption is deleting those fenced legacy branches — no redesign required.
- T12 packet arrived truncated mid-§31 (cache audit). §0–30 were implemented in
  full; the §31 cache audit was completed from the visible requirement
  (adopted reads must bypass stale KV) and documented in FINAL_AUTHORITY_MAP.md.
  No post-T12 task was started.
