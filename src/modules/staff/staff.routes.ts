import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { BranchParams, CreateStaffBody, IdParams, StaffView, UpdateStaffBody } from './staff.schema.js';

/** Owner app: staff who log in on the POS with a PIN. */
export const staffRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook('preHandler', app.requireOwner);
  const svc = app.services.staff;

  app.get(
    '/v1/owner/branches/:branchId/staff',
    { schema: { params: BranchParams, response: { 200: Type.Array(StaffView) } } },
    (req) => svc.list(req.owner, req.params.branchId),
  );
  app.post(
    '/v1/owner/branches/:branchId/staff',
    { schema: { params: BranchParams, body: CreateStaffBody, response: { 200: StaffView } } },
    (req) => svc.create(req.owner, req.params.branchId, req.body),
  );
  app.patch(
    '/v1/owner/staff/:id',
    { schema: { params: IdParams, body: UpdateStaffBody, response: { 200: StaffView } } },
    (req) => svc.update(req.owner, req.params.id, req.body),
  );
};
