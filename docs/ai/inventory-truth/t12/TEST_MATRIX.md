# T12 test matrix — closed loop (2026-09-12)

Permanent suites at freeze `d156001` (`22f675d` historical):
`inventory-closed-loop.test.ts` (9), `inventory-closed-loop-routes.test.ts` (5,
real Hono routes), `inventory-closed-loop-d1.test.mjs` (8, real workerd/D1),
plus the retained T09/T10/T11 suites. All rows PASS.

## Runtime-verification rows (new freeze)

| Requirement | Test | Result |
| --- | --- | --- |
| Real D1: observation → accepted CORRECT+MOVE → T09 → T11; exactly once; replay; altered-key conflict | real D1 A | PASS |
| Real D1: DISMISS inert (lot 10, no stock command, read 10, observation RECONCILED) | real D1 B | PASS |
| Real D1: read → USE 200 g → read, no KV | real D1 C | PASS |
| Real D1: FEFO multi-lot current/historical views | real D1 D | PASS |
| Real D1: projection drift 8 vs 100 → read 8, QUANTITY_DRIFT, funnel 8 | real D1 E | PASS |
| Real D1: response-loss retry, no duplicates; altered key conflict | real D1 F | PASS |
| Real D1: cross-tenant read/reconcile/mutate/legacy-resolve rejected | real D1 G | PASS |
| Real D1: reconciliation vs manual CORRECT → explicit STALE_SNAPSHOT loser, nothing committed | real D1 H | PASS |
| Route: adopted shopping import creates once, replays, conflicts, no legacy batch, no KV | routes (shopping) | PASS |
| Route: cross-tenant shopping import → 404, no mutation | routes (shopping) | PASS |
| Route: adopted cook FEFO through T09, cooked receipt, reread, replay, altered-key conflict | routes (cook) | PASS |
| Route: insufficient authority stock fails closed, no partial consumption | routes (cook) | PASS |
| Route: cross-tenant cook cannot consume A's lots | routes (cook) | PASS |
| Reconciliation vs manual race classified STALE_SNAPSHOT only (no PERSISTENCE_FAILED); no receipt/commands/events/projection damage | closed-loop race (tightened) | PASS |

Original rows (first freeze, retained and re-run):

| Requirement (packet) | Test | Result |
| --- | --- | --- |
| §15 E2E reconciliation: 10/fridge + obs 7/freezer → read 10 before; accepted CORRECT+MOVE → lots 7/freezer v3; read 7/freezer; decision receipt exactly once; command events exactly 2; replay → replayed; altered key → `IDEMPOTENCY_CONFLICT` | closed-loop E2E | PASS |
| §16 dismissed observation: obs 99 → DISMISS → observation RECONCILED, lot stays 10 v1, no stock command, read 10 | closed-loop DISMISS | PASS |
| §19 recipe loop: authority 500 g vs tampered 5 kg projection → context 500 g; writers refuse under drift (`DRIFT_DETECTED`); after repair + USE 200 g → 300 g + coherent mirror | closed-loop recipe | PASS |
| §20 planner loop: CORRECT 10→3 → regeneration sees new authority (no stale KV/projection) | closed-loop planner | PASS |
| §21 shopping loop: import through T09; exact retry → replayed, single lot, read 1000 ml (no double-add) | closed-loop shopping | PASS |
| §22 cook loop: FEFO 14 across 2 lots → atomic (10/0 consumed, 6 active), read shows exact poststate | closed-loop cook + T11 real-D1 E4 | PASS |
| §23 notification loop: expiry reminder from authority despite tampered projection; terminal lots silent; UNKNOWN expiry ≠ known freshness | closed-loop notification | PASS |
| §26 race: reconciliation vs manual CORRECT — exactly one winner via lot CAS; loser stale loss; read coherent before/after | closed-loop race | PASS |
| §28 projection drift: quantity/unit/storage/expiry/version tampering → parity reports each code; read stays authority; funnel never switches back | closed-loop drift matrix | PASS |
| §26 retained: READ vs CORRECT/MOVE/USE/DISCARD/FEFO/T10 (T11 suites, barriers + real D1 `/read-race`); reconciliation vs reconciliation/DISMISS (T10 fence); scan/lease races (T09 suites) | retained | PASS |
| §24/§25 tenancy + idempotency audits | T11 real-D1 F/G, T10 fence, T09 suites | PASS |
| §29 corruption fail-closed matrix | T11 suites (mapping/receipt/expiry/corrupt rows) | PASS |
| §30 display vs authority (alias agreement-gated) | T11 suites (updated tamper semantics) | PASS |

Adopted-but-empty (§11/§9): retained from T11 — integration + real D1 + HTTP PASS.
