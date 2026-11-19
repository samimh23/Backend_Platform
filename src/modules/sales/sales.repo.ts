import { and, desc, eq, gte, inArray, isNotNull, lt, or } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { branches, devices, salesOrderLines, salesOrders, salesPayments } from '../../db/schema.js';

export interface SalesOrderRecord {
  id: string;
  tenantId: string;
  branchId: string;
  status: 'open' | 'paid' | 'cancelled' | 'refunded';
  type: string;
  openedAt: Date;
  closedAt: Date | null;
  total: number;
  itemCount: number;
  receiptNumber: string | null;
  paymentMethod: string | null;
  deviceCode: string | null;
  tableName: string | null;
  refundedAt: Date | null;
  refundReason: string | null;
}

export interface SalesLineRecord {
  id: string;
  orderId: string;
  productId: string;
  name: string;
  unitPrice: number;
  modifiersPrice: number;
  modifiers: unknown;
  qty: number;
  vatRateBp: number;
  voided: boolean;
  discountType: string | null;
  discountValue: number;
  discountReason: string | null;
  voidReason: string | null;
}

export interface SalesPaymentRecord {
  orderId: string;
  method: string;
  amount: number;
  tendered: number;
  changeGiven: number;
}

export interface OrdersWithDetails {
  orders: SalesOrderRecord[];
  lines: SalesLineRecord[];
  payments: SalesPaymentRecord[];
}

export interface SalesRepo {
  branchTenant(branchId: string): Promise<string | null>;
  /**
   * Orders of a time window: paid/cancelled ones by close time, open ones by open time.
   * Newest first. With their lines and payments.
   */
  ordersInRange(branchId: string, from: Date, to: Date): Promise<OrdersWithDetails>;
  findOrder(orderId: string): Promise<OrdersWithDetails>;
}

const orderColumns = {
  id: salesOrders.id,
  tenantId: salesOrders.tenantId,
  branchId: salesOrders.branchId,
  status: salesOrders.status,
  type: salesOrders.type,
  openedAt: salesOrders.openedAt,
  closedAt: salesOrders.closedAt,
  total: salesOrders.total,
  itemCount: salesOrders.itemCount,
  receiptNumber: salesOrders.receiptNumber,
  paymentMethod: salesOrders.paymentMethod,
  deviceCode: devices.code,
  tableName: salesOrders.tableName,
  refundedAt: salesOrders.refundedAt,
  refundReason: salesOrders.refundReason,
};

export class DrizzleSalesRepo implements SalesRepo {
  constructor(private readonly db: Db) {}

  async branchTenant(branchId: string) {
    const [b] = await this.db.select({ tenantId: branches.tenantId }).from(branches).where(eq(branches.id, branchId));
    return b?.tenantId ?? null;
  }

  async ordersInRange(branchId: string, from: Date, to: Date) {
    const orders = await this.db
      .select(orderColumns)
      .from(salesOrders)
      .leftJoin(devices, eq(devices.id, salesOrders.deviceId))
      .where(
        and(
          eq(salesOrders.branchId, branchId),
          or(
            and(isNotNull(salesOrders.closedAt), gte(salesOrders.closedAt, from), lt(salesOrders.closedAt, to)),
            and(eq(salesOrders.status, 'open'), gte(salesOrders.openedAt, from), lt(salesOrders.openedAt, to)),
          ),
        ),
      )
      // Ids are UUID v7 (time-ordered): tie-breaker when two orders open in the same millisecond.
      .orderBy(desc(salesOrders.openedAt), desc(salesOrders.id));
    return this.withDetails(orders);
  }

  async findOrder(orderId: string) {
    const orders = await this.db
      .select(orderColumns)
      .from(salesOrders)
      .leftJoin(devices, eq(devices.id, salesOrders.deviceId))
      .where(eq(salesOrders.id, orderId));
    return this.withDetails(orders);
  }

  private async withDetails(orders: SalesOrderRecord[]): Promise<OrdersWithDetails> {
    if (orders.length === 0) return { orders, lines: [], payments: [] };
    const ids = orders.map((o) => o.id);
    const [lines, payments] = await Promise.all([
      this.db.select().from(salesOrderLines).where(inArray(salesOrderLines.orderId, ids)),
      this.db
        .select({
          orderId: salesPayments.orderId,
          method: salesPayments.method,
          amount: salesPayments.amount,
          tendered: salesPayments.tendered,
          changeGiven: salesPayments.changeGiven,
        })
        .from(salesPayments)
        .where(inArray(salesPayments.orderId, ids)),
    ]);
    return { orders, lines, payments };
  }
}
