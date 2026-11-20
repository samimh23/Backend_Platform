import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { branches, devices, loyaltyLedger, loyaltyPrograms, salesOrders, tenants } from '../../db/schema.js';
import { AppError, Errors } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { parseReceiptCode, verifyReceiptSignature } from '../../shared/receipts.js';
import type { OwnerContext } from '../auth/auth.service.js';
import type { CustomerContext } from '../customers/customers.js';

// ── Schema ──────────────────────────────────────────────────────

const Reward = Type.Object(
  {
    id: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
    name: Type.String({ minLength: 1, maxLength: 60 }),
    /** Points it costs. */
    points: Type.Integer({ minimum: 1, maximum: 100_000 }),
    /** free_product: one product offered; amount_off: millimes off the ticket. */
    kind: Type.Union([Type.Literal('free_product'), Type.Literal('amount_off')]),
    productId: Type.Optional(Type.String({ maxLength: 60 })),
    amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
);
export type Reward = Static<typeof Reward> & { id: string };

export const LoyaltyProgramView = Type.Object({
  enabled: Type.Boolean(),
  pointsPerDinar: Type.Integer(),
  rewards: Type.Array(Reward),
});
export type LoyaltyProgramView = Static<typeof LoyaltyProgramView>;

export const SaveProgramBody = Type.Object(
  {
    enabled: Type.Boolean(),
    pointsPerDinar: Type.Integer({ minimum: 1, maximum: 100 }),
    rewards: Type.Array(Reward, { maxItems: 20 }),
  },
  { additionalProperties: false },
);
export type SaveProgramBody = Static<typeof SaveProgramBody>;

const CafeSummary = Type.Object({
  id: Type.String(),
  name: Type.String(),
  businessName: Type.String(),
  city: Type.Union([Type.String(), Type.Null()]),
  address: Type.Union([Type.String(), Type.Null()]),
  loyalty: Type.Boolean(),
  pointsPerDinar: Type.Integer(),
});
const CafeDetail = Type.Composite([CafeSummary, Type.Object({ phone: Type.Union([Type.String(), Type.Null()]), rewards: Type.Array(Reward) })]);

const ClaimBody = Type.Object({ code: Type.String({ minLength: 10, maxLength: 2000 }) }, { additionalProperties: false });
const ClaimResult = Type.Object({
  cafeId: Type.String(),
  cafeName: Type.String(),
  receiptNumber: Type.String(),
  points: Type.Integer(),
  balance: Type.Integer(),
});

const Balance = Type.Object({
  cafeId: Type.String(),
  cafeName: Type.String(),
  city: Type.Union([Type.String(), Type.Null()]),
  balance: Type.Integer(),
  /** Rewards the customer can already get. */
  rewardsAvailable: Type.Integer(),
});
const LedgerEntry = Type.Object({
  points: Type.Integer(),
  kind: Type.String(),
  receiptNumber: Type.Union([Type.String(), Type.Null()]),
  rewardName: Type.Union([Type.String(), Type.Null()]),
  at: Type.String(),
});
const MyCafe = Type.Composite([CafeDetail, Type.Object({ balance: Type.Integer(), history: Type.Array(LedgerEntry) })]);

// ── Repo ────────────────────────────────────────────────────────

export interface CafeRecord {
  id: string;
  tenantId: string;
  name: string;
  businessName: string;
  city: string | null;
  address: string | null;
  phone: string | null;
  listed: boolean;
}

export interface LoyaltyRepo {
  /** Listed cafés, optionally matching [q] (name, business, city). */
  listCafes(q: string | null): Promise<(CafeRecord & { program: LoyaltyProgramView | null })[]>;
  cafe(branchId: string): Promise<CafeRecord | null>;
  program(branchId: string): Promise<LoyaltyProgramView | null>;
  saveProgram(branchId: string, p: LoyaltyProgramView): Promise<void>;
  device(id: string): Promise<{ branchId: string; publicKey: string; disabled: boolean } | null>;
  orderStatus(orderId: string): Promise<string | null>;
  /** false when this receipt was already claimed. */
  earn(e: { customerId: string; branchId: string; points: number; orderId: string; receiptNumber: string }): Promise<boolean>;
  balance(customerId: string, branchId: string): Promise<number>;
  balances(customerId: string): Promise<{ branchId: string; balance: number }[]>;
  history(customerId: string, branchId: string): Promise<{ points: number; kind: string; receiptNumber: string | null; rewardName: string | null; createdAt: Date }[]>;
}

const cafeColumns = {
  id: branches.id,
  tenantId: branches.tenantId,
  name: branches.name,
  businessName: tenants.name,
  city: branches.city,
  address: branches.address,
  phone: branches.phone,
  listed: branches.listed,
};

const toProgram = (p: { enabled: boolean; pointsPerDinar: number; rewards: unknown } | null | undefined): LoyaltyProgramView | null =>
  p ? { enabled: p.enabled, pointsPerDinar: p.pointsPerDinar, rewards: (p.rewards ?? []) as Reward[] } : null;

export class DrizzleLoyaltyRepo implements LoyaltyRepo {
  constructor(private readonly db: Db) {}

  async listCafes(q: string | null) {
    const like = q ? `%${q.replace(/[%_]/g, '')}%` : null;
    const rows = await this.db
      .select({ ...cafeColumns, enabled: loyaltyPrograms.enabled, pointsPerDinar: loyaltyPrograms.pointsPerDinar, rewards: loyaltyPrograms.rewards })
      .from(branches)
      .innerJoin(tenants, eq(tenants.id, branches.tenantId))
      .leftJoin(loyaltyPrograms, eq(loyaltyPrograms.branchId, branches.id))
      .where(
        like
          ? and(eq(branches.listed, true), or(ilike(branches.name, like), ilike(tenants.name, like), ilike(branches.city, like)))
          : eq(branches.listed, true),
      )
      .orderBy(branches.name)
      .limit(100);
    return rows.map(({ enabled, pointsPerDinar, rewards, ...c }) => ({
      ...c,
      program: enabled === null ? null : toProgram({ enabled, pointsPerDinar: pointsPerDinar!, rewards }),
    }));
  }

  async cafe(branchId: string) {
    const [c] = await this.db.select(cafeColumns).from(branches).innerJoin(tenants, eq(tenants.id, branches.tenantId)).where(eq(branches.id, branchId));
    return c ?? null;
  }

  async program(branchId: string) {
    const [p] = await this.db.select().from(loyaltyPrograms).where(eq(loyaltyPrograms.branchId, branchId));
    return toProgram(p);
  }

  async saveProgram(branchId: string, p: LoyaltyProgramView) {
    await this.db
      .insert(loyaltyPrograms)
      .values({ branchId, ...p })
      .onConflictDoUpdate({ target: loyaltyPrograms.branchId, set: { ...p, updatedAt: new Date() } });
  }

  async device(id: string) {
    const [d] = await this.db
      .select({ branchId: devices.branchId, publicKey: devices.publicKey, disabled: devices.disabled })
      .from(devices)
      .where(eq(devices.id, id));
    return d ?? null;
  }

  async orderStatus(orderId: string) {
    const [o] = await this.db.select({ status: salesOrders.status }).from(salesOrders).where(eq(salesOrders.id, orderId));
    return o?.status ?? null;
  }

  async earn(e: { customerId: string; branchId: string; points: number; orderId: string; receiptNumber: string }) {
    const rows = await this.db
      .insert(loyaltyLedger)
      .values({ id: newId(), kind: 'earn', ...e })
      .onConflictDoNothing()
      .returning({ id: loyaltyLedger.id });
    return rows.length === 1;
  }

  async balance(customerId: string, branchId: string) {
    const [r] = await this.db
      .select({ n: sql<number>`coalesce(sum(${loyaltyLedger.points}), 0)::int` })
      .from(loyaltyLedger)
      .where(and(eq(loyaltyLedger.customerId, customerId), eq(loyaltyLedger.branchId, branchId)));
    return r?.n ?? 0;
  }

  async balances(customerId: string) {
    return this.db
      .select({ branchId: loyaltyLedger.branchId, balance: sql<number>`sum(${loyaltyLedger.points})::int` })
      .from(loyaltyLedger)
      .where(eq(loyaltyLedger.customerId, customerId))
      .groupBy(loyaltyLedger.branchId);
  }

  history(customerId: string, branchId: string) {
    return this.db
      .select({
        points: loyaltyLedger.points,
        kind: loyaltyLedger.kind,
        receiptNumber: loyaltyLedger.receiptNumber,
        rewardName: loyaltyLedger.rewardName,
        createdAt: loyaltyLedger.createdAt,
      })
      .from(loyaltyLedger)
      .where(and(eq(loyaltyLedger.customerId, customerId), eq(loyaltyLedger.branchId, branchId)))
      .orderBy(desc(loyaltyLedger.createdAt))
      .limit(50);
  }
}

// ── Service ─────────────────────────────────────────────────────

export const LoyaltyErrors = {
  cafeNotFound: () => new AppError('CAFE_NOT_FOUND', 'Café not found', 404),
  branchNotFound: () => new AppError('BRANCH_NOT_FOUND', 'Branch not found', 404),
  receiptInvalid: () => new AppError('RECEIPT_INVALID', 'This receipt code is not valid', 400),
  receiptClaimed: () => new AppError('RECEIPT_ALREADY_CLAIMED', 'Points for this receipt were already taken', 409),
  receiptTooOld: () => new AppError('RECEIPT_TOO_OLD', 'This receipt is too old to earn points', 400),
  receiptRefunded: () => new AppError('RECEIPT_REFUNDED', 'This ticket was refunded', 400),
  loyaltyDisabled: () => new AppError('LOYALTY_DISABLED', 'This café has no loyalty program', 400),
  invalidReward: (m: string) => new AppError('INVALID_REWARD', m, 400),
};

/** A receipt earns points for 30 days. */
export const CLAIM_WINDOW_DAYS = 30;

export class LoyaltyService {
  constructor(
    private readonly repo: LoyaltyRepo,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // Public: the café directory
  async listCafes(q?: string) {
    const rows = await this.repo.listCafes(q?.trim() || null);
    return rows.map((c) => this.summary(c, c.program));
  }

  async cafe(branchId: string) {
    const c = await this.repo.cafe(branchId);
    if (!c?.listed) throw LoyaltyErrors.cafeNotFound();
    const p = await this.repo.program(branchId);
    return { ...this.summary(c, p), phone: c.phone, rewards: p?.enabled ? p.rewards : [] };
  }

  // Owner: the program
  async getProgram(owner: OwnerContext, branchId: string): Promise<LoyaltyProgramView> {
    await this.ownedBranch(owner, branchId);
    return (await this.repo.program(branchId)) ?? { enabled: false, pointsPerDinar: 1, rewards: [] };
  }

  async saveProgram(owner: OwnerContext, branchId: string, body: SaveProgramBody): Promise<LoyaltyProgramView> {
    if (owner.role !== 'owner') throw Errors.forbidden();
    await this.ownedBranch(owner, branchId);
    const rewards = body.rewards.map((r) => {
      if (r.kind === 'amount_off' && !r.amount) throw LoyaltyErrors.invalidReward(`${r.name}: montant manquant`);
      if (r.kind === 'free_product' && !r.productId) throw LoyaltyErrors.invalidReward(`${r.name}: produit manquant`);
      return {
        id: r.id ?? newId(),
        name: r.name.trim(),
        points: r.points,
        kind: r.kind,
        ...(r.kind === 'free_product' ? { productId: r.productId } : { amount: r.amount }),
      };
    });
    const p = { enabled: body.enabled, pointsPerDinar: body.pointsPerDinar, rewards };
    await this.repo.saveProgram(branchId, p);
    return p;
  }

  // Customer: earn with a receipt QR, see points
  async claim(ctx: CustomerContext, code: string) {
    const parsed = parseReceiptCode(code);
    if (!parsed) throw LoyaltyErrors.receiptInvalid();
    const { claim } = parsed;
    const device = await this.repo.device(claim.deviceId);
    if (!device || !verifyReceiptSignature(device.publicKey, parsed.payload, parsed.signature)) {
      throw LoyaltyErrors.receiptInvalid();
    }
    const ageDays = (this.now().getTime() - claim.at.getTime()) / 86_400_000;
    if (ageDays > CLAIM_WINDOW_DAYS || ageDays < -1) throw LoyaltyErrors.receiptTooOld();
    const program = await this.repo.program(device.branchId);
    if (!program?.enabled) throw LoyaltyErrors.loyaltyDisabled();
    if ((await this.repo.orderStatus(claim.orderId)) === 'refunded') throw LoyaltyErrors.receiptRefunded();

    const points = Math.floor((claim.total * program.pointsPerDinar) / 1000);
    const ok = await this.repo.earn({
      customerId: ctx.customerId,
      branchId: device.branchId,
      points,
      orderId: claim.orderId,
      receiptNumber: claim.receiptNumber,
    });
    if (!ok) throw LoyaltyErrors.receiptClaimed();
    const cafe = await this.repo.cafe(device.branchId);
    return {
      cafeId: device.branchId,
      cafeName: cafe?.name ?? '',
      receiptNumber: claim.receiptNumber,
      points,
      balance: await this.repo.balance(ctx.customerId, device.branchId),
    };
  }

  async myPoints(ctx: CustomerContext) {
    const out = [];
    for (const b of await this.repo.balances(ctx.customerId)) {
      const [cafe, program] = await Promise.all([this.repo.cafe(b.branchId), this.repo.program(b.branchId)]);
      if (!cafe) continue;
      out.push({
        cafeId: b.branchId,
        cafeName: cafe.name,
        city: cafe.city,
        balance: b.balance,
        rewardsAvailable: program?.enabled ? program.rewards.filter((r) => r.points <= b.balance).length : 0,
      });
    }
    return out.sort((a, b) => b.balance - a.balance);
  }

  async myCafe(ctx: CustomerContext, branchId: string) {
    const c = await this.repo.cafe(branchId);
    if (!c) throw LoyaltyErrors.cafeNotFound();
    const p = await this.repo.program(branchId);
    const history = await this.repo.history(ctx.customerId, branchId);
    // A café the customer has points in stays visible to them even if it is not listed.
    if (!c.listed && history.length === 0) throw LoyaltyErrors.cafeNotFound();
    return {
      ...this.summary(c, p),
      phone: c.phone,
      rewards: p?.enabled ? p.rewards : [],
      balance: await this.repo.balance(ctx.customerId, branchId),
      history: history.map((h) => ({ ...h, at: h.createdAt.toISOString(), createdAt: undefined })),
    };
  }

  private summary(c: CafeRecord, p: LoyaltyProgramView | null) {
    return {
      id: c.id,
      name: c.name,
      businessName: c.businessName,
      city: c.city,
      address: c.address,
      loyalty: p?.enabled ?? false,
      pointsPerDinar: p?.pointsPerDinar ?? 0,
    };
  }

  private async ownedBranch(owner: OwnerContext, branchId: string) {
    const c = await this.repo.cafe(branchId);
    if (!c || c.tenantId !== owner.tenantId) throw LoyaltyErrors.branchNotFound();
  }
}

// ── Routes ──────────────────────────────────────────────────────

const BranchParams = Type.Object({ branchId: Type.String({ format: 'uuid' }) });

export const loyaltyRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const loyalty = app.services.loyalty;

  // Public: no account needed to browse cafés.
  app.get(
    '/v1/public/cafes',
    { schema: { querystring: Type.Object({ q: Type.Optional(Type.String({ maxLength: 60 })) }), response: { 200: Type.Array(CafeSummary) } } },
    (req) => loyalty.listCafes(req.query.q),
  );
  app.get('/v1/public/cafes/:branchId', { schema: { params: BranchParams, response: { 200: CafeDetail } } }, (req) =>
    loyalty.cafe(req.params.branchId),
  );

  // Owner
  app.get(
    '/v1/owner/branches/:branchId/loyalty',
    { schema: { params: BranchParams, response: { 200: LoyaltyProgramView } }, preHandler: app.requireOwner },
    (req) => loyalty.getProgram(req.owner, req.params.branchId),
  );
  app.put(
    '/v1/owner/branches/:branchId/loyalty',
    { schema: { params: BranchParams, body: SaveProgramBody, response: { 200: LoyaltyProgramView } }, preHandler: app.requireOwner },
    (req) => loyalty.saveProgram(req.owner, req.params.branchId, req.body),
  );

  // Customer
  app.post(
    '/v1/customer/claims',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { body: ClaimBody, response: { 200: ClaimResult } },
      preHandler: app.requireCustomer,
    },
    (req) => loyalty.claim(req.customer, req.body.code),
  );
  app.get('/v1/customer/points', { schema: { response: { 200: Type.Array(Balance) } }, preHandler: app.requireCustomer }, (req) =>
    loyalty.myPoints(req.customer),
  );
  app.get(
    '/v1/customer/points/:branchId',
    { schema: { params: BranchParams, response: { 200: MyCafe } }, preHandler: app.requireCustomer },
    (req) => loyalty.myCafe(req.customer, req.params.branchId),
  );
};
