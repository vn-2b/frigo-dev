import type { D1DatabaseBinding, D1PreparedStatement } from '../../packages/db/src';
import { Hono } from 'hono';
import { scanRoutes } from '../../src/worker/routes/scans';
import { inventoryTruthRoutes } from '../../src/worker/routes/inventory-truth';
import { composeInventoryLotCommands, executeInventoryFefoCommand, executeInventoryLotCommand, readLotCommandReceipt,
  type InventoryLotCommandScope, type LotCommandSpec } from '../../packages/db/src/inventory-lot-commands';
import { runLegacyInventoryBatch } from '../../packages/db/src/inventory-writer-fence';
import { executeInventoryAdoption } from '../../packages/db/src/inventory-adoption-executor';
import { confirmReconciliationDecision, planInventoryReconciliationForHousehold,
  type ReconciliationDecisionInput, type ReconciliationDecisionScope } from '../../packages/db/src/inventory-reconciliation';
import type { InventoryObservation } from '../../packages/domain/src/inventory-observations';
import { recordInventoryObservation, type InventoryObservationScope } from '../../packages/db/src/inventory-observations';
import type { InventoryObservationInput } from '../../packages/domain/src/inventory-observations';
import { assertProjectionParity, readInventoryAuthority, readInventoryLot, readInventorySummary } from '../../packages/db/src/inventory-read-authority';
import { readInventoryAuthorityMode } from '../../packages/db/src/inventory-writer-fence';
import { fetchHouseholdInventoryFromDb } from '../../src/worker/routes/inventory';
import type { InventoryReadQuery } from '../../packages/domain/src/inventory-read-authority';

interface CommandRequest { scope: InventoryLotCommandScope; key: string; input: unknown; now: string }
const run = (db: D1DatabaseBinding, command: CommandRequest) =>
  command.input !== null && typeof command.input === 'object' && 'mode' in command.input && command.input.mode === 'FEFO'
    ? executeInventoryFefoCommand(db, command.scope, command.key, command.input, command.now)
    : executeInventoryLotCommand(db, command.scope, command.key, command.input, command.now);

async function controlledRace(db: D1DatabaseBinding, contender: CommandRequest, winner: CommandRequest) {
  let arrived!: () => void;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { arrived = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const native = new Map<D1PreparedStatement, D1PreparedStatement>();
  const writes = new Set<D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement, isWrite: boolean): D1PreparedStatement => {
    const proxy: D1PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values), isWrite),
      first: (column) => statement.first(column),
      all: () => statement.all(),
      run: () => statement.run(),
    };
    native.set(proxy, statement);
    if (isWrite) writes.add(proxy);
    return proxy;
  };
  let arrivals = 0;
  const held: D1DatabaseBinding = {
    prepare: (sql) => wrap(db.prepare(sql), sql.startsWith('INSERT INTO inventory_commands')),
    exec: (sql) => db.exec(sql),
    async batch(statements) {
      if (statements.some((statement) => writes.has(statement))) {
        arrivals += 1;
        arrived();
        await released;
      }
      return db.batch(statements.map((statement) => native.get(statement)!));
    },
  };
  const outcome = async (binding: D1DatabaseBinding, command: CommandRequest) => {
    try { return { execution: await run(binding, command) }; }
    catch (error) { return { error: error instanceof Error ? error.message : 'Command failed' }; }
  };
  const pending = outcome(held, contender);
  // A rejected preflight must fail the test rather than leave the barrier waiting.
  await Promise.race([paused, pending.then(() => { throw new Error('Contender never reached write barrier'); })]);
  const committed = await outcome(db, winner);
  release();
  return { arrivals, winner: committed, contender: await pending };
}

// Pauses the contender immediately before its decision batch (the one carrying
// the reconciliation receipt), commits the winner, then releases the contender.
async function controlledDecisionRace(db: D1DatabaseBinding, scope: ReconciliationDecisionScope, now: string,
  contender: ReconciliationDecisionInput, winner: ReconciliationDecisionInput) {
  let arrived!: () => void;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { arrived = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const native = new Map<D1PreparedStatement, D1PreparedStatement>();
  const decisionWrites = new Set<D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement, isDecisionWrite: boolean): D1PreparedStatement => {
    const proxy: D1PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values), isDecisionWrite),
      first: (column) => statement.first(column),
      all: () => statement.all(),
      run: () => statement.run(),
    };
    native.set(proxy, statement);
    if (isDecisionWrite) decisionWrites.add(proxy);
    return proxy;
  };
  let arrivals = 0;
  const held: D1DatabaseBinding = {
    prepare: (sql) => wrap(db.prepare(sql), sql.includes('INSERT INTO inventory_reconciliation_decisions')),
    exec: (sql) => db.exec(sql),
    async batch(statements) {
      if (statements.some((statement) => decisionWrites.has(statement))) {
        arrivals += 1;
        arrived();
        await released;
      }
      return db.batch(statements.map((statement) => native.get(statement)!));
    },
  };
  const outcome = async (binding: D1DatabaseBinding, decision: ReconciliationDecisionInput) => {
    try { return { execution: await confirmReconciliationDecision(binding, scope, decision, now) }; }
    catch (error) { return { error: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : error instanceof Error ? error.message : 'Decision failed' }; }
  };
  const pending = outcome(held, contender);
  await Promise.race([paused, pending.then(() => { throw new Error('Contender never reached decision batch'); })]);
  const committed = await outcome(db, winner);
  release();
  return { arrivals, winner: committed, contender: await pending };
}

// T11: pauses a writer immediately before its command batch, takes an
// authority read while it is paused, releases the writer, then reads again.
// Proves single-batch snapshot coherence on real D1 without sleeps.
async function controlledReadRace(db: D1DatabaseBinding, writer: CommandRequest, query: InventoryReadQuery) {
  let arrived!: () => void;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { arrived = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const native = new Map<D1PreparedStatement, D1PreparedStatement>();
  const writes = new Set<D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement, isWrite: boolean): D1PreparedStatement => {
    const proxy: D1PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values), isWrite),
      first: (column) => statement.first(column),
      all: () => statement.all(),
      run: () => statement.run(),
    };
    native.set(proxy, statement);
    if (isWrite) writes.add(proxy);
    return proxy;
  };
  const held: D1DatabaseBinding = {
    prepare: (sql) => wrap(db.prepare(sql), sql.startsWith('INSERT INTO inventory_commands')),
    exec: (sql) => db.exec(sql),
    async batch(statements) {
      if (statements.some((statement) => writes.has(statement))) { arrived(); await released; }
      return db.batch(statements.map((statement) => native.get(statement)!));
    },
  };
  const pending = (async () => {
    try { return { execution: await run(held, writer) }; }
    catch (error) { return { error: error instanceof Error ? error.message : 'Command failed' }; }
  })();
  await Promise.race([paused, pending.then(() => { throw new Error('Writer never reached write barrier'); })]);
  const during = await readInventoryAuthority(db, writer.scope, query);
  release();
  const writerOutcome = await pending;
  const after = await readInventoryAuthority(db, writer.scope, query);
  return { during, writer: writerOutcome, after };
}

async function controlledDecisionVsManual(db: D1DatabaseBinding, scope: ReconciliationDecisionScope, now: string,
  decision: ReconciliationDecisionInput, manual: CommandRequest) {
  let arrived!: () => void;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { arrived = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const native = new Map<D1PreparedStatement, D1PreparedStatement>();
  const decisions = new Set<D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement, isDecision: boolean): D1PreparedStatement => {
    const proxy: D1PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values), isDecision),
      first: (column) => statement.first(column),
      all: () => statement.all(),
      run: () => statement.run(),
    };
    native.set(proxy, statement);
    if (isDecision) decisions.add(proxy);
    return proxy;
  };
  const held: D1DatabaseBinding = {
    prepare: (sql) => wrap(db.prepare(sql), sql.includes('INSERT INTO inventory_reconciliation_decisions')),
    exec: (sql) => db.exec(sql),
    async batch(statements) {
      if (statements.some((statement) => decisions.has(statement))) { arrived(); await released; }
      return db.batch(statements.map((statement) => native.get(statement)!));
    },
  };
  const pending = (async () => {
    try { return { execution: await confirmReconciliationDecision(held, scope, decision, now) }; }
    catch (error) { return { error: error instanceof Error ? error.message : 'Decision failed',
      name: error instanceof Error ? error.name : 'Error', code: (error as { code?: string }).code ?? null }; }
  })();
  await Promise.race([paused, pending.then(() => { throw new Error('Decision never reached its batch'); })]);
  let winner: unknown;
  try { winner = { execution: await run(db, manual) }; }
  catch (error) { winner = { error: error instanceof Error ? error.message : 'Manual failed' }; }
  release();
  return { winner, loser: await pending };
}

// Test-only Worker: never imported by the application or a deployment config.
export default {
  async fetch(request: Request, env: { DB: D1DatabaseBinding; TEST_TOKEN: string }): Promise<Response> {
    if (request.headers.get('x-test-token') !== env.TEST_TOKEN) return new Response('Forbidden', { status: 403 });
    try {
      if (new URL(request.url).pathname === '/read') {
        const body = await request.json() as { scope: InventoryLotCommandScope; query?: InventoryReadQuery;
          lot?: { lotId?: string; legacyItemId?: string }; summary?: { ingredientIds?: string[] } };
        const mode = await readInventoryAuthorityMode(env.DB, body.scope.householdId);
        const authority = await readInventoryAuthority(env.DB, body.scope, body.query ?? {});
        const parity = await assertProjectionParity(env.DB, body.scope);
        const lot = body.lot ? await readInventoryLot(env.DB, body.scope, body.lot) : null;
        const summary = body.summary ? await readInventorySummary(env.DB, body.scope, body.summary) : null;
        return Response.json({ mode, authority, parity, lot, summary });
      }
      if (new URL(request.url).pathname === '/funnel') {
        // The product funnel with a deliberately stale KV: adopted households
        // must neither read nor write it.
        const body = await request.json() as { scope: InventoryLotCommandScope };
        const kvWrites: string[] = [];
        const kv = { put: async (key: string) => { kvWrites.push(key); }, get: async () => [{ id: 'stale-kv', quantity: 99 }] };
        const items = await fetchHouseholdInventoryFromDb(env.DB, body.scope.householdId, kv, { strict: true, actorId: body.scope.actorId });
        return Response.json({ items, kvWrites });
      }
      if (new URL(request.url).pathname === '/read-race') {
        const body = await request.json() as { writer: CommandRequest; query?: InventoryReadQuery };
        return Response.json(await controlledReadRace(env.DB, body.writer, body.query ?? {}));
      }
      if (new URL(request.url).pathname === '/scan-confirm') {
        // T13: exercises the REAL scan-confirm Hono route (provenance, purchase
        // facts, expiry truth, observation integration, idempotency) against
        // real workerd/D1 rather than a reimplementation of it.
        const body = await request.json() as {
          scope: InventoryLotCommandScope; scanId: string; items: unknown[];
        };
        const app = new Hono<{ Bindings: any; Variables: { auth: any } }>();
        app.use('*', async (c, next) => {
          c.set('auth', { userId: body.scope.actorId, householdId: body.scope.householdId, isGuest: false } as any);
          await next();
        });
        app.route('/api/v1', scanRoutes);
        const response = await app.fetch(new Request(
          `http://d1.test/api/v1/scans/${encodeURIComponent(body.scanId)}/confirm`,
          { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ items: body.items }) },
        ), { DB: env.DB, CACHE: undefined });
        return Response.json({ status: response.status, body: await response.json() });
      }
      if (new URL(request.url).pathname === '/observations-route') {
        // T13: the additive UX read/decision routes, through real handlers.
        const body = await request.json() as {
          scope: InventoryLotCommandScope; path: string; method?: string; payload?: unknown;
        };
        const app = new Hono<{ Bindings: any; Variables: { auth: any } }>();
        app.use('*', async (c, next) => {
          c.set('auth', { userId: body.scope.actorId, householdId: body.scope.householdId, isGuest: false } as any);
          await next();
        });
        app.route('/api/v1', inventoryTruthRoutes);
        const method = body.method ?? 'GET';
        const response = await app.fetch(new Request(`http://d1.test/api/v1${body.path}`, {
          method,
          ...(method === 'GET' ? {} : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body.payload ?? {}),
          }),
        }), { DB: env.DB, CACHE: undefined });
        return Response.json({ status: response.status, body: await response.json() });
      }
      if (new URL(request.url).pathname === '/adopt') {
        const body = await request.json() as { scope: InventoryLotCommandScope; now: string };
        return Response.json(await executeInventoryAdoption(env.DB, body.scope, {}, body.now));
      }
      if (new URL(request.url).pathname === '/patch-compose') {
        const body = await request.json() as { scope: InventoryLotCommandScope; specs: LotCommandSpec[]; now: string };
        const composed = await composeInventoryLotCommands(env.DB, body.scope, body.specs, body.now);
        if (composed.statements.length) await env.DB.batch(composed.statements);
        const receipts = await Promise.all(body.specs.map(({ clientKey }) => readLotCommandReceipt(env.DB, body.scope, clientKey)));
        return Response.json({ receipts });
      }
      if (new URL(request.url).pathname === '/observe') {
        const body = await request.json() as { scope: InventoryObservationScope; input: InventoryObservationInput; now: string };
        return Response.json(await recordInventoryObservation(env.DB, body.scope, body.input, body.now));
      }
      if (new URL(request.url).pathname === '/reconcile-race') {
        const body = await request.json() as { scope: ReconciliationDecisionScope; now: string;
          contender: ReconciliationDecisionInput; winner: ReconciliationDecisionInput };
        return Response.json(await controlledDecisionRace(env.DB, body.scope, body.now, body.contender, body.winner));
      }
      if (new URL(request.url).pathname === '/plan') {
        // T12: deterministic planner output for an OPEN observation.
        const body = await request.json() as { householdId: string; observation: InventoryObservation };
        return Response.json({ findings: await planInventoryReconciliationForHousehold(env.DB, body.householdId, [body.observation]) });
      }
      if (new URL(request.url).pathname === '/reconcile-vs-manual') {
        // T12: pauses a reconciliation decision immediately before its decision
        // batch, commits a manual T09 command while paused, then releases.
        const body = await request.json() as { scope: ReconciliationDecisionScope; now: string;
          decision: ReconciliationDecisionInput; manual: CommandRequest };
        return Response.json(await controlledDecisionVsManual(env.DB, body.scope, body.now, body.decision, body.manual));
      }
      if (new URL(request.url).pathname === '/reconcile') {
        const body = await request.json() as { scope: ReconciliationDecisionScope; decision: ReconciliationDecisionInput; now: string };
        return Response.json(await confirmReconciliationDecision(env.DB, body.scope, body.decision, body.now));
      }
      if (new URL(request.url).pathname === '/command') {
        return Response.json(await run(env.DB, await request.json() as CommandRequest));
      }
      if (new URL(request.url).pathname === '/race') {
        const body = await request.json() as { contender: CommandRequest; winner: CommandRequest };
        return Response.json(await controlledRace(env.DB, body.contender, body.winner));
      }
      if (new URL(request.url).pathname === '/legacy') {
        const body = await request.json() as {
          householdId: string; expectedInventoryVersion?: number;
          statements: { sql: string; values?: unknown[] }[];
        };
        const statements = body.statements.map(({ sql, values = [] }) => env.DB.prepare(sql).bind(...values));
        return Response.json({ results: await runLegacyInventoryBatch(env.DB, body.householdId, statements, body.expectedInventoryVersion) });
      }
      const body = await request.json() as { statements: { sql: string; values?: unknown[] }[] };
      const results = await env.DB.batch(body.statements.map(({ sql, values = [] }) => env.DB.prepare(sql).bind(...values)));
      return Response.json({ results });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Batch failed' }, { status: 409 });
    }
  },
};
