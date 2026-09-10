# Inventory Truth current state

## T09 development authority — 2026-09-10

Program: Inventory Truth Layer
Current Task: T09 — Inventory Lot Engine & Event Authority
Current Phase: T09D complete and published; E–H pending
Status: IN_PROGRESS
Canonical Development Repository: vn-2b/frigo-dev (user-confirmed owner correction)
Legacy Production Repository: Tungjpstore/Frigo (user packet; not accessed)
T09 Remote Branch: hoplite/euhesperides-d77023a5
T09 Base T08 SHA: 8f8788c1a0c9e486657751ef3875a5baa5334dec
frigo-dev/main SHA at T09 start: d1b06732f8a80db4e77986df31ff28d9f04641fa
Last Verified Remote SHA: b036b257a8ad775dd6f1a445dcfdcce38a6babf1
Do Not Merge To Main: YES
Do Not Sync From Legacy Frigo: YES
Production Deployment Allowed: NO
Staging Deployment Allowed: NO
Remote D1 Allowed: NO
PayOS Allowed: NO

Publication-first and A/B checkpoints published/fetched. C adds native atomic
executor, additive 0024, receipt/event/projection coupling and local D1 proof.
Unadopted/mixed legacy households fail ADOPTION_REQUIRED; no native HTTP route
or legacy writer cutover. Latest exact verification: t09/VERIFICATION.md.
Published C checkpoint 13133b3: 507 focused, 1,994 full / 93 files,
lint/typecheck/build, 24-migration/local schema PASS; remote worktree 507 PASS.
D adds validated historical replay and 0025/0026 event/effect/poststate guards.
Final local gates: 1,031 focused, 2,518 full / 95 files, lint/typecheck/build,
26-migration/local schema PASS. Three reproduced authority findings fixed.
Published/fetched D code b036b25; exact local/remote equality PASS. Independent
fetched-source worktree: 1,031 tests and typecheck PASS, clean source.
Next: E FEFO followed by F adoption/writer migration.
No T09 completion or application-freeze claim; G/H full acceptance remains pending.
Managed setup claim failed; existing setup executed successfully via shell.
Pre-existing settings overlay preserved in local named stash; see t09/SESSION_LOG.
Legacy SHA unavailable; production deltas intentionally pending reconciliation.

## Historical T08 completion receipt (superseded current-task fields below)

Updated: 2026-09-10 UTC, final verification and authorized publication
Current Task: T08
Current Phase: T08F Verification/Handoff — complete
Status: COMPLETE
Canonical Branch: hoplite/xanthos-7d942897 (user-approved handoff/publication branch; DEC-006)
Original Local Branch: feature/t08-inventory-truth-foundation (historical, not the remote handoff)
Base Main SHA: d1b06732f8a80db4e77986df31ff28d9f04641fa
Current HEAD: fb00f46d4633c9659e812be9f86119533973a8bd (verified/published checkpoint before this docs-only completion receipt; resolve final tip with git rev-parse HEAD)
Last Code SHA: dd2ecc6f7066250dfdc5214a3d6c356e1479b61e
Last Verified SHA: fb00f46d4633c9659e812be9f86119533973a8bd (source identical to Last Code SHA)
origin/main SHA: d1b06732f8a80db4e77986df31ff28d9f04641fa
Main Has Diverged Since Base: NO (final fetch)
Do Not Merge To Main: YES
Production Deployment Allowed: NO
Remote D1 Migration Allowed: NO
Branch Pushed: YES — authorized branch, confirmed by trusted publish and fetch

## Completed

T08A–F: dependency audit; strict location/lot/quantity/money/expiry/provenance
contracts; additive 0023 schema; explicit guarded insert-only legacy backfill;
compatibility projection; diagnostic parity; cross-account Git handoff.

Fresh final-session PASS: 130 focused tests, full 1,617 tests / 89 files, lint,
typecheck, build, 23-migration clean replay, populated 0022 upgrade, local D1 schema
gate and Git diff checks. Prior local D1 apply of all 23 migrations also passed.
All code/checkpoints are preserved in the authorized published lineage. Source,
tests, schema and scripts are unchanged since dd2ecc6; later commits are docs-only.
See T08_VERIFICATION.md and VERIFICATION.md for exact evidence and corrected failures.

## In Progress

None for T08. This docs-only completion receipt is published on the same branch.

## Not Started

T09–T12; no automatic authorization to start them. No production/staging rollout,
remote D1 migration, live lot dual-write or consumer cutover.

## Known Problems / Accepted Limits

No unresolved verification or publication failure. Historical canonical-name
publication denials are resolved by the user's explicit branch substitution,
not by bypassing broker authority. Historical logs remain append-only.

Sub-milli/overflow/invalid quantities fail backfill without rounding. Raw invalid
or unknown expiry remains unpromoted. Contextual/unmapped lots do not pool blindly.
Snapshots are not live authoritative stock: legacy mutations/guest transfers cause
parity drift, never implicit lot changes. Money supports VND/JPY/USD/EUR only.

## Exact Next Action

The next account should fetch/check out `origin/hoplite/xanthos-7d942897`, read the
six handoff documents in order, then diff Last Verified SHA..HEAD. Its expected
remaining diff is documentation-only. Review the T09 prerequisites in
T08_VERIFICATION.md; wait for a separate T09 task. Do not merge/rebase main,
force-push, deploy, touch remote D1 or modify PayOS.
