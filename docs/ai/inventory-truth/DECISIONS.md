# Inventory Truth architecture decisions

## DEC-010 — Validate retained receipts and bind event inserts to declared effects

T09D review reproduced valid-JSON but malformed receipts returning successful
replays, and command-associated events unrelated to the receipt's effects. These
required corrupt/misbound persisted input; no normal caller authorization bypass
was found. Validate retained result shape, identity, actor, household, version and
effect/event evidence in one authorized read batch before replay, including
collision/response-loss recovery. Corruption fails with CORRUPT_RECEIPT and no
repair/write; payload differences still fail IDEMPOTENCY_CONFLICT. Historical
results are checked against retained evidence, not newer live stock.

Add 0025 insert guards tying new command events to the receipt's declared effect
and metadata. A no-op receipt permits no event; an unrelated owned lot is not
sufficient authority. Keep 0024 and all earlier migrations immutable, preserve
command_id-NULL historical event behavior, and do not rewrite existing evidence.
Follow-up review reproduced matching receipt/event corruption contradicting the
stock just written (USE 2, stock 8, evidence 7). Add 0026 to bind the declared
after snapshot to persisted lot fields and core projection parity at event insert.
0025 had already been applied locally; retain it unchanged rather than rewriting
an applied migration. Historical replay still uses retained evidence, not current
stock. Add paired-surface corruption tests, not just one-field divergence tests.
These are consistency guards, not cryptographic protection against a database
administrator capable of dropping triggers or forging all mutually consistent
records. T09E/F still own multi-lot allocation and legacy writer integration.

## DEC-007 — Isolated development repository and publication-first T09

User corrected the target to vn-2b/frigo-dev on 2026-09-10. Exact T08 remote HEAD
8f8788c1a0c9e486657751ef3875a5baa5334dec is the immutable T09 base, not main.
Use broker-authorized hoplite/euhesperides-d77023a5; publish/fetch before code and
at each phase. Legacy production deltas are expected and must not be synchronized.
No main merge, production/staging, remote D1, payments or T10 authorization.
This supersedes historical repository/current-branch clauses only.

## DEC-008 — Remaining usable quantity and explicit correction lifecycle

T09 live quantityMilli is CURRENT REMAINING USABLE QUANTITY. ACTIVE requires
positive quantity; CONSUMED and DISCARDED require zero. Partial USE/DISCARD stays
ACTIVE; final decrement selects the corresponding terminal state. History belongs
in new immutable inventory_events, never retained as terminal positive quantity.
Normal operations cannot revive terminal lots. CORRECT revival must be explicit,
reasoned, authorized and version-fenced with before/after/delta evidence. OPEN and
MOVE require ACTIVE; repeated OPEN is deterministic no-op, not another event.
New live CREATE requires known canonical identity or nonblank trimmed rawName;
do not tighten historical T08 backfill identity assumptions retroactively.
T09 will validate calendar/instant timestamps at the live boundary and preserve
unknown expiry/money semantics. Database protection design follows the audit.

## DEC-009 — Narrow command receipts, mapped projection and household revision

T09 persistence will reuse the existing command-ID/fingerprint/result pattern and
inventory_events, not add a second event framework. A synchronous inventory_commands
receipt is inserted in the same D1 batch as effects; unique household/key collision
replays the stored result only after actor/membership/fingerprint validation.
No durable processing lease is needed for these synchronous native commands.

One live lot maps to one legacy inventory row. Add a nullable unique legacy_item_id
mapping rather than overloading provenance source_id or aggregating identity away.
The mapping stays in persistence metadata, not the strict T08 domain object.
Validate both sides' household and prohibit silently clearing/changing mappings.
T08 snapshots remain explicitly unadopted; full source parity is required before
adoption, and ongoing live parity must not reuse T08's version=1/ACTIVE-zero checker.
Zero ACTIVE snapshots require explicit correction/evidence, not silent lifecycle
inference. Backfill must not manufacture duplicate snapshots for native projections.

A bounded positive household inventory_version, advanced by inventory_items,
inventory_lots and storage_locations mutations, fences the snapshot once at the
start of the command batch. Ownership updates advance both affected households.
This intentionally coarse fence detects FEFO candidate phantoms and source edits;
per-lot and per-projection CAS still remain mandatory. Revision equality does not
excuse pre-existing drift. CAS misses must force a SQL constraint failure inside
the batch, never be detected only after commit.

New command-associated inventory_events are immutable during household lifetime;
old events remain readable, and existing household deletion/cascade is retained.
Guest transfer of adopted stock/history needs an atomic guarded transfer or explicit
fail-closed policy propagated outside the legacy swallowed-error loop. Preflight
alone cannot defeat a concurrent activation. No new engine HTTP exposure until
the legacy-writer integration phase closes those paths.

This requires additive schema after 0023; never rewrite T08 migrations. Local
replay, populated upgrade and real local D1 guard checks are implementation gates.

## DEC-001 — Isolated foundation authority

Context: T01–T07 release reconciliation proceeds independently on main.
Decision: Only canonical T08 branch; current legacy readers/writers remain intact.
Reason: Foundation must not change existing production inventory behavior.
Alternatives: Immediate cutover/dual-write rejected as T09+ scope.
Consequences: Lots are an explicit point-in-time foundation snapshot, not live truth.
Related files: MASTER_CONTEXT.md; future T08 leaf domain/repository modules.
Related commit: Initial T08 documentation checkpoint (see git log).

## DEC-002 — Exact bounded milli-quantity adapter, no runtime rewrite

Context: Legacy REAL accepts quantities not representable at a fixed scale; T02
already has exact Quantity arithmetic. SQLite text casts may lose number precision.
Decision: Persist safe-integer milli-units of g/ml/piece/pack/bunch/slice; adapt
kg/l exactly through Quantity. Reject negative, nonfinite, overflow or sub-milli
quantities before writes, with source row diagnostics. Never round them silently.
Reason: Small deterministic foundation without rewriting existing quantity paths.
Alternatives: REAL lots rejected for drift; arbitrary precision SQL decimal/rational
engine deferred. Runtime REAL and Quantity implementation are unchanged.
Consequences: Backfill is an explicit internal TypeScript operation, not an automatic
data SQL migration. Unsupported legacy data blocks the household batch unchanged;
operator reconciliation or a separately reviewed representation extension is needed.
Related files: inventory-truth leaf modules and 0023 schema.
Related commit: T08 implementation checkpoint (see git log).

## DEC-003 — Preserve unknown legacy identity and expiry evidence

Context: Ingredient FK may be NULL; legacy expiry can exist without kind/source.
Decision: Nullable ingredient plus raw name; raw legacy expiry/kind/source are retained
separately. Only explicit best_before/use_by with non-unknown, non-estimated source
maps to dated label evidence. Estimated source OR kind remains ESTIMATED; otherwise
UNKNOWN. KNOWN means a supplied dated fact, never independent verification/safety.
Reason: No fabricated ingredient, purchase time, receipt, price or date authority.
Alternatives: Infer from freshness/added_date/data_source/default shelf life rejected.
Consequences: Malformed dates are retained raw but not projected as trusted dates.
Money/purchasedAt stay NULL; openedAt accepted only if an existing valid instant.
Related files: lot adapter/domain contracts; legacy fields remain untouched.
Related commit: T08 implementation checkpoint (see git log).

## DEC-004 — Point-in-time explicit backfill; no parallel live inventory

Context: Old writers continue changing/deleting inventory_items after T08.
Decision: Deterministic lot/location IDs, unique LEGACY_BACKFILL source identity,
insert-only retries. Preflight validates all supplied rows before atomic D1 batch;
source row snapshot guards reject stale insertion. No source FK to inventory_items,
triggers on old writers, mutation endpoint, live sync or event changes.
Reason: Preserve legacy commands and history; dual-write/event authority is T09.
Alternatives: SQL rounding, update-on-retry, automatic dual-write rejected.
Consequences: Parity proves an explicit snapshot, not perpetual equivalence; later
legacy edits/deletes/new rows are surfaced as drift, never overwritten on rerun.
Household-scoped repository helpers require an already authorized server caller.
Related files: repository backfill, projection/parity, persistence tests.
Related commit: T08 implementation checkpoint (see git log).

## DEC-005 — Source revision and safe publication boundaries

Context: Guest transfer can change legacy household without a revision bump; the
platform denies publishing this user-required canonical branch from this thread.
Decision: Preserve legacyVersion separately from initial lot version=1, and guard
all backfilled source fields in the atomic insert. No FK to mutable legacy identity.
Keep IN_PROGRESS while publication is blocked; do not substitute a hoplite branch.
Reason: Preserve old commands, diagnose source drift and respect both authorization
and the user's explicit only-canonical-push requirement.
Alternatives: Modify auth or silently change branch rejected. T09 owns transition policy.
Consequences: Local verification is not cross-account Git availability or completion.
Related files: packages/db/src/inventory-truth.ts; CURRENT_STATE.md; VERIFICATION.md.
Related commit: dd2ecc6f7066250dfdc5214a3d6c356e1479b61e (code); following docs checkpoint.

## DEC-006 — User-approved publication branch substitution

Context: Trusted publication rejected the requested feature branch; the user
explicitly approved `hoplite/xanthos-7d942897` instead on 2026-09-10.
Decision: That exact branch is the canonical cross-account handoff/publication
branch. Fast-forward it to the existing T08 lineage without rewriting any commit.
Reason: Satisfy durable Git handoff within both user and platform authorization.
Alternatives: Credential/policy bypass, force push or main publication remain forbidden.
Consequences: Supersedes only canonical-name clauses in DEC-001/005 and the original
task packet. All no-main/no-deploy/no-remote-D1/no-PayOS boundaries are unchanged.
The original feature branch remains a local historical alias, not the published source.
Related files: MASTER_CONTEXT.md; CURRENT_STATE.md; T08 task packet and final report.
Related commit: docs-only authorization checkpoint after 4cc290f (see Git log).
