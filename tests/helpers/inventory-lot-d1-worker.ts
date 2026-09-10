import type { D1DatabaseBinding } from '../../packages/db/src';
import { executeInventoryLotCommand, type InventoryLotCommandScope } from '../../packages/db/src/inventory-lot-commands';

// Test-only Worker: never imported by the application or a deployment config.
export default {
  async fetch(request: Request, env: { DB: D1DatabaseBinding; TEST_TOKEN: string }): Promise<Response> {
    if (request.headers.get('x-test-token') !== env.TEST_TOKEN) return new Response('Forbidden', { status: 403 });
    try {
      if (new URL(request.url).pathname === '/command') {
        const command = await request.json() as { scope: InventoryLotCommandScope; key: string; input: unknown; now: string };
        return Response.json(await executeInventoryLotCommand(env.DB, command.scope, command.key, command.input, command.now));
      }
      const body = await request.json() as { statements: { sql: string; values?: unknown[] }[] };
      const results = await env.DB.batch(body.statements.map(({ sql, values = [] }) => env.DB.prepare(sql).bind(...values)));
      return Response.json({ results });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Batch failed' }, { status: 409 });
    }
  },
};
