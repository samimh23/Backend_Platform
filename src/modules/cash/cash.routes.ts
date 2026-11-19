import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { BranchParams, CashSessionDetail, CashSessionView, SessionParams, SessionsQuery } from './cash.schema.js';

/** Owner app: cash drawer sessions ("Clôtures"). All routes need "Authorization: Bearer <accessToken>". */
export const cashRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook('preHandler', app.requireOwner);
  const cash = app.services.cash;

  app.get(
    '/v1/owner/branches/:branchId/cash-sessions',
    { schema: { params: BranchParams, querystring: SessionsQuery, response: { 200: Type.Array(CashSessionView) } } },
    (req) => cash.list(req.owner, req.params.branchId, req.query),
  );

  app.get(
    '/v1/owner/cash-sessions/:sessionId',
    { schema: { params: SessionParams, response: { 200: CashSessionDetail } } },
    (req) => cash.get(req.owner, req.params.sessionId),
  );
};
