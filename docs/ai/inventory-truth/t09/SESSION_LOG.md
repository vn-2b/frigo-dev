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

## 2026-09-11 — writable continuation recovery

Fresh remote T09D base 811f7e8463303e010199741d66f88ab8a817212d verified via broker
and provider evidence in green-1a/frigo-dev. Application remains b036b25; only
published documentation follows it. Initial base publication was denied because
Hoplite protects its configured base. User then explicitly authorized generated
successor hoplite/orchemenos-e002591e. Switched to that already-existing branch
at exact base HEAD; merge-base equality PASS. No history rewrite or base push.
Pre-existing settings overlay preserved in named stash; CONTINUATION.md records it.
Frozen install, 835+196 focused tests (all eight intended files) and typecheck PASS.
No application change. Publish/fetch this docs-only checkpoint before E source;
subsequent receipt will record its exact SHA. Main/legacy/remote D1/PayOS untouched.

## 2026-09-11 — T09E local multi-effect FEFO checkpoint

Successor docs 8bf32ed4e41ed3341215c6376e0c13ef13043616 published/fetched before
source work; exact frozen-base ancestry retained. E adds pure deterministic FEFO
USE, bounded 1–32-effect atomic persistence, v2 receipt/event replay and additive
0027; historical v1 predicates and 0023–0026 remain unchanged. Snapshot/JSON limits
and exact unit support are recorded in DEC-011. No adoption or live writer exposure.

Fixed real D1 expression-depth failure, SQL NULL/missing JSON fail-open and review
P1 fingerprint-mode/result-envelope classification before payload comparison.
Valid historical v1 collisions remain conflicts. Post-replay-fix completed logs:
1,170 focused / 11 files, 2,657 full / 98 files, lint/typecheck/build/migration smoke
PASS; fresh isolated local D1 27-migration apply and schema gate PASS. A later
ordered/renumbered receipt finding added an intended-result completion fence and
one schema regression: 131 focused / 3 files PASS. Earlier full totals do not
cover this later change; final regates/review and publication remain pending.

Docs-only follow-up inspected logs and current implementation, updated handoffs,
and reran read-only isolated D1 schema plus diff/0023–0026 immutability/ancestry
checks. No source edits or commits by the docs agent; existing parent changes,
including DEC-011 and the initial manifest audit, preserved. Exact commands and
counts: VERIFICATION.md. E has no published application SHA yet. Next: finalize
E gates/review, commit/publish/fetch successor and prove equality before F.
F–H not complete; no application freeze, review-readiness, UI/browser, main,
legacy production, deployment, remote D1, PayOS or T10 claim.
