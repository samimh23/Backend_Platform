import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';

/**
 * /health       → the process is alive (used by Docker / uptime checks)
 * /health/ready → the process can serve traffic (database reachable)
 */
export const healthRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/health',
    { schema: { response: { 200: Type.Object({ status: Type.Literal('ok') }) } } },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        response: {
          200: Type.Object({ status: Type.Literal('ready'), database: Type.Literal('up') }),
        },
      },
    },
    async () => {
      await app.services.health.checkDatabase();
      return { status: 'ready' as const, database: 'up' as const };
    },
  );
};
