import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import { and, desc, eq, gte, ilike, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { branches, devices, loyaltyLedger, loyaltyMilestoneAwards, loyaltyPrograms, salesOrders, tenants } from '../../db/schema.js';
import { AppError, Errors } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { parseReceiptCode, verifyReceiptSignature } from '../../shared/receipts.js';
import type { OwnerContext } from '../auth/auth.service.js';
import type { CustomerContext } from '../customers/customers.js';
import type { NotificationsService } from '../notifications/notifications.js';
import { dt } from '../notifications/sales-notices.js';
import { todayInTunis } from '../sales/sales.service.js';
import type { ClubService } from './club.js';

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

/** "Spend 100 DT in the month → get …": automatic, once per month. */
const Milestone = Type.Object(
  {
    id: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
    /** Millimes spent in the month (Tunis calendar month). */
    spend: Type.Integer({ minimum: 1000, maximum: 100_000_000 }),
    kind: Type.Union([Type.Literal('points'), Type.Literal('free_product'), Type.Literal('amount_off')]),
    points: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
    productId: Type.Optional(Type.String({ maxLength: 60 })),
    amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
    /** What the customer gets, as they see it ("Un express offert"). */
    name: Type.Optional(Type.String({ maxLength: 60 })),
  },
  { additionalProperties: false },
);
export type Milestone = Static<typeof Milestone> & { id: string; name: string };

export const LoyaltyProgramView = Type.Object({
  enabled: Type.Boolean(),
  pointsEnabled: Type.Boolean(),
  pointsPerDinar: Type.Integer(),
  rewards: Type.Array(Reward),
  milestonesEnabled: Type.Boolean(),
  milestones: Type.Array(Milestone),
});
export type LoyaltyProgramView = Static<typeof LoyaltyProgramView>;

export const SaveProgramBody = Type.Object(
  {
    enabled: Type.Boolean(),
    pointsEnabled: Type.Optional(Type.Boolean()),
    pointsPerDinar: Type.Integer({ minimum: 1, maximum: 100 }),
    rewards: Type.Array(Reward, { maxItems: 20 }),
    milestonesEnabled: Type.Optional(Type.Boolean()),
    milestones: Type.Optional(Type.Array(Milestone, { maxItems: 10 })),
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
const CafeDetail = Type.Composite([
  CafeSummary,
  Type.Object({
    phone: Type.Union([Type.String(), Type.Null()]),
    rewards: Type.Array(Reward),
    /** Monthly milestones of the café (empty when it doesn't use them). */
    milestones: Type.Array(Milestone),
  }),
]);

const ClaimBody = Type.Object(
  {
    code: Type.String({ minLength: 10, maxLength: 2000 }),
    /** "Join this café's club" ticked on the claim page. */
    optIn: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const ClaimResult = Type.Object({
  cafeId: Type.String(),
  cafeName: Type.String(),
  receiptNumber: Type.String(),
  points: Type.Integer(),
  balance: Type.Integer(),
  /** Milestones this receipt reached ("+50 points", "Un express offert"). */
  bonuses: Type.Array(Type.String()),
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
const MyCafe = Type.Composite([
  CafeDetail,
  Type.Object({
    balance: Type.Integer(),
    history: Type.Array(LedgerEntry),
    /** Millimes paid here this month (scanned receipts) — for the milestones. */
    monthSpent: Type.Integer(),
    /** Member of the café's club (shares name and visits, receives gifts). */
    optIn: Type.Boolean(),
    gifts: Type.Array(
      Type.Object({ id: Type.String(), name: Type.String(), kind: Type.String(), expiresAt: Type.String() }),
    ),
  }),
]);

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
  earn(e: { customerId: string; branchId: string; points: number; spent: number; orderId: string; receiptNumber: string }): Promise<boolean>;
  /** Millimes paid between [from, to) on scanned receipts (refunds taken off). */
  spentBetween(customerId: string, branchId: string, from: Date, to: Date): Promise<number>;
  /** Records a milestone reached this month; false if it was already given. */
  claimMilestone(customerId: string, branchId: string, milestoneId: string, month: string): Promise<boolean>;
  addBonus(e: { customerId: string; branchId: string; points: number; rewardName: string }): Promise<void>;
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

type ProgramRow = {
  enabled: boolean;
  pointsPerDinar: number;
  rewards: unknown;
  pointsEnabled?: boolean | null;
  milestonesEnabled?: boolean | null;
  milestones?: unknown;
};
const toProgram = (p: ProgramRow | null | undefined): LoyaltyProgramView | null =>
  p
    ? {
        enabled: p.enabled,
        pointsEnabled: p.pointsEnabled ?? true,
        pointsPerDinar: p.pointsPerDinar,
        rewards: (p.rewards ?? []) as Reward[],
        milestonesEnabled: p.milestonesEnabled ?? false,
        milestones: (p.milestones ?? []) as Milestone[],
      }
    : null;

/** The Tunis calendar month of [now]: "2026-11" and its bounds. */
export function tunisMonth(now: Date) {
  const month = todayInTunis(now).slice(0, 7);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const from = new Date(Date.UTC(y, m - 1, 1) - 3600_000);
  const to = new Date(Date.UTC(y, m, 1) - 3600_000);
  return { month, from, to };
}

export class DrizzleLoyaltyRepo implements LoyaltyRepo {
  constructor(private readonly db: Db) {}

  async listCafes(q: string | null) {
    const like = q ? `%${q.replace(/[%_]/g, '')}%` : null;
    const rows = await this.db
      .select({
        ...cafeColumns,
        enabled: loyaltyPrograms.enabled,
        pointsPerDinar: loyaltyPrograms.pointsPerDinar,
        rewards: loyaltyPrograms.rewards,
        pointsEnabled: loyaltyPrograms.pointsEnabled,
        milestonesEnabled: loyaltyPrograms.milestonesEnabled,
        milestones: loyaltyPrograms.milestones,
      })
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
    return rows.map(({ enabled, pointsPerDinar, rewards, pointsEnabled, milestonesEnabled, milestones, ...c }) => ({
      ...c,
      program:
        enabled === null ? null : toProgram({ enabled, pointsPerDinar: pointsPerDinar!, rewards, pointsEnabled, milestonesEnabled, milestones }),
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

  async earn(e: { customerId: string; branchId: string; points: number; spent: number; orderId: string; receiptNumber: string }) {
    const rows = await this.db
      .insert(loyaltyLedger)
      .values({ id: newId(), kind: 'earn', ...e })
      .onConflictDoNothing()
      .returning({ id: loyaltyLedger.id });
    return rows.length === 1;
  }

  async spentBetween(customerId: string, branchId: string, from: Date, to: Date) {
    const [r] = await this.db
      .select({ n: sql<number>`coalesce(sum(${loyaltyLedger.spent}), 0)::int` })
      .from(loyaltyLedger)
      .where(
        and(
          eq(loyaltyLedger.customerId, customerId),
          eq(loyaltyLedger.branchId, branchId),
          gte(loyaltyLedger.createdAt, from),
          lt(loyaltyLedger.createdAt, to),
        ),
      );
    return Number(r?.n ?? 0);
  }

  async claimMilestone(customerId: string, branchId: string, milestoneId: string, month: string) {
    const rows = await this.db
      .insert(loyaltyMilestoneAwards)
      .values({ customerId, branchId, milestoneId, month })
      .onConflictDoNothing()
      .returning({ m: loyaltyMilestoneAwards.month });
    return rows.length === 1;
  }

  async addBonus(e: { customerId: string; branchId: string; points: number; rewardName: string }) {
    await this.db.insert(loyaltyLedger).values({ id: newId(), kind: 'bonus', ...e });
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
    private readonly notify?: NotificationsService,
    private readonly club?: ClubService,
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
    return { ...this.summary(c, p), phone: c.phone, ...this.offer(p) };
  }

  // Owner: the program
  async getProgram(owner: OwnerContext, branchId: string): Promise<LoyaltyProgramView> {
    await this.ownedBranch(owner, branchId);
    return (
      (await this.repo.program(branchId)) ?? {
        enabled: false,
        pointsEnabled: true,
        pointsPerDinar: 1,
        rewards: [],
        milestonesEnabled: false,
        milestones: [],
      }
    );
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
    const milestones = (body.milestones ?? [])
      .map((m) => {
        if (m.kind === 'points' && !m.points) throw LoyaltyErrors.invalidReward(`Palier ${dt(m.spend)} : nombre de points manquant`);
        if (m.kind === 'amount_off' && !m.amount) throw LoyaltyErrors.invalidReward(`Palier ${dt(m.spend)} : montant manquant`);
        if (m.kind === 'free_product' && !m.productId) throw LoyaltyErrors.invalidReward(`Palier ${dt(m.spend)} : produit manquant`);
        const name =
          m.name?.trim() ||
          (m.kind === 'points' ? `+${m.points} points` : m.kind === 'amount_off' ? `${dt(m.amount!)} offerts` : 'Un produit offert');
        return {
          id: m.id ?? newId(),
          spend: m.spend,
          kind: m.kind,
          name,
          ...(m.kind === 'points' ? { points: m.points } : m.kind === 'free_product' ? { productId: m.productId } : { amount: m.amount }),
        };
      })
      .sort((a, b) => a.spend - b.spend);
    const p: LoyaltyProgramView = {
      enabled: body.enabled,
      pointsEnabled: body.pointsEnabled ?? true,
      pointsPerDinar: body.pointsPerDinar,
      rewards,
      milestonesEnabled: body.milestonesEnabled ?? false,
      milestones,
    };
    if (p.enabled && !p.pointsEnabled && !p.milestonesEnabled) {
      throw LoyaltyErrors.invalidReward('Choisissez au moins un système : les points ou les paliers');
    }
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

    const points = program.pointsEnabled ? Math.floor((claim.total * program.pointsPerDinar) / 1000) : 0;
    const ok = await this.repo.earn({
      customerId: ctx.customerId,
      branchId: device.branchId,
      points,
      spent: claim.total,
      orderId: claim.orderId,
      receiptNumber: claim.receiptNumber,
    });
    if (!ok) throw LoyaltyErrors.receiptClaimed();
    const cafe = await this.repo.cafe(device.branchId);
    const bonuses = await this.milestonesReached(ctx.customerId, device.branchId, cafe?.name ?? 'votre café', program, claim.total);
    const balance = await this.repo.balance(ctx.customerId, device.branchId);

    // 🔔 The points, and any reward this ticket just put within reach.
    const link = `/app/cafes/${device.branchId}`;
    if (points > 0) await this.notify?.customer(ctx.customerId, {
      kind: 'points',
      branchId: device.branchId,
      title: `+${points} points chez ${cafe?.name ?? 'votre café'}`,
      body: `Ticket ${claim.receiptNumber} · vous avez maintenant ${balance} points.`,
      link,
      dedupeKey: `points:${claim.orderId}`,
    });
    const rewards = program.pointsEnabled ? program.rewards : [];
    for (const r of rewards.filter((r) => r.points > balance - points && r.points <= balance)) {
      await this.notify?.customer(ctx.customerId, {
        kind: 'reward_ready',
        branchId: device.branchId,
        title: `Vous pouvez avoir : ${r.name}`,
        body: `${r.points} points chez ${cafe?.name ?? 'votre café'}. Touchez « Utiliser » à la caisse.`,
        link,
        dedupeKey: `reward:${claim.orderId}:${r.id}`,
      });
    }
    return {
      cafeId: device.branchId,
      cafeName: cafe?.name ?? '',
      receiptNumber: claim.receiptNumber,
      points,
      balance,
      bonuses,
    };
  }

  /**
   * Monthly milestones this receipt just reached (spent before < milestone ≤ spent after),
   * each given once a month: bonus points, or a gift used with a code at the POS.
   */
  private async milestonesReached(
    customerId: string,
    branchId: string,
    cafeName: string,
    program: LoyaltyProgramView,
    total: number,
  ): Promise<string[]> {
    if (!program.milestonesEnabled || program.milestones.length === 0) return [];
    const { month, from, to } = tunisMonth(this.now());
    const after = await this.repo.spentBetween(customerId, branchId, from, to);
    const before = after - total;
    const out: string[] = [];
    // Saved milestones always have their id and name (saveProgram gives them).
    for (const m of (program.milestones as Milestone[]).filter((m) => m.spend > before && m.spend <= after)) {
      if (!(await this.repo.claimMilestone(customerId, branchId, m.id, month))) continue;
      if (m.kind === 'points') {
        await this.repo.addBonus({ customerId, branchId, points: m.points!, rewardName: `Palier ${dt(m.spend)}` });
      } else {
        await this.club?.awardGift(customerId, branchId, {
          name: m.name,
          kind: m.kind,
          productId: m.productId ?? null,
          amount: m.amount ?? null,
          milestoneId: m.id,
        });
      }
      out.push(m.name);
      await this.notify?.customer(customerId, {
        kind: 'milestone',
        branchId,
        title: `Palier atteint chez ${cafeName} 🎉`,
        body: `${dt(m.spend)} ce mois-ci → ${m.name}${m.kind === 'points' ? '' : ' (dans vos cadeaux)'}.`,
        link: `/app/cafes/${branchId}`,
        dedupeKey: `milestone:${m.id}:${month}`,
      });
    }
    return out;
  }

  /** What the café offers, as customers see it. */
  private offer(p: LoyaltyProgramView | null) {
    return {
      rewards: p?.enabled && p.pointsEnabled ? p.rewards : [],
      milestones: p?.enabled && p.milestonesEnabled ? p.milestones : [],
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
        rewardsAvailable: program?.enabled && program.pointsEnabled ? program.rewards.filter((r) => r.points <= b.balance).length : 0,
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
    const { from, to } = tunisMonth(this.now());
    return {
      ...this.summary(c, p),
      phone: c.phone,
      ...this.offer(p),
      monthSpent: await this.repo.spentBetween(ctx.customerId, branchId, from, to),
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
      pointsPerDinar: p?.enabled && p.pointsEnabled ? p.pointsPerDinar : 0,
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
    async (req) => {
      const r = await loyalty.claim(req.customer, req.body.code);
      if (req.body.optIn) await app.services.club.setOptIn(req.customer, r.cafeId, true);
      return r;
    },
  );
  app.get('/v1/customer/points', { schema: { response: { 200: Type.Array(Balance) } }, preHandler: app.requireCustomer }, (req) =>
    loyalty.myPoints(req.customer),
  );
  app.get(
    '/v1/customer/points/:branchId',
    { schema: { params: BranchParams, response: { 200: MyCafe } }, preHandler: app.requireCustomer },
    async (req) => {
      const [cafe, optIn, gifts] = await Promise.all([
        loyalty.myCafe(req.customer, req.params.branchId),
        app.services.club.optIn(req.customer, req.params.branchId),
        app.services.club.myGifts(req.customer, req.params.branchId),
      ]);
      return { ...cafe, optIn, gifts: gifts.map(({ id, name, kind, expiresAt }) => ({ id, name, kind, expiresAt })) };
    },
  );
};
