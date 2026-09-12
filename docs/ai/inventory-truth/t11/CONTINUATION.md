# T11 continuation state

- Historical first T11 freeze: `657201f3a12f18dd96cc96adeac0dd1d3b75e6f4` —
  `feat(t11): canonical inventory read authority with projection cutover` —
  published on
  `hoplite/himera-6d3eda84-t10-observation-reconciliation-t11-inventory-read-authority`
  as **PR #3** (base: the release train `hoplite/kydonia-2785bb72`; main NOT a
  target). Corrective commit `4553b8a` removed the platform auto-committed
  workspace overlay (`c7e2296`) from the branch; the overlay file is preserved
  byte-for-byte in the workspace (SHA-256 `6d8f5b45…`) and uncommitted.
- Lineage: train merge `30ce4ea` contains the required base `c71692a` (T10
  docs HEAD); T10 freeze `7393edc` and T09 freezes are ancestors. Main
  `d1b0673` untouched, NOT merged.
- Docs HEAD: docs-only commit on top of the branch tip; exact SHA in the final
  report.
- **T11 application freeze (current): `c15c9a81fc4367b3506a7e2693798ebe1424b0a9`** —
  `fix(t11): complete read authority runtime hardening` — published/fetched,
  local == remote == clean-checkout SHA. Closes: real-D1 T11 proof (11 cases),
  adopted-but-empty regression (integration + real D1 + HTTP), READ vs
  MOVE/DISCARD/FEFO barrier tests, `activeCount` semantics, explicit kg/l
  display-alias compatibility (authority stays canonical), freshness
  fail-closed hardening. Not published through PR tooling (overlay safety).
- last application SHA: c15c9a81fc4367b3506a7e2693798ebe1424b0a9
- test status: full 3,063/3,063 across 116 files; real D1 62/62; all static
  gates PASS (lint, typecheck, build, 30-migration smoke, local schema gate);
  `git diff --check` clean; clean detached checkout at the exact freeze SHA
  repeats everything with EMPTY status (receipt in VERIFICATION.md/final
  report).
- Read authority is live for adopted households through the funnel
  (`fetchHouseholdInventoryFromDb`): `GET /inventory`, recipes, scans list
  reads, weekly planner, notifications. Legacy-only raw reads are documented
  `INTENTIONAL_LEGACY_READ` behind authority-mode gates. No dual-truth
  fallback anywhere; corruption fails closed.
- Remaining P0/P1: NONE. Remaining known compat notes (documented, deliberate):
  legacy scan-confirm candidate grouping still reads the projection for
  non-adopted confirmations (adopted confirms re-derive from
  `readAdoptedLotSnapshot`); T12 owns receipt/vision UX and Inventory UX V2.
- Next: independent review of PR #3. Do NOT merge to main, deploy, run remote
  D1, touch PayOS, or start T12 from this thread.
- Note: the T11 task packet arrived truncated mid-§32; the visible §0–31
  requirements plus the §32 adoption gate were implemented; completion follows
  the established train conventions.
