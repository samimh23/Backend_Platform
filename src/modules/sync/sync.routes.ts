import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { PullQuery, PullResult, PushBody, PushResult } from './sync.schema.js';

export const syncRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/v1/sync/push',
    { schema: { body: PushBody, response: { 200: PushResult } }, preHandler: app.requireDevice },
    (req) => app.services.sync.push(req.device, req.body.events),
  );

  app.get(
    '/v1/sync/pull',
    { schema: { querystring: PullQuery, response: { 200: PullResult } }, preHandler: app.requireDevice },
    (req) => app.services.sync.pull(req.device, req.query.cursor),
  );
};
