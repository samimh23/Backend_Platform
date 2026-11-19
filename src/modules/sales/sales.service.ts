import { AppError } from '../../shared/errors.js';
import { discountOf, roundDiv, vatBreakdown } from '../../shared/money.js';
import type { OwnerContext } from '../auth/auth.service.js';
import type { SalesLineRecord, SalesOrderRecord, SalesRepo } from './sales.repo.js';
import type { OrderDetail, OrderView, SalesSummary } from './sales.schema.js';

export const SalesErrors = {
  branchNotFound: () => new AppError('BRANCH_NOT_FOUND', 'Branch not found', 404),
  orderNotFound: () => new AppError('ORDER_NOT_FOUND', 'Order not found', 404),
};

/**
 * Tunisia is UTC+1 all year (no daylight saving). A "day" for the café runs
 * 00:00 → 24:00 Tunisia time. (Later: per-branch timezone and closing hour.)
 */
export const TUNIS_OFFSET_MS = 60 * 60 * 1000;

export function dayRange(date: string): { from: Date; to: Date } {
  const from = new Date(new Date(`${date}T00:00:00.000Z`).getTime() - TUNIS_OFFSET_MS);
  return { from, to: new Date(from.getTime() + 24 * 3600 * 1000) };
}

export function todayInTunis(now: Date): string {
  return new Date(now.getTime() + TUNIS_OFFSET_MS).toISOString().slice(0, 10);
}

const lineGross = (l: SalesLineRecord) => (l.voided ? 0 : (l.unitPrice + l.modifiersPrice) * l.qty);
const lineDiscount = (l: SalesLineRecord) => discountOf(lineGross(l), l.discountType, l.discountValue);
/** What the customer pays for the line: gross − discount. */
const lineTotal = (l: SalesLineRecord) => lineGross(l) - lineDiscount(l);

export class SalesService {
  constructor(
    private readonly repo: SalesRepo,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Dashboard numbers for one day. */
  async summary(owner: OwnerContext, branchId: string, date?: string): Promise<SalesSummary> {
    await this.assertBranch(owner, branchId);
    const day = date ?? todayInTunis(this.now());
    const { from, to } = dayRange(day);
    const { orders, lines, payments } = await this.repo.ordersInRange(branchId, from, to);

    const paid = orders.filter((o) => o.status === 'paid');
    const paidIds = new Set(paid.map((o) => o.id));
    const revenue = paid.reduce((s, o) => s + o.total, 0);

    const byMethod = new Map<string, { amount: number; count: number }>();
    for (const p of payments.filter((p) => paidIds.has(p.orderId))) {
      const m = byMethod.get(p.method) ?? { amount: 0, count: 0 };
      byMethod.set(p.method, { amount: m.amount + p.amount, count: m.count + 1 });
    }

    const byHour = new Map<number, { revenue: number; tickets: number }>();
    for (const o of paid) {
      const hour = new Date(o.closedAt!.getTime() + TUNIS_OFFSET_MS).getUTCHours();
      const h = byHour.get(hour) ?? { revenue: 0, tickets: 0 };
      byHour.set(hour, { revenue: h.revenue + o.total, tickets: h.tickets + 1 });
    }

    const paidLines = lines.filter((l) => paidIds.has(l.orderId) && !l.voided);
    const byProduct = new Map<string, { productId: string; name: string; qty: number; revenue: number }>();
    for (const l of paidLines) {
      const p = byProduct.get(l.productId) ?? { productId: l.productId, name: l.name, qty: 0, revenue: 0 };
      byProduct.set(l.productId, { ...p, qty: p.qty + l.qty, revenue: p.revenue + lineTotal(l) });
    }

    const discounted = paidLines.filter((l) => l.discountType);
    return {
      date: day,
      revenue,
      discounts: {
        amount: discounted.reduce((s, l) => s + lineDiscount(l), 0),
        lines: discounted.length,
        freeItems: discounted.filter((l) => l.discountType === 'free').reduce((s, l) => s + l.qty, 0),
      },
      ticketCount: paid.length,
      averageTicket: paid.length ? roundDiv(revenue, paid.length) : 0,
      itemCount: paid.reduce((s, o) => s + o.itemCount, 0),
      cancelledCount: orders.filter((o) => o.status === 'cancelled').length,
      refunds: {
        count: orders.filter((o) => o.status === 'refunded').length,
        amount: orders.filter((o) => o.status === 'refunded').reduce((s, o) => s + o.total, 0),
      },
      openCount: orders.filter((o) => o.status === 'open').length,
      byPaymentMethod: [...byMethod.entries()].map(([method, v]) => ({ method, ...v })).sort((a, b) => b.amount - a.amount),
      byHour: [...byHour.entries()].map(([hour, v]) => ({ hour, ...v })).sort((a, b) => a.hour - b.hour),
      topProducts: [...byProduct.values()].sort((a, b) => b.revenue - a.revenue || b.qty - a.qty).slice(0, 5),
      vat: vatBreakdown(paidLines.map((l) => ({ rateBp: l.vatRateBp, ttc: lineTotal(l) }))),
    };
  }

  /** Tickets of a day, newest first. */
  async listOrders(
    owner: OwnerContext,
    branchId: string,
    query: { date?: string; status?: 'open' | 'paid' | 'cancelled' | 'refunded'; limit?: number },
  ): Promise<OrderView[]> {
    await this.assertBranch(owner, branchId);
    const { from, to } = dayRange(query.date ?? todayInTunis(this.now()));
    const { orders } = await this.repo.ordersInRange(branchId, from, to);
    return orders
      .filter((o) => !query.status || o.status === query.status)
      .slice(0, query.limit ?? 50)
      .map(orderView);
  }

  /** One ticket with its lines (including removed ones), payments and VAT. */
  async getOrder(owner: OwnerContext, orderId: string): Promise<OrderDetail> {
    const { orders, lines, payments } = await this.repo.findOrder(orderId);
    const order = orders[0];
    if (!order || order.tenantId !== owner.tenantId) throw SalesErrors.orderNotFound();

    return {
      ...orderView(order),
      lines: lines.map((l) => ({
        id: l.id,
        productId: l.productId,
        name: l.name,
        unitPrice: l.unitPrice,
        modifiersPrice: l.modifiersPrice,
        modifiers: l.modifiers,
        qty: l.qty,
        vatRateBp: l.vatRateBp,
        voided: l.voided,
        discount: lineDiscount(l),
        discountType: l.discountType,
        discountReason: l.discountReason,
        voidReason: l.voidReason,
        total: lineTotal(l),
      })),
      payments: payments.map(({ method, amount, tendered, changeGiven }) => ({ method, amount, tendered, changeGiven })),
      vat: vatBreakdown(lines.filter((l) => !l.voided).map((l) => ({ rateBp: l.vatRateBp, ttc: lineTotal(l) }))),
    };
  }

  private async assertBranch(owner: OwnerContext, branchId: string) {
    if ((await this.repo.branchTenant(branchId)) !== owner.tenantId) throw SalesErrors.branchNotFound();
  }
}

function orderView(o: SalesOrderRecord): OrderView {
  return {
    id: o.id,
    status: o.status,
    type: o.type,
    receiptNumber: o.receiptNumber,
    openedAt: o.openedAt.toISOString(),
    closedAt: o.closedAt?.toISOString() ?? null,
    total: o.total,
    itemCount: o.itemCount,
    paymentMethod: o.paymentMethod,
    deviceCode: o.deviceCode,
    tableName: o.tableName,
    refundedAt: o.refundedAt?.toISOString() ?? null,
    refundReason: o.refundReason,
  };
}
