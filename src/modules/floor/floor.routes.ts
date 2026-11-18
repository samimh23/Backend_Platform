import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import {
  AreaView,
  BranchParams,
  CreateAreaBody,
  CreateTablesBody,
  FloorView,
  IdParams,
  OkResult,
  TableView,
  UpdateAreaBody,
  UpdateTableBody,
} from './floor.schema.js';

/** Owner app: rooms and tables of a branch. All routes need "Authorization: Bearer <accessToken>". */
export const floorRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook('preHandler', app.requireOwner);
  const floor = app.services.floor;

  app.get('/v1/owner/branches/:branchId/floor', { schema: { params: BranchParams, response: { 200: FloorView } } }, (req) =>
    floor.getFloor(req.owner, req.params.branchId),
  );

  // Areas
  app.post(
    '/v1/owner/branches/:branchId/areas',
    { schema: { params: BranchParams, body: CreateAreaBody, response: { 200: AreaView } } },
    (req) => floor.createArea(req.owner, req.params.branchId, req.body),
  );
  app.patch(
    '/v1/owner/areas/:id',
    { schema: { params: IdParams, body: UpdateAreaBody, response: { 200: AreaView } } },
    (req) => floor.updateArea(req.owner, req.params.id, req.body),
  );
  app.delete('/v1/owner/areas/:id', { schema: { params: IdParams, response: { 200: OkResult } } }, async (req) => {
    await floor.deleteArea(req.owner, req.params.id);
    return { ok: true as const };
  });

  // Tables
  app.post(
    '/v1/owner/branches/:branchId/tables',
    { schema: { params: BranchParams, body: CreateTablesBody, response: { 200: Type.Array(TableView) } } },
    (req) => floor.createTables(req.owner, req.params.branchId, req.body),
  );
  app.patch(
    '/v1/owner/tables/:id',
    { schema: { params: IdParams, body: UpdateTableBody, response: { 200: TableView } } },
    (req) => floor.updateTable(req.owner, req.params.id, req.body),
  );
  app.delete('/v1/owner/tables/:id', { schema: { params: IdParams, response: { 200: OkResult } } }, async (req) => {
    await floor.deleteTable(req.owner, req.params.id);
    return { ok: true as const };
  });
};
