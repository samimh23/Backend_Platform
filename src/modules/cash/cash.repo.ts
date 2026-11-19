import { and, asc, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { branches, cashMovements, cashSessions, devices, staff } from '../../db/schema.js';

export interface CashSessionRecord {
  id: string;
  tenantId: string;
  branchId: string;
  drawerDeviceId: string;
  status: 'open' | 'closed';
  openedAt: Date;
  openedBy: string | null;
  openingFloat: number;
  closedAt: Date | null;
  closedBy: string | null;
  countedCash: number | null;
  expectedCash: number | null;
  difference: number | null;
  cashSales: number;
  cardSales: number;
  cashIn: number;
  cashOut: number;
  ticketCount: number;
  note: string | null;
}

export interface CashMovementRecord {
  id: string;
  sessionId: string;
  type: 'in' | 'out';
  amount: number;
  reason: string;
  staffId: string | null;
  createdAt: Date;
}

export interface CashRepo {
  branchTenant(branchId: string): Promise<string | null>;
  /** Newest first. With a window: sessions opened in it. */
  listSessions(branchId: string, window: { from: Date; to: Date } | null, limit: number): Promise<CashSessionRecord[]>;
  findSession(id: string): Promise<CashSessionRecord | null>;
  movements(sessionId: string): Promise<CashMovementRecord[]>;
  /** For display: id → name. */
  staffNames(ids: string[]): Promise<Map<string, string>>;
  deviceNames(ids: string[]): Promise<Map<string, { code: string; name: string }>>;
}

const columns = {
  id: cashSessions.id,
  tenantId: cashSessions.tenantId,
  branchId: cashSessions.branchId,
  drawerDeviceId: cashSessions.drawerDeviceId,
  status: cashSessions.status,
  openedAt: cashSessions.openedAt,
  openedBy: cashSessions.openedBy,
  openingFloat: cashSessions.openingFloat,
  closedAt: cashSessions.closedAt,
  closedBy: cashSessions.closedBy,
  countedCash: cashSessions.countedCash,
  expectedCash: cashSessions.expectedCash,
  difference: cashSessions.difference,
  cashSales: cashSessions.cashSales,
  cardSales: cashSessions.cardSales,
  cashIn: cashSessions.cashIn,
  cashOut: cashSessions.cashOut,
  ticketCount: cashSessions.ticketCount,
  note: cashSessions.note,
};

export class DrizzleCashRepo implements CashRepo {
  constructor(private readonly db: Db) {}

  async branchTenant(branchId: string) {
    const [b] = await this.db.select({ tenantId: branches.tenantId }).from(branches).where(eq(branches.id, branchId));
    return b?.tenantId ?? null;
  }

  listSessions(branchId: string, window: { from: Date; to: Date } | null, limit: number) {
    return this.db
      .select(columns)
      .from(cashSessions)
      .where(
        window
          ? and(eq(cashSessions.branchId, branchId), gte(cashSessions.openedAt, window.from), lt(cashSessions.openedAt, window.to))
          : eq(cashSessions.branchId, branchId),
      )
      .orderBy(desc(cashSessions.openedAt), desc(cashSessions.id))
      .limit(limit);
  }

  async findSession(id: string) {
    const [s] = await this.db.select(columns).from(cashSessions).where(eq(cashSessions.id, id));
    return s ?? null;
  }

  movements(sessionId: string) {
    return this.db
      .select()
      .from(cashMovements)
      .where(eq(cashMovements.sessionId, sessionId))
      .orderBy(asc(cashMovements.createdAt));
  }

  async staffNames(ids: string[]) {
    if (ids.length === 0) return new Map<string, string>();
    const rows = await this.db.select({ id: staff.id, name: staff.name }).from(staff).where(inArray(staff.id, ids));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async deviceNames(ids: string[]) {
    if (ids.length === 0) return new Map<string, { code: string; name: string }>();
    const rows = await this.db
      .select({ id: devices.id, code: devices.code, name: devices.name })
      .from(devices)
      .where(inArray(devices.id, ids));
    return new Map(rows.map((r) => [r.id, { code: r.code, name: r.name }]));
  }
}
