# T09 change manifest

| Classification | Files | Reason |
| --- | --- | --- |
| DOMAIN | packages/domain/src/inventory-lot-commands.ts | Six validated pure command planners, exact quantities, lifecycle, CAS expectations and bounded correction |
| PERSISTENCE | packages/db/src/inventory-lot-commands.ts | Internal native command executor; membership, snapshot/revision/CAS, receipt, event and exact legacy projection in one batch |
| MIGRATION | migrations/0024_inventory_lot_commands.sql | Additive receipts, projection identity, revision fence and mapped-lot/event protection; no automatic adoption |
| TEST | tests/integration/inventory-lot-commands.test.ts | Native command parity, replay, failure rollback and controlled races |
| TEST | tests/integration/inventory-lot-schema.test.ts | Populated T08 upgrade, schema constraints, REPLACE bypasses, ownership and query plans |
| TEST | tests/integration/inventory-lot-d1.test.mjs | Real isolated workerd/D1 replay, RETURNING, late CAS rollback and actual executor replay |
| TEST | tests/helpers/inventory-lot-d1-worker.ts | Token-guarded test-only local Worker; never imported by production |
| TEST | tests/integration/inventory-truth.test.ts | Update latest migration/count to actual 0024/24 lineage only |
| TEST | tests/integration/recipe-foundation.test.ts | Update exact latest migration assertion only |
| TEST | tests/e2e/planner-preview.test.mjs | Update exact latest migration assertion only |
| TEST | scripts/migration-smoke.sh | Include additive 0024 and assert command/mapping/revision guards |
| TEST | scripts/d1-schema-gate.sql | Require 0024 table, columns and all safety triggers |
| TEST | scripts/d1-schema-gate.sh | Update success label to match verified 0024 scope |
| TEST | tests/unit/inventory-lot-commands.test.ts | 202 command contract, tenancy, timestamp, quantity and lifecycle checks |
| DOCUMENTATION | docs/ai/inventory-truth/t09/*.md | Publication-first cross-account review packet |
| DOCUMENTATION | docs/ai/tasks/T09-inventory-lot-engine.md | Active task boundaries and completion gates |
| DOCUMENTATION | docs/ai/inventory-truth/{MASTER_CONTEXT,CURRENT_STATE,TASK_BOARD,DECISIONS,VERIFICATION,SESSION_LOG}.md | Development identity, phase, decisions and evidence |
| DOCUMENTATION | docs/ai/{CURRENT_STATE,TASK_BOARD,HANDOFF}.md | Current program handoff, preserving historical release evidence |

API/SERVICE, LEGACY ADAPTER, SCAN, SHOPPING and COOK: no changes yet. No native
engine is exposed by HTTP. Existing live writers remain pending T09F integration.
