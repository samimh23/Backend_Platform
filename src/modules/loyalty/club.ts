import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { branches, customerCafes, customers, loyaltyGifts } from '../../db/schema.js';
import { AppError, Errors } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import type { OwnerContext } from '../auth/auth.service.js';
import type { CustomerContext } from '../customers/customers.js';
import type { NotificationsService } from '../notifications/notifications.js';

/**
 * The café's club: a customer who joins (their choice, off by default) shares their
 * first name and visits with the owner, and can receive gifts from the café. The owner
 * never sees emails: they reach customers only through the app.
 */

// ── Schema ──────────────────────────────────────────────────────

const GiftKind = Type.Union([Type.Literal('free_product'), Type.Literal('amount_off')]);

export const ClubMember = Type.Object({
  id: Type.String(),
  name: Type.String(),
  visits: Type.Integer(),
  /** Millimes, paid tickets the customer scanned here. */
  spent: Type.Integer(),
  points: Type.Integer(),
  lastVisit: Type.Union([Type.String(), Type.Null()]),
});
export type ClubMember = Static<typeof ClubMember>;

export const ClubView = Type.Object({
  /** Customers with points here. */
  customers: Type.Integer(),
  /** Of which joined the club (visible below). */
  members: Type.Array(ClubMember),
});

export const SendGiftsBody = Type.Object(
  {
    customerIds: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 500 }),
    name: Type.String({ minLength: 1, maxLength: 60 }),
    kind: GiftKind,
    productId: Type.Optional(Type.String({ maxLength: 60 })),
    amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
    validDays: Type.Integer({ minimum: 1, maximum: 90 }),
  },
  { additionalProperties: false },
);
export type SendGiftsBody = Static<typeof SendGiftsBody>;

export const Campaign = Type.Object({
  id: Type.String(),
  name: Type.String(),
  kind: GiftKind,
  sentAt: Type.String(),
  expiresAt: Type.String(),
  sent: Type.Integer(),
  used: Type.Integer(),
});

export const GiftView = Type.Object({
  id: Type.String(),
  cafeId: Type.String(),
  cafeName: Type.String(),
  name: Type.String(),
  kind: GiftKind,
  expiresAt: Type.String(),
});
export type GiftView = Static<typeof GiftView>;

const BranchParams = Type.Object({ branchId: Type.String({ format: 'uuid' }) });

// ── Repo ────────────────────────────────────────────────────────

export interface GiftRecord {
  id: string;
  campaignId: string;
  branchId: string;
  customerId: string;
  name: string;
  kind: 'free_product' | 'amount_off';
  productId: string | null;
  amount: number | null;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface ClubRepo {
  branchTenant(branchId: string): Promise<string | null>;
  setOptIn(customerId: string, branchId: string, optIn: boolean, at: Date): Promise<void>;
  optIn(customerId: string, branchId: string): Promise<boolean>;
  customerCount(branchId: string): Promise<number>;
  members(branchId: string): Promise<{ id: string; name: string; visits: number; spent: number; points: number; lastVisit: Date | null }[]>;
  /** Which of [ids] are club members of the branch. */
  optedIn(branchId: string, ids: string[]): Promise<string[]>;
  createGifts(gifts: (GiftRecord & { createdBy: string | null; milestoneId?: string | null })[]): Promise<void>;
  campaigns(branchId: string): Promise<{ id: string; name: string; kind: 'free_product' | 'amount_off'; sentAt: Date; expiresAt: Date; sent: number; used: number }[]>;
  activeGifts(customerId: string, now: Date, branchId?: string): Promise<(GiftRecord & { cafeName: string })[]>;
  gift(id: string): Promise<GiftRecord | null>;
  branchName(branchId: string): Promise<string | null>;
  customerName(customerId: string): Promise<string | null>;
  /** Unused gifts expiring before [before] (still valid now). */
  giftsExpiring(now: Date, before: Date): Promise<(GiftRecord & { cafeName: string })[]>;
}

export class DrizzleClubRepo implements ClubRepo {
  constructor(private readonly db: Db) {}

  async branchTenant(branchId: string) {
    const [b] = await this.db.select({ tenantId: branches.tenantId }).from(branches).where(eq(branches.id, branchId));
    return b?.tenantId ?? null;
  }

  async setOptIn(customerId: string, branchId: string, optIn: boolean, at: Date) {
    await this.db
      .insert(customerCafes)
      .values({ customerId, branchId, optIn, optInAt: optIn ? at : null })
      .onConflictDoUpdate({ target: [customerCafes.customerId, customerCafes.branchId], set: { optIn, optInAt: optIn ? at : null } });
  }

  async optIn(customerId: string, branchId: string) {
    const [r] = await this.db
      .select({ optIn: customerCafes.optIn })
      .from(customerCafes)
      .where(and(eq(customerCafes.customerId, customerId), eq(customerCafes.branchId, branchId)));
    return r?.optIn ?? false;
  }

  async customerCount(branchId: string) {
    const rows = await this.db.execute<{ n: number }>(
      sql`select count(distinct customer_id)::int as n from loyalty_ledger where branch_id = ${branchId}`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  async members(branchId: string) {
    const rows = await this.db.execute<{ id: string; name: string; visits: number; spent: number; points: number; last_visit: string | null }>(sql`
      select c.id, c.name,
        count(o.id) filter (where o.status = 'paid')::int as visits,
        coalesce(sum(o.total) filter (where o.status = 'paid'), 0)::int as spent,
        max(o.closed_at) filter (where o.status = 'paid') as last_visit,
        (select coalesce(sum(x.points), 0)::int from loyalty_ledger x where x.customer_id = c.id and x.branch_id = ${branchId}) as points
      from customer_cafes cc
      join customers c on c.id = cc.customer_id
      left join loyalty_ledger l on l.customer_id = c.id and l.branch_id = ${branchId} and l.kind = 'earn'
      left join sales_orders o on o.id = l.order_id
      where cc.branch_id = ${branchId} and cc.opt_in
      group by c.id, c.name`);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      visits: Number(r.visits),
      spent: Number(r.spent),
      points: Number(r.points),
      lastVisit: r.last_visit ? new Date(r.last_visit) : null,
    }));
  }

  async optedIn(branchId: string, ids: string[]) {
    const rows = await this.db
      .select({ id: customerCafes.customerId })
      .from(customerCafes)
      .where(and(eq(customerCafes.branchId, branchId), eq(customerCafes.optIn, true), inArray(customerCafes.customerId, ids)));
    return rows.map((r) => r.id);
  }

  async createGifts(gifts: (GiftRecord & { createdBy: string | null; milestoneId?: string | null })[]) {
    if (gifts.length) await this.db.insert(loyaltyGifts).values(gifts);
  }

  async campaigns(branchId: string) {
    return this.db
      .select({
        id: loyaltyGifts.campaignId,
        name: sql<string>`min(${loyaltyGifts.name})`,
        kind: sql<'free_product' | 'amount_off'>`min(${loyaltyGifts.kind})`,
        sentAt: sql<Date>`min(${loyaltyGifts.createdAt})`.mapWith((v: string) => new Date(v)),
        expiresAt: sql<Date>`max(${loyaltyGifts.expiresAt})`.mapWith((v: string) => new Date(v)),
        sent: sql<number>`count(*)::int`,
        used: sql<number>`count(${loyaltyGifts.usedAt})::int`,
      })
      .from(loyaltyGifts)
      // Gifts sent by the owner only (milestone gifts are not campaigns).
      .where(and(eq(loyaltyGifts.branchId, branchId), isNull(loyaltyGifts.milestoneId)))
      .groupBy(loyaltyGifts.campaignId)
      .orderBy(sql`min(${loyaltyGifts.createdAt}) desc`)
      .limit(30);
  }

  async activeGifts(customerId: string, now: Date, branchId?: string) {
    return this.db
      .select({
        id: loyaltyGifts.id,
        campaignId: loyaltyGifts.campaignId,
        branchId: loyaltyGifts.branchId,
        customerId: loyaltyGifts.customerId,
        name: loyaltyGifts.name,
        kind: loyaltyGifts.kind,
        productId: loyaltyGifts.productId,
        amount: loyaltyGifts.amount,
        expiresAt: loyaltyGifts.expiresAt,
        usedAt: loyaltyGifts.usedAt,
        cafeName: branches.name,
      })
      .from(loyaltyGifts)
      .innerJoin(branches, eq(branches.id, loyaltyGifts.branchId))
      .where(
        and(
          eq(loyaltyGifts.customerId, customerId),
          isNull(loyaltyGifts.usedAt),
          gt(loyaltyGifts.expiresAt, now),
          ...(branchId ? [eq(loyaltyGifts.branchId, branchId)] : []),
        ),
      )
      .orderBy(loyaltyGifts.expiresAt);
  }

  async branchName(branchId: string) {
    const [b] = await this.db.select({ name: branches.name }).from(branches).where(eq(branches.id, branchId));
    return b?.name ?? null;
  }

  async customerName(customerId: string) {
    const [c] = await this.db.select({ name: customers.name }).from(customers).where(eq(customers.id, customerId));
    return c?.name ?? null;
  }

  async giftsExpiring(now: Date, before: Date) {
    const rows = await this.db
      .select({
        id: loyaltyGifts.id,
        campaignId: loyaltyGifts.campaignId,
        branchId: loyaltyGifts.branchId,
        customerId: loyaltyGifts.customerId,
        name: loyaltyGifts.name,
        kind: loyaltyGifts.kind,
        productId: loyaltyGifts.productId,
        amount: loyaltyGifts.amount,
        expiresAt: loyaltyGifts.expiresAt,
        usedAt: loyaltyGifts.usedAt,
        cafeName: branches.name,
      })
      .from(loyaltyGifts)
      .innerJoin(branches, eq(branches.id, loyaltyGifts.branchId))
      .where(and(isNull(loyaltyGifts.usedAt), gt(loyaltyGifts.expiresAt, now), lt(loyaltyGifts.expiresAt, before)));
    return rows;
  }

  async gift(id: string) {
    const [g] = await this.db
      .select({
        id: loyaltyGifts.id,
        campaignId: loyaltyGifts.campaignId,
        branchId: loyaltyGifts.branchId,
        customerId: loyaltyGifts.customerId,
        name: loyaltyGifts.name,
        kind: loyaltyGifts.kind,
        productId: loyaltyGifts.productId,
        amount: loyaltyGifts.amount,
        expiresAt: loyaltyGifts.expiresAt,
        usedAt: loyaltyGifts.usedAt,
      })
      .from(loyaltyGifts)
      .where(eq(loyaltyGifts.id, id));
    return g ?? null;
  }
}

// ── Service ─────────────────────────────────────────────────────

export const ClubErrors = {
  branchNotFound: () => new AppError('BRANCH_NOT_FOUND', 'Branch not found', 404),
  noMembers: () => new AppError('NO_CLUB_MEMBERS', 'None of these customers is a club member', 400),
  invalidGift: (m: string) => new AppError('INVALID_GIFT', m, 400),
  giftNotFound: () => new AppError('GIFT_NOT_FOUND', 'This gift is used, expired or unknown', 404),
};

const giftView = (g: GiftRecord & { cafeName: string }): GiftView => ({
  id: g.id,
  cafeId: g.branchId,
  cafeName: g.cafeName,
  name: g.name,
  kind: g.kind,
  expiresAt: g.expiresAt.toISOString(),
});

const untilDay = (d: Date) =>
  new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Africa/Tunis' }).format(d);

export class ClubService {
  constructor(
    private readonly repo: ClubRepo,
    private readonly now: () => Date = () => new Date(),
    private readonly notify?: NotificationsService,
  ) {}

  // Customer
  async setOptIn(ctx: CustomerContext, branchId: string, optIn: boolean) {
    const before = await this.repo.optIn(ctx.customerId, branchId);
    await this.repo.setOptIn(ctx.customerId, branchId, optIn, this.now());
    if (optIn && !before) {
      // 🔔 The owner: a new club member (once per customer).
      const [tenantId, name] = await Promise.all([this.repo.branchTenant(branchId), this.repo.customerName(ctx.customerId)]);
      if (tenantId) {
        await this.notify?.owners(tenantId, {
          kind: 'club_joined',
          branchId,
          title: 'Nouveau membre du club',
          body: `${name ?? 'Un client'} a rejoint le club. Vous pouvez lui envoyer un cadeau.`,
          link: '/owner/customers',
          dedupeKey: `club:${ctx.customerId}:${branchId}`,
        });
      }
    }
  }

  /** A gift earned by reaching a monthly milestone: valid 30 days, used with a code like the others. */
  async awardGift(
    customerId: string,
    branchId: string,
    g: { name: string; kind: 'free_product' | 'amount_off'; productId: string | null; amount: number | null; milestoneId: string },
  ) {
    const now = this.now();
    await this.repo.createGifts([
      {
        id: newId(),
        campaignId: newId(),
        branchId,
        customerId,
        name: g.name,
        kind: g.kind,
        productId: g.productId,
        amount: g.amount,
        expiresAt: new Date(now.getTime() + 30 * 86_400_000),
        usedAt: null,
        createdBy: null,
        milestoneId: g.milestoneId,
      },
    ]);
  }

  /** 🔔 "Votre cadeau expire bientôt" — run every few minutes, once per gift. */
  async remindExpiringGifts(): Promise<number> {
    const now = this.now();
    const gifts = await this.repo.giftsExpiring(now, new Date(now.getTime() + 24 * 3600_000));
    for (const g of gifts) {
      await this.notify?.customer(g.customerId, {
        kind: 'gift_expiring',
        branchId: g.branchId,
        title: 'Votre cadeau expire bientôt',
        body: `${g.name} chez ${g.cafeName} · à utiliser avant le ${untilDay(g.expiresAt)}.`,
        link: `/app/cafes/${g.branchId}`,
        dedupeKey: `gift-expiring:${g.id}`,
      });
    }
    return gifts.length;
  }

  optIn(ctx: CustomerContext, branchId: string) {
    return this.repo.optIn(ctx.customerId, branchId);
  }

  async myGifts(ctx: CustomerContext, branchId?: string): Promise<GiftView[]> {
    return (await this.repo.activeGifts(ctx.customerId, this.now(), branchId)).map(giftView);
  }

  /** A gift of this customer, still usable (for its 6-digit code). */
  async usableGift(ctx: CustomerContext, giftId: string): Promise<GiftRecord> {
    const g = await this.repo.gift(giftId);
    if (!g || g.customerId !== ctx.customerId || g.usedAt || g.expiresAt <= this.now()) throw ClubErrors.giftNotFound();
    return g;
  }

  // Owner
  async club(owner: OwnerContext, branchId: string): Promise<Static<typeof ClubView>> {
    await this.ownBranch(owner, branchId);
    const [customers, members] = await Promise.all([this.repo.customerCount(branchId), this.repo.members(branchId)]);
    return {
      customers,
      members: members
        .map((m) => ({ ...m, lastVisit: m.lastVisit?.toISOString() ?? null }))
        .sort((a, b) => b.spent - a.spent),
    };
  }

  async sendGifts(owner: OwnerContext, branchId: string, body: SendGiftsBody) {
    if (owner.role !== 'owner') throw Errors.forbidden();
    await this.ownBranch(owner, branchId);
    if (body.kind === 'free_product' && !body.productId) throw ClubErrors.invalidGift('Choisissez le produit offert');
    if (body.kind === 'amount_off' && !body.amount) throw ClubErrors.invalidGift('Indiquez le montant de la remise');
    const name = body.name.trim();
    if (!name) throw ClubErrors.invalidGift('Donnez un nom au cadeau');
    const members = await this.repo.optedIn(branchId, [...new Set(body.customerIds)]);
    if (members.length === 0) throw ClubErrors.noMembers();

    const now = this.now();
    const campaignId = newId();
    const expiresAt = new Date(now.getTime() + body.validDays * 86_400_000);
    const gifts = members.map((customerId) => ({ customerId, id: newId() }));
    await this.repo.createGifts(
      gifts.map(({ customerId, id }) => ({
        id,
        campaignId,
        branchId,
        customerId,
        name,
        kind: body.kind,
        productId: body.kind === 'free_product' ? body.productId! : null,
        amount: body.kind === 'amount_off' ? body.amount! : null,
        expiresAt,
        usedAt: null,
        createdBy: owner.userId,
      })),
    );
    // 🔔 Each member: the gift.
    const cafe = (await this.repo.branchName(branchId)) ?? 'Votre café';
    for (const g of gifts) {
      await this.notify?.customer(g.customerId, {
        kind: 'gift',
        branchId,
        title: `🎁 Cadeau de ${cafe}`,
        body: `${name} · valable jusqu’au ${untilDay(expiresAt)}.`,
        link: `/app/cafes/${branchId}`,
        dedupeKey: `gift:${g.id}`,
      });
    }
    return { campaignId, sent: members.length, skipped: body.customerIds.length - members.length };
  }

  async campaigns(owner: OwnerContext, branchId: string) {
    await this.ownBranch(owner, branchId);
    return (await this.repo.campaigns(branchId)).map((c) => ({ ...c, sentAt: c.sentAt.toISOString(), expiresAt: c.expiresAt.toISOString() }));
  }

  private async ownBranch(owner: OwnerContext, branchId: string) {
    if ((await this.repo.branchTenant(branchId)) !== owner.tenantId) throw ClubErrors.branchNotFound();
  }
}

// ── Routes ──────────────────────────────────────────────────────

export const clubRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const club = app.services.club;

  // Customer
  app.put(
    '/v1/customer/cafes/:branchId/club',
    {
      schema: { params: BranchParams, body: Type.Object({ optIn: Type.Boolean() }, { additionalProperties: false }) },
      preHandler: app.requireCustomer,
    },
    async (req) => {
      await club.setOptIn(req.customer, req.params.branchId, req.body.optIn);
      return { optIn: req.body.optIn };
    },
  );
  app.get('/v1/customer/gifts', { schema: { response: { 200: Type.Array(GiftView) } }, preHandler: app.requireCustomer }, (req) =>
    club.myGifts(req.customer),
  );

  // Owner
  app.get(
    '/v1/owner/branches/:branchId/club',
    { schema: { params: BranchParams, response: { 200: ClubView } }, preHandler: app.requireOwner },
    (req) => club.club(req.owner, req.params.branchId),
  );
  app.post(
    '/v1/owner/branches/:branchId/gifts',
    {
      schema: {
        params: BranchParams,
        body: SendGiftsBody,
        response: { 200: Type.Object({ campaignId: Type.String(), sent: Type.Integer(), skipped: Type.Integer() }) },
      },
      preHandler: app.requireOwner,
    },
    (req) => club.sendGifts(req.owner, req.params.branchId, req.body),
  );
  app.get(
    '/v1/owner/branches/:branchId/gifts',
    { schema: { params: BranchParams, response: { 200: Type.Array(Campaign) } }, preHandler: app.requireOwner },
    (req) => club.campaigns(req.owner, req.params.branchId),
  );
};
