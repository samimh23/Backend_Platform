import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { BranchParams, OrderDetail, OrderParams, OrderView, OrdersQuery, SalesSummary, SummaryQuery } from './sales.schema.js';

/** Owner app: sales of a branch. All routes need "Authorization: Bearer <accessToken>". */
export const salesRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook('preHandler', app.requireOwner);
  const sales = app.services.sales;

  app.get(
    '/v1/owner/branches/:branchId/sales/summary',
    { schema: { params: BranchParams, querystring: SummaryQuery, response: { 200: SalesSummary } } },
    (req) => sales.summary(req.owner, req.params.branchId, req.query.date),
  );

  app.get(
    '/v1/owner/branches/:branchId/sales/orders',
    { schema: { params: BranchParams, querystring: OrdersQuery, response: { 200: Type.Array(OrderView) } } },
    (req) => sales.listOrders(req.owner, req.params.branchId, req.query),
  );

  app.get('/v1/owner/orders/:orderId', { schema: { params: OrderParams, response: { 200: OrderDetail } } }, (req) =>
    sales.getOrder(req.owner, req.params.orderId),
  );
};
