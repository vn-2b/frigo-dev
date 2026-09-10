import type { D1DatabaseBinding, D1PreparedStatement } from '../../packages/db/src';
import { executeInventoryLotCommand, type InventoryLotCommandScope } from '../../packages/db/src/inventory-lot-commands';

interface CommandRequest { scope: InventoryLotCommandScope; key: string; input: unknown; now: string }
const run = (db: D1DatabaseBinding, command: CommandRequest) =>
  executeInventoryLotCommand(db, command.scope, command.key, command.input, command.now);

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

// Test-only Worker: never imported by the application or a deployment config.
export default {
  async fetch(request: Request, env: { DB: D1DatabaseBinding; TEST_TOKEN: string }): Promise<Response> {
    if (request.headers.get('x-test-token') !== env.TEST_TOKEN) return new Response('Forbidden', { status: 403 });
    try {
      if (new URL(request.url).pathname === '/command') {
        return Response.json(await run(env.DB, await request.json() as CommandRequest));
      }
      if (new URL(request.url).pathname === '/race') {
        const body = await request.json() as { contender: CommandRequest; winner: CommandRequest };
        return Response.json(await controlledRace(env.DB, body.contender, body.winner));
      }
      const body = await request.json() as { statements: { sql: string; values?: unknown[] }[] };
      const results = await env.DB.batch(body.statements.map(({ sql, values = [] }) => env.DB.prepare(sql).bind(...values)));
      return Response.json({ results });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Batch failed' }, { status: 409 });
    }
  },
};
