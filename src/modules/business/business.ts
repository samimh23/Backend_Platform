import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { branches, tenants } from '../../db/schema.js';
import { AppError, Errors } from '../../shared/errors.js';
import type { OwnerContext } from '../auth/auth.service.js';
import type { DeviceContext } from '../devices/devices.service.js';

// ── Schema ──────────────────────────────────────────────────────

const Nullable = (max: number) => Type.Union([Type.String({ maxLength: max }), Type.Null()]);

/** What the receipt header and footer show. */
export const BusinessView = Type.Object({
  businessName: Type.String(),
  /** Matricule fiscal. */
  taxId: Type.Union([Type.String(), Type.Null()]),
  branchName: Type.String(),
  address: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  receiptFooter: Type.Union([Type.String(), Type.Null()]),
});
export type BusinessView = Static<typeof BusinessView>;

export const UpdateBusinessBody = Type.Object(
  {
    businessName: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    taxId: Type.Optional(Nullable(40)),
    branchName: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    address: Type.Optional(Nullable(160)),
    phone: Type.Optional(Nullable(30)),
    receiptFooter: Type.Optional(Nullable(120)),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateBusinessBody = Static<typeof UpdateBusinessBody>;

const BranchParams = Type.Object({ branchId: Type.String({ format: 'uuid' }) });

// ── Repo ────────────────────────────────────────────────────────

export interface BusinessRecord extends BusinessView {
  tenantId: string;
}

export interface BusinessRepo {
  find(branchId: string): Promise<BusinessRecord | null>;
  update(branchId: string, tenantId: string, changes: UpdateBusinessBody): Promise<void>;
}

export class DrizzleBusinessRepo implements BusinessRepo {
  constructor(private readonly db: Db) {}

  async find(branchId: string) {
    const [r] = await this.db
      .select({
        tenantId: tenants.id,
        businessName: tenants.name,
        taxId: tenants.taxId,
        branchName: branches.name,
        address: branches.address,
        phone: branches.phone,
        receiptFooter: branches.receiptFooter,
      })
      .from(branches)
      .innerJoin(tenants, eq(tenants.id, branches.tenantId))
      .where(eq(branches.id, branchId));
    return r ?? null;
  }

  async update(branchId: string, tenantId: string, c: UpdateBusinessBody) {
    await this.db.transaction(async (tx) => {
      const tenant = {
        ...(c.businessName !== undefined && { name: c.businessName }),
        ...(c.taxId !== undefined && { taxId: c.taxId }),
      };
      const branch = {
        ...(c.branchName !== undefined && { name: c.branchName }),
        ...(c.address !== undefined && { address: c.address }),
        ...(c.phone !== undefined && { phone: c.phone }),
        ...(c.receiptFooter !== undefined && { receiptFooter: c.receiptFooter }),
      };
      if (Object.keys(tenant).length) await tx.update(tenants).set({ ...tenant, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
      if (Object.keys(branch).length) await tx.update(branches).set({ ...branch, updatedAt: new Date() }).where(eq(branches.id, branchId));
    });
  }
}

// ── Service ─────────────────────────────────────────────────────

const view = ({ tenantId: _t, ...v }: BusinessRecord): BusinessView => v;
const clean = (s: string | null | undefined) => (s === undefined ? undefined : s === null || s.trim() === '' ? null : s.trim());

/** The café's details printed on receipts. Owners edit them; POS read them at every sync. */
export class BusinessService {
  constructor(private readonly repo: BusinessRepo) {}

  async forOwner(owner: OwnerContext, branchId: string): Promise<BusinessView> {
    const r = await this.repo.find(branchId);
    if (!r || r.tenantId !== owner.tenantId) throw new AppError('BRANCH_NOT_FOUND', 'Branch not found', 404);
    return view(r);
  }

  async update(owner: OwnerContext, branchId: string, body: UpdateBusinessBody): Promise<BusinessView> {
    if (owner.role !== 'owner') throw Errors.forbidden();
    await this.forOwner(owner, branchId);
    await this.repo.update(branchId, owner.tenantId, {
      ...(body.businessName !== undefined && { businessName: body.businessName.trim() }),
      ...(body.branchName !== undefined && { branchName: body.branchName.trim() }),
      ...(body.taxId !== undefined && { taxId: clean(body.taxId) }),
      ...(body.address !== undefined && { address: clean(body.address) }),
      ...(body.phone !== undefined && { phone: clean(body.phone) }),
      ...(body.receiptFooter !== undefined && { receiptFooter: clean(body.receiptFooter) }),
    });
    return this.forOwner(owner, branchId);
  }

  async forDevice(ctx: DeviceContext): Promise<BusinessView> {
    const r = await this.repo.find(ctx.branchId);
    if (!r) throw new AppError('BRANCH_NOT_FOUND', 'Branch not found', 404);
    return view(r);
  }
}

// ── Routes ──────────────────────────────────────────────────────

export const businessRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const business = app.services.business;

  app.get(
    '/v1/owner/branches/:branchId/business',
    { schema: { params: BranchParams, response: { 200: BusinessView } }, preHandler: app.requireOwner },
    (req) => business.forOwner(req.owner, req.params.branchId),
  );
  app.patch(
    '/v1/owner/branches/:branchId/business',
    { schema: { params: BranchParams, body: UpdateBusinessBody, response: { 200: BusinessView } }, preHandler: app.requireOwner },
    (req) => business.update(req.owner, req.params.branchId, req.body),
  );
  /** What the POS prints at the top and bottom of receipts. */
  app.get('/v1/devices/business', { schema: { response: { 200: BusinessView } }, preHandler: app.requireDevice }, (req) =>
    business.forDevice(req.device),
  );
};
