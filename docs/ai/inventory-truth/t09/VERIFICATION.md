# T09 verification (append-only evidence)

## 2026-09-10 — publication-first baseline

- User confirmed canonical `vn-2b/frigo-dev`; no remote URL changed.
- Git status/remotes/log/branches inspected. Broker fetched main and T08.
- Main: d1b06732f8a80db4e77986df31ff28d9f04641fa.
- T08: 8f8788c1a0c9e486657751ef3875a5baa5334dec, COMPLETE receipt, source,
  migration 0023, 130-test suite and handoff present.
- Published authorized T09 branch at exact T08 HEAD; fetched same SHA.
- `test "$(git rev-parse HEAD)" = "$(git rev-parse origin/hoplite/euhesperides-d77023a5)"`: PASS.
- No implementation written before publication.
- Existing CI filters do not run on this branch. Deploy release job requires main
  workflow/CI ancestry gates; no workflow was dispatched and no PR opened.
- Managed setup failed to claim despite ready/no operation. Exact existing repo
  setup run via shell: sqlite3 installation + `pnpm install --frozen-lockfile` PASS
  (Node 24.19.0, pnpm 10.26.0); platform issue reported. No dependency edits.
- Fresh tests, lint, typecheck, build and migration gates: NOT YET RUN.

## T09A baseline and audit checkpoint

- Initial review packet committed/published/fetched at
  e56f163921a4afd901f63c46617a8f574bbc5be1.
- `pnpm exec vitest run tests/unit/inventory-truth.test.ts tests/integration/inventory-truth.test.ts`:
  PASS **130 tests / 2 files** (76 unit, 54 integration), 12:57:57 UTC, 2.38s.
- `git diff --check`: PASS before initial commit.
- Read-only delegated SQLite probe: 23-migration replay, invalid-event CAS guard
  rollback confirmed; version+1 postcondition demonstrated unsafe. This probe is
  design evidence, not the final T09 runtime/test suite.
- Exhaustive writer audit completed; findings and required mitigations in WRITER_MAP.
- No T09 application code yet. Full/lint/typecheck/build/migration final gates pending.

## T09B — command contracts

- T09A c212deda67d832e4fde18941f06d6f38a99a2a96 published/fetched before code.
- Added pure CREATE/USE/DISCARD/OPEN/MOVE/CORRECT planner and 202 unit tests.
- `pnpm exec vitest run tests/unit/inventory-lot-commands.test.ts tests/unit/inventory-truth.test.ts tests/integration/inventory-truth.test.ts`:
  PASS **332 tests / 3 files** (202 T09B + 130 T08), parent rerun 13:15:41 UTC.
- `pnpm exec eslint packages/domain/src/inventory-lot-commands.ts tests/unit/inventory-lot-commands.test.ts`: PASS (implementation agent).
- `pnpm typecheck`: PASS (implementation agent).
- Initial test assumption that installed T08 Zod accepts February 30 was incorrect;
  installed Zod 3.25.76 already rejects it. Corrected the assumption, retained strict
  live timestamp tests. No T08 schema weakened or changed.
- Domain boundary only: no HTTP exposure, persistence, migration, FEFO or writer
  cutover yet. Full final gates and runtime atomicity remain pending.
