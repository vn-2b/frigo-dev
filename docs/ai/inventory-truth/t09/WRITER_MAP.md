# T09 writer map

## Current recovery safety classification

Canonical repository `vn-2d/frigo-dev`; writable successor `hoplite/kos-2a686759`.
Manual CREATE/PATCH/DELETE, scan confirmation, Week shopping import and cooking
now fence mapped authority inside the stock transaction. They remain compatible
for unactivated legacy households and are **SAFE-DEFERRED for mapped households**
with explicit 409 `INVENTORY_AUTHORITY_REQUIRED`. This is not functional adoption
or completed migration. Scan/shopping additionally fence stock revision; shopping
retains lease/replay behavior and server-scan recovery retains confirmation identity.
Pure adoption planning has no live database writer. DEC-012 remains SAFE-DEFERRED.
Backfill stays insert-only; fixture/query-constant classifications stay NOT LIVE.
F_ADOPTION_PLAN.md records every remaining adapter requirement. The audit below
describes the pre-integration source and is retained as historical discovery.

## Original audit

T09A exhaustive repository audit complete. F guest transfer is SAFE-DEFERRED;
other required live writer classifications remain PENDING.
this is not a completion claim. Paths below are relative to `src/worker/` unless
qualified otherwise. HTTP paths are under `/api/v1`.

At the D checkpoint, native receipt/event authority is verified but no live writer
below is cut over or exposed through a new route. Their final F classifications
remain pending; D testing is not evidence of completed writer integration.

| Writer | Entry point / files | Current tables mutated | Event | Current CAS | Current idempotency | T09 required? / final status |
| --- | --- | --- | --- | --- | --- | --- |
| Manual add | POST /inventory; routes/inventory.ts; packages/db/src/queries.ts | inventory_items, inventory_events | ADD | Insert-only ID, no version | Item ID/event ID + fingerprint, OR IGNORE | YES / PENDING |
| Manual edit/adjustment/post-scan correction | PATCH /inventory/:id; routes/inventory.ts | inventory_items, inventory_events | MANUAL_UPDATE | household/id/version; changes() event | Optional key, event fingerprint | YES / PENDING |
| Delete/full discard | DELETE /inventory/:id; routes/inventory.ts | inventory_items quantity=0, inventory_events; not physical delete | DISCARD | If-Match -> household/id/version | Optional key + event fingerprint | YES / PENDING |
| Scan confirm/reviewed correction | POST /scans/:id/confirm; routes/scans.ts | scan_items, inventory_items, inventory_events, scans | SCAN_CONFIRM | READY fence, no observed stock CAS | Stable scan/item IDs and final confirmed status; changed replay payload not checked | YES / PENDING |
| Offline scan fallback | src/web/services/scans.ts -> queued POST /inventory; lib/sync.ts | Same as manual add | ADD | Same as manual add | offline scan/item IDs; different identity from server confirm | YES / PENDING via manual adapter; audit lost-response duplicate risk |
| Shopping stock import | POST /week/plans/:id/shopping/complete; routes/week.ts | inventory_items/events, shopping_runs/run_items/import_commands | SHOPPING_IMPORT | Lease/fence; no observed stock CAS | Durable command fingerprint, lock token, completion last, 15-minute takeover | YES / PENDING |
| Cook completion | POST /recipes/:id/cook/complete; routes/recipes.ts | cooked_meals, inventory_items/events; parent FK rows | COOK | household/id/version/quantity; invalid-event guard abort | Cook ID/fingerprint in cooked_meals | YES / PENDING; updated_at/id allocation must become FEFO |
| Guest household reassignment | POST /auth/verify-otp registration; routes/auth.ts | None for a requested transfer; old stock/shopping/KV mutation block removed | No transfer event because no transfer occurs | Unconditional policy after valid unexpired OTP, before consume/activation/session; no stock-read race | Repeated request yields explicit 409; no fake migratedFromHouseholdId | SAFE-DEFERRED / DEC-012; 25 route cases and client no-rebind control |
| T08 foundation backfill | packages/db/src/inventory-truth.ts; explicit internal helper only | storage_locations, inventory_lots | None (foundation snapshot) | Full legacy source guard in batch | Stable synthetic ID/unique source; insert-only | ADAPTATION AUDIT / PENDING; never refresh drift |
| Raw SQL update/physical delete helpers | packages/db/src/queries.ts constants UPDATE_INVENTORY_ITEM, DELETE_INVENTORY_ITEM | No executable callers found | N/A | N/A | N/A | NOT A LIVE MUTATION |
| Initial seed | migrations/0002_seed_data.sql | 8 inventory_items, 5 inventory_events | Seed history | N/A | INSERT OR IGNORE | NOT A LIVE MUTATION; applied migration immutable |
| Preview fixtures/stale injection | scripts/planner-preview-fixtures.mjs; security-preview.mjs | Isolated in-memory inventory, reset DB | None for deliberate stale injection | Deliberate version bump | Reset fixture | NOT A LIVE MUTATION |
| Query-plan fixtures | scripts/t07-query-plans.mjs | In-memory stock | None | N/A | Fixture | NOT A LIVE MUTATION |
| Integration fixtures/factories | tests/helpers/sqlite-d1.ts; tests/integration/{inventory-truth,meal-planning-http,meal-planning-presentation-http,meal-planning-snapshot,recipe-candidates,recipe-foundation,shopping-optimizer,t07-persistence,t07-security,week-core-flow,weekly-planner}.test.* | Isolated inventory/lot fixtures | Deliberate fixture histories | Test-specific | Test-specific | NOT A LIVE MUTATION |
| Web optimistic caches/outbox | src/web/services/{inventory,recipes,week}.ts; lib/sync.ts | Local cache/outbox; eventual writes above | None directly | API/outbox contracts | API/outbox contracts | NOT A LIVE MUTATION separately |
| Scan queue/cleanup jobs | services/scan-queue.ts, cleanup.ts | Scan drafts/jobs/quota; OTP/session cleanup, no stock | None | Scan worker fences only | Scan worker only | NOT A LIVE MUTATION |
| Auth guest/demo creation | routes/auth.ts guest route | User/household/profile/shopping parents, no inventory seed at T08 HEAD | None | N/A | N/A | NOT A LIVE MUTATION; corrects stale T08 audit note |
| Other candidate surfaces | cook/start, standalone shopping-list CRUD, generated planner, notifications | No inventory writes | None | N/A | N/A | NOT A LIVE MUTATION |

## Integration hazards / required mitigations

- Scan and shopping add to existing legacy rows. Lot/projection updates must be
  computed from a guarded snapshot; command fences alone do not protect unit,
  identity or quantity changes by manual commands.
- `changes()` guards must immediately follow their intended write. A zero-row CAS
  is not a failed SQL statement; add an in-batch abort before later effects.
- Keep scan/shopping completion last. Never add a second post-commit lot batch.
- T08 insert-only backfill cannot repair drift or guest ownership changes. Existing
  inconsistent snapshots must fail closed, never silently overwrite lot truth.
- No dedicated live SCAN_CORRECTION endpoint: reviewed changes are confirmation
  inputs; later corrections use PATCH. Queue predictions never directly write stock.
- Guest transfer no longer rewrites event ownership. Requests receive explicit
  `INVENTORY_TRANSFER_DEFERRED`; the old swallowed-error loop is removed. Route
  tests cover legacy/backfilled/native/empty sources, native targets, signed and
  cookie callers, foreign/forged IDs, repeated requests, OTP/account/session and
  inventory/event/receipt/location/shopping/KV byte preservation. Client outbox
  remains guest-scoped on 409. Rate-limit KV accounting is intentionally retained.
- Same-unit contextual packs/bunches/slices are not proof of package equivalence;
  multi-lot pooling requires explicit safe policy, not guessed mass.

Audit evidence: raw INSERT/UPDATE/DELETE searches, query-constant references,
all inventory route batches and auth dynamic table list inspected. No production
or external repository inspected. Live status must become MIGRATED, ADAPTED or
DEFERRED WITH SAFE REASON before T09 can be ready for independent review.
