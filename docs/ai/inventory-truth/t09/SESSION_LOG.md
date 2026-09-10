# T09 session log (append-only)

## 2026-09-10 — initial publication and review packet

Repository identity initially blocked: prompt said Tungjpstore/frigo-dev; origin
was vn-2b/frigo-dev. User explicitly confirmed vn-2b/frigo-dev. No remote rewrite.
Started on authorized hoplite/euhesperides-d77023a5 at exact fetched T08
8f8788c1a0c9e486657751ef3875a5baa5334dec. Published this SHA before implementation;
broker fetch and shell equality PASS. Main anchor d1b0673; no main writes.

Pre-existing `.hoplite/settings.json` overlay preserved, not committed or lost:
named local stash 839a8dc67df59945c9ea0f19937f7bdff5b1df7b. It is workspace-only,
not part of T09. Versioned setup reinstated without modifying tracked config;
manual execution succeeded after managed setup tool claim failed.

T09A audit in progress; initial packet and lifecycle policy checkpoint created.
No T09 application changes or fresh test claims. Exact next action: complete the
writer and D1 atomicity audit, run T08 focused baseline, commit/publish T09A before
implementing command contracts. Phase checkpoints require targeted tests, docs,
diff check, commit/publish/fetch and local/remote SHA equality.

LEGACY_FRIGO_MAIN_SHA_OBSERVED=UNAVAILABLE (repository-bound tool authority).
Production deltas intentionally not reconciled. Legacy Frigo, development main,
production/staging, remote D1 and PayOS untouched. T10 not started.

## T09A — audit/lifecycle checkpoint

Initial packet e56f163 published and fetched. Fresh T08 baseline 130/130 PASS.
Audit found six live backend writers, offline scan fallback and guest transfer;
no live auth demo stock seed or separate scan-correction route. Full map includes
non-live helpers/fixtures/jobs. DEC-008 fixes lifecycle before implementation.
D1 transaction design must force CAS misses to abort inside batch; full candidate
snapshot must fence FEFO phantoms. See MIGRATION_NOTES for actual docs/mechanism.
T09A complete after this docs checkpoint is published. Next: T09B pure command
contracts/tests; no persistence implementation before that phase checkpoint.

## T09B — verified command contracts

T09A c212ded published/fetched before implementation. Added six pure command
contracts/planners and 202 unit tests; combined T08/T09 332/332 PASS, targeted
eslint and typecheck PASS. Parent reviewed domain source and reran combined tests.
T08 schemas/backfill remain unchanged. DEC-009 records the audited additive
persistence design before T09C. No routes or live writers changed yet.
Next: publish/fetch T09B checkpoint, then implement T09C atomic repository/schema
with narrow receipts/mapping/revision fence. T09 is IN_PROGRESS, not review-ready.
LEGACY_FRIGO_MAIN_SHA_OBSERVED remains UNAVAILABLE; no legacy/main/production action.

## T09C — native atomic repository and schema checkpoint

Started from published/fetched 5d10bc5. Added internal native executor and additive
0024 schema. Authenticated membership is checked before replay and inside mutation
batch; whole-household revision fences stale snapshots, and lot/projection CAS
guards abort the batch. Stored receipt/result, exact projection and immutable
event commit together. Native CREATE/USE/DISCARD/OPEN/MOVE/CORRECT implemented;
no HTTP exposure, FEFO, historical adoption or legacy-writer cutover.

Parent review corrected terminal legacy freshness (zero -> out_of_stock; nonterminal
unchanged-expiry commands preserve prior status). It also added a household-wide
ADOPTION_REQUIRED gate so native activation cannot strand legacy-only stock behind
the post-activation backfill guard. Tests retain no-effect assertions while updating
error precedence to this deliberate gate. T08 historical backfill is unchanged.

Runtime issue: D1 rejected full integrity_check with SQLITE_AUTH. Supported D1
quick_check/FK checks now run alongside unchanged full SQLite integrity checks.
Initial schema-proof D1 data was preserved under ignored .hoplite/artifacts/t09/
before a fresh final-schema local replay. No remote DB operation occurred.

Targeted/native/runtime and full-suite evidence is in VERIFICATION.md. Next essential
milestone: commit/publish/fetch C, then T09D authority hardening and T09E FEFO before
T09F adoption/writer integration. T09 remains IN_PROGRESS, not independent-review-ready.

## T09C publication receipt

13133b3aad214f2dbe7bdfb0c6ad9a70483d32de committed, published and fetched.
Final C gates: 507 focused; full 1,994 / 93 files; lint/typecheck/build;
24-migration replay/populated upgrade/local schema; diff checks PASS. Fresh
fetched-source detached worktree also passed 507 tests and was left clean after
removing its dependency-only symlink. Main d1b0673 and T08 8f8788c unchanged.
No remaining C verification failure. Full T09 still awaits D–H; do not confuse
this native-core code checkpoint with final application freeze or readiness.

## T09D implementation and final local gates

Resumed at published C 13133b3, reviewed pending documentation, committed/published/
fetched cc3121d9ec9a11f0b0ed0cbbe3ad8199083ce144 and proved local/remote equality
before D edits. Canonical repository and all exclusion boundaries retained.

D adds strict historical replay validation, additive 0025 event binding and 0026
written-poststate coupling. Review reproduced three evidence-integrity gaps;
all are fixed and covered by negative tests plus valid controls. 0025 was already
locally applied when the paired-evidence gap was found, so 0026 is additive.
No applied schema, historical event or retained receipt was rewritten by migration.

Final parent-executed gates: 1,031 focused / 8 files; 2,518 full / 95 files;
lint/typecheck/build; 26-migration replay, populated upgrade, local D1 apply/schema;
diff/protected-path checks PASS. Exact commands, timestamps, intermediate gates and
corrected findings are in VERIFICATION.md. Only docs changed after these final gates.
Next: publish/fetch/verify this D checkpoint and run fetched-source focused/typecheck
proof. E FEFO is the next implementation phase, followed by F writer integration;
G/H and final T09 readiness remain pending. No T10 or protected-surface changes.

## T09D publication receipt

b036b257a8ad775dd6f1a445dcfdcce38a6babf1 committed/published/fetched; exact
local/origin equality PASS. Authorized main and T08 fetches remain d1b0673 and
8f8788c respectively. Separate fetched-source worktree passed 1,031 tests / 8
files and both TypeScript projects, then verified clean after dependency symlink
removal. Full verification is in VERIFICATION.md. This following docs-only
checkpoint finalizes the milestone handoff. T09 stays IN_PROGRESS, next T09E;
no unresolved D check failure, no PR/deployment/main/remote D1/PayOS operation.
