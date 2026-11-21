import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { and, eq, gte, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { branches, cashSessions, devices, ownerUsers } from '../../db/schema.js';
import type { OwnerContext } from '../auth/auth.service.js';
import type { SalesService } from '../sales/sales.service.js';
import { dayRange, todayInTunis } from '../sales/sales.service.js';
import type { StockService } from '../stock/stock.js';
import type { Mailer } from './mailer.js';
import { dailySummaryEmail } from './templates.js';

/** Each morning at 07:00 (Tunis), every owner gets yesterday's summary by email — once. */
export const SEND_HOUR_TUNIS = 7;

export interface DailySummaryRepo {
  /** Owners who want the email and haven't had it for [day]. */
  dueOwners(day: string): Promise<{ id: string; tenantId: string; name: string; email: string }[]>;
  /** Takes the job for this owner and day (only one server sends it). */
  claim(userId: string, day: string): Promise<boolean>;
  branches(tenantId: string): Promise<{ id: string; name: string }[]>;
  cashGaps(branchId: string, from: Date, to: Date): Promise<{ drawer: string; difference: number }[]>;
  preference(userId: string): Promise<boolean>;
  setPreference(userId: string, on: boolean): Promise<void>;
}

export class DrizzleDailySummaryRepo implements DailySummaryRepo {
  constructor(private readonly db: Db) {}

  dueOwners(day: string) {
    return this.db
      .select({ id: ownerUsers.id, tenantId: ownerUsers.tenantId, name: ownerUsers.name, email: ownerUsers.email })
      .from(ownerUsers)
      .where(
        and(
          eq(ownerUsers.role, 'owner'),
          eq(ownerUsers.dailyEmail, true),
          or(isNull(ownerUsers.dailyEmailSentFor), lt(ownerUsers.dailyEmailSentFor, day)),
        ),
      );
  }

  async claim(userId: string, day: string) {
    const rows = await this.db
      .update(ownerUsers)
      .set({ dailyEmailSentFor: day })
      .where(and(eq(ownerUsers.id, userId), or(isNull(ownerUsers.dailyEmailSentFor), lt(ownerUsers.dailyEmailSentFor, day))))
      .returning({ id: ownerUsers.id });
    return rows.length === 1;
  }

  branches(tenantId: string) {
    return this.db.select({ id: branches.id, name: branches.name }).from(branches).where(eq(branches.tenantId, tenantId));
  }

  async cashGaps(branchId: string, from: Date, to: Date) {
    const rows = await this.db
      .select({ drawer: sql<string>`coalesce(${devices.code}, '?')`, difference: cashSessions.difference })
      .from(cashSessions)
      .leftJoin(devices, eq(devices.id, cashSessions.drawerDeviceId))
      .where(
        and(
          eq(cashSessions.branchId, branchId),
          gte(cashSessions.closedAt, from),
          lt(cashSessions.closedAt, to),
          ne(cashSessions.difference, 0),
        ),
      );
    return rows.map((r) => ({ drawer: r.drawer, difference: Number(r.difference) }));
  }

  async preference(userId: string) {
    const [u] = await this.db.select({ on: ownerUsers.dailyEmail }).from(ownerUsers).where(eq(ownerUsers.id, userId));
    return u?.on ?? false;
  }

  async setPreference(userId: string, on: boolean) {
    await this.db.update(ownerUsers).set({ dailyEmail: on, updatedAt: new Date() }).where(eq(ownerUsers.id, userId));
  }
}

const dayLabel = (day: string) =>
  new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    new Date(`${day}T12:00:00Z`),
  );

const yesterday = (now: Date) => {
  const today = todayInTunis(now);
  return new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
};

export class DailySummaryService {
  constructor(
    private readonly repo: DailySummaryRepo,
    private readonly sales: SalesService,
    private readonly stock: StockService,
    private readonly mailer: Mailer,
    private readonly webUrl: string,
    private readonly log: (msg: string, err?: unknown) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Called every few minutes; sends what is due. Returns how many emails went out. */
  async run(): Promise<number> {
    const now = this.now();
    const tunisHour = new Date(now.getTime() + 3600_000).getUTCHours();
    if (tunisHour < SEND_HOUR_TUNIS) return 0;
    const day = yesterday(now);
    let sent = 0;
    for (const owner of await this.repo.dueOwners(day)) {
      if (!(await this.repo.claim(owner.id, day))) continue; // another server took it
      try {
        sent += await this.sendFor(owner, day);
      } catch (e) {
        this.log(`daily summary for ${owner.id} failed`, e);
      }
    }
    return sent;
  }

  private async sendFor(owner: { id: string; tenantId: string; name: string; email: string }, day: string) {
    const ctx: OwnerContext = { userId: owner.id, tenantId: owner.tenantId, role: 'owner' };
    const { from, to } = dayRange(day);
    let sent = 0;
    for (const b of await this.repo.branches(owner.tenantId)) {
      const [s, stock, cashGaps] = await Promise.all([
        this.sales.summary(ctx, b.id, day),
        this.stock.list(ctx, b.id),
        this.repo.cashGaps(b.id, from, to),
      ]);
      // A closed day with nothing to say: no email.
      if (s.ticketCount === 0 && s.cancelledCount === 0 && s.refunds.count === 0 && cashGaps.length === 0) continue;
      await this.mailer.send(
        dailySummaryEmail({
          ownerName: owner.name,
          to: owner.email,
          cafeName: b.name,
          dayLabel: dayLabel(day),
          revenue: s.revenue,
          tickets: s.ticketCount,
          averageTicket: s.averageTicket,
          topProducts: s.topProducts.slice(0, 3).map((p) => ({ name: p.name, qty: p.qty })),
          cancelled: s.cancelledCount,
          refunds: s.refunds,
          discounts: s.discounts.amount,
          cashGaps,
          lowStock: stock.items.filter((i) => i.low).map((i) => i.name),
          dashboardUrl: `${this.webUrl}/owner/dashboard?date=${day}`,
          settingsUrl: `${this.webUrl}/owner/settings`,
        }),
      );
      sent++;
    }
    return sent;
  }

  preference(owner: OwnerContext) {
    return this.repo.preference(owner.userId);
  }

  setPreference(owner: OwnerContext, on: boolean) {
    return this.repo.setPreference(owner.userId, on);
  }
}

export const dailySummaryRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const daily = app.services.dailySummary;
  const Prefs = Type.Object({ dailyEmail: Type.Boolean() }, { additionalProperties: false });

  app.get('/v1/owner/me/preferences', { schema: { response: { 200: Prefs } }, preHandler: app.requireOwner }, async (req) => ({
    dailyEmail: await daily.preference(req.owner),
  }));
  app.put('/v1/owner/me/preferences', { schema: { body: Prefs, response: { 200: Prefs } }, preHandler: app.requireOwner }, async (req) => {
    await daily.setPreference(req.owner, req.body.dailyEmail);
    return { dailyEmail: req.body.dailyEmail };
  });
};
