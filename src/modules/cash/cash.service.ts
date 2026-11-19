import { AppError } from '../../shared/errors.js';
import type { OwnerContext } from '../auth/auth.service.js';
import { dayRange } from '../sales/sales.service.js';
import type { CashRepo, CashSessionRecord } from './cash.repo.js';
import type { CashSessionDetail, CashSessionView } from './cash.schema.js';

export const CashErrors = {
  branchNotFound: () => new AppError('BRANCH_NOT_FOUND', 'Branch not found', 404),
  sessionNotFound: () => new AppError('CASH_SESSION_NOT_FOUND', 'Cash session not found', 404),
};

/** Owner app: the cash drawers' days (opening float, movements, closing count). Read-only. */
export class CashService {
  constructor(private readonly repo: CashRepo) {}

  async list(owner: OwnerContext, branchId: string, query: { date?: string; limit?: number }): Promise<CashSessionView[]> {
    if ((await this.repo.branchTenant(branchId)) !== owner.tenantId) throw CashErrors.branchNotFound();
    const sessions = await this.repo.listSessions(branchId, query.date ? dayRange(query.date) : null, query.limit ?? 50);
    return this.views(sessions);
  }

  async get(owner: OwnerContext, sessionId: string): Promise<CashSessionDetail> {
    const s = await this.repo.findSession(sessionId);
    // Another business's session looks exactly like a missing one.
    if (!s || s.tenantId !== owner.tenantId) throw CashErrors.sessionNotFound();
    const [[view], movements] = await Promise.all([this.views([s]), this.repo.movements(s.id)]);
    const names = await this.repo.staffNames(movements.flatMap((m) => (m.staffId ? [m.staffId] : [])));
    return {
      ...view!,
      movements: movements.map((m) => ({
        id: m.id,
        type: m.type,
        amount: m.amount,
        reason: m.reason,
        staff: m.staffId ? (names.get(m.staffId) ?? null) : null,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  private async views(sessions: CashSessionRecord[]): Promise<CashSessionView[]> {
    const staffIds = sessions.flatMap((s) => [s.openedBy, s.closedBy]).filter((x): x is string => !!x);
    const [names, drawers] = await Promise.all([
      this.repo.staffNames([...new Set(staffIds)]),
      this.repo.deviceNames([...new Set(sessions.map((s) => s.drawerDeviceId))]),
    ]);
    return sessions.map((s) => {
      const d = drawers.get(s.drawerDeviceId);
      return {
        id: s.id,
        status: s.status,
        drawer: d ? { id: s.drawerDeviceId, ...d } : null,
        openedAt: s.openedAt.toISOString(),
        openedBy: s.openedBy ? (names.get(s.openedBy) ?? null) : null,
        openingFloat: s.openingFloat,
        closedAt: s.closedAt?.toISOString() ?? null,
        closedBy: s.closedBy ? (names.get(s.closedBy) ?? null) : null,
        countedCash: s.countedCash,
        expectedCash: s.expectedCash,
        difference: s.difference,
        cashSales: s.cashSales,
        cardSales: s.cardSales,
        cashIn: s.cashIn,
        cashOut: s.cashOut,
        ticketCount: s.ticketCount,
        note: s.note,
      };
    });
  }
}
