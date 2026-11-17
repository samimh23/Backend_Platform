import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import {
  BranchParams,
  CategoryView,
  CreateCategoryBody,
  CreateProductBody,
  IdParams,
  MenuView,
  OkResult,
  ProductView,
  UpdateCategoryBody,
  UpdateProductBody,
} from './catalog.schema.js';

/** Owner app: menu of a branch. All routes need "Authorization: Bearer <accessToken>". */
export const catalogRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook('preHandler', app.requireOwner);
  const catalog = app.services.catalog;

  app.get('/v1/owner/branches/:branchId/menu', { schema: { params: BranchParams, response: { 200: MenuView } } }, (req) =>
    catalog.getMenu(req.owner, req.params.branchId),
  );

  // Categories
  app.post(
    '/v1/owner/branches/:branchId/categories',
    { schema: { params: BranchParams, body: CreateCategoryBody, response: { 200: CategoryView } } },
    (req) => catalog.createCategory(req.owner, req.params.branchId, req.body),
  );
  app.patch(
    '/v1/owner/categories/:id',
    { schema: { params: IdParams, body: UpdateCategoryBody, response: { 200: CategoryView } } },
    (req) => catalog.updateCategory(req.owner, req.params.id, req.body),
  );
  app.delete('/v1/owner/categories/:id', { schema: { params: IdParams, response: { 200: OkResult } } }, async (req) => {
    await catalog.deleteCategory(req.owner, req.params.id);
    return { ok: true as const };
  });

  // Products
  app.post(
    '/v1/owner/branches/:branchId/products',
    { schema: { params: BranchParams, body: CreateProductBody, response: { 200: ProductView } } },
    (req) => catalog.createProduct(req.owner, req.params.branchId, req.body),
  );
  app.patch(
    '/v1/owner/products/:id',
    { schema: { params: IdParams, body: UpdateProductBody, response: { 200: ProductView } } },
    (req) => catalog.updateProduct(req.owner, req.params.id, req.body),
  );
  app.delete('/v1/owner/products/:id', { schema: { params: IdParams, response: { 200: OkResult } } }, async (req) => {
    await catalog.deleteProduct(req.owner, req.params.id);
    return { ok: true as const };
  });
};
