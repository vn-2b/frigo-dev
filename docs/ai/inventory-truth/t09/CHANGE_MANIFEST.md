# T09 change manifest

| Classification | Files | Reason |
| --- | --- | --- |
| DOMAIN | packages/domain/src/inventory-lot-commands.ts | Six validated pure command planners, exact quantities, lifecycle, CAS expectations and bounded correction |
| TEST | tests/unit/inventory-lot-commands.test.ts | 202 command contract, tenancy, timestamp, quantity and lifecycle checks |
| DOCUMENTATION | docs/ai/inventory-truth/t09/*.md | Publication-first cross-account review packet |
| DOCUMENTATION | docs/ai/tasks/T09-inventory-lot-engine.md | Active task boundaries and completion gates |
| DOCUMENTATION | docs/ai/inventory-truth/{MASTER_CONTEXT,CURRENT_STATE,TASK_BOARD,DECISIONS,VERIFICATION,SESSION_LOG}.md | Development identity, phase, decisions and evidence |
| DOCUMENTATION | docs/ai/{CURRENT_STATE,TASK_BOARD,HANDOFF}.md | Current program handoff, preserving historical release evidence |

PERSISTENCE, MIGRATION, API/SERVICE, LEGACY ADAPTER, SCAN, SHOPPING and COOK:
no changes yet. Update exact file entries as each phase lands.
