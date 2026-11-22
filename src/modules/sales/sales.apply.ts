import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { cashMovements, cashSessions, devices, salesOrderLines, salesOrders, salesPayments } from '../../db/schema.js';
import type { DeviceContext } from '../devices/devices.service.js';
import { notifyOwnersSql } from '../notifications/notifications.js';
import { ownerNotices, stockLowNotice, type NoticeLookup } from '../notifications/sales-notices.js';
import { consumeForOrder, type CrossedLow } from '../stock/stock.js';
import { todayInTunis } from './sales.service.js';
import type { ProjectionOp } from './sales.projection.js';

/** A Drizzle transaction (or the db itself). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Executes projection operations. Called inside the sync transaction. */
export async function applyProjection(tx: Tx, ctx: DeviceContext, ops: ProjectionOp[]): Promise<void> {
  const lowStock: CrossedLow[] = [];
  for (const op of ops) {
    switch (op.kind) {
      case 'openOrder':
        await tx
          .insert(salesOrders)
          .values({
            id: op.orderId,
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            deviceId: ctx.deviceId,
            type: op.type,
            openedAt: op.openedAt,
            tableId: op.table?.id ?? null,
            tableName: op.table?.name ?? null,
          })
          .onConflictDoNothing();
        break;

      case 'moveTable':
        await tx
          .update(salesOrders)
          .set({ tableId: op.table?.id ?? null, tableName: op.table?.name ?? null, type: op.table ? 'table' : 'takeaway' })
          .where(eq(salesOrders.id, op.orderId));
        break;

      case 'addLine':
        await tx
          .insert(salesOrderLines)
          .values({ ...op.line, orderId: op.orderId })
          .onConflictDoNothing();
        break;

      case 'setLineQty':
        await tx.update(salesOrderLines).set({ qty: op.qty }).where(eq(salesOrderLines.id, op.lineId));
        break;

      case 'voidLine':
        await tx
          .update(salesOrderLines)
          .set({ voided: true, voidReason: op.why, voidApprovedBy: op.approvedBy })
          .where(eq(salesOrderLines.id, op.lineId));
        break;

      case 'refundOrder':
        for (const p of op.payments) {
          await tx
            .insert(salesPayments)
            .values({ id: p.id, orderId: op.orderId, method: p.method, amount: p.amount, createdAt: op.refundedAt })
            .onConflictDoNothing();
        }
        await tx
          .update(salesOrders)
          .set({ status: 'refunded', refundedAt: op.refundedAt, refundReason: op.reason, refundApprovedBy: op.approvedBy })
          .where(eq(salesOrders.id, op.orderId));
        // Loyalty points earned with this receipt are taken back.
        await tx.execute(sql`
          insert into loyalty_ledger (id, customer_id, branch_id, points, kind, order_id, receipt_number, created_at)
          select gen_random_uuid(), customer_id, branch_id, -points, 'refund', order_id, receipt_number, ${op.refundedAt.toISOString()}::timestamptz
          from loyalty_ledger where order_id = ${op.orderId} and kind = 'earn'
          on conflict do nothing`);
        break;

      case 'discountLines':
        for (const l of op.lines) {
          await tx
            .update(salesOrderLines)
            .set({
              discountType: l.type,
              discountValue: l.type ? l.value : 0,
              discountReason: l.type ? op.reason : null,
              discountApprovedBy: l.type ? op.approvedBy : null,
            })
            .where(eq(salesOrderLines.id, l.lineId));
        }
        break;

      case 'payment':
        await tx
          .insert(salesPayments)
          .values({ ...op.payment, orderId: op.orderId })
          .onConflictDoNothing();
        // Several payments with different methods → "mixed".
        await tx
          .update(salesOrders)
          .set({
            paymentMethod: sql`CASE WHEN ${salesOrders.paymentMethod} IS NULL OR ${salesOrders.paymentMethod} = ${op.payment.method}
                                THEN ${op.payment.method} ELSE 'mixed' END`,
          })
          .where(eq(salesOrders.id, op.orderId));
        break;

      case 'closeOrder':
        await tx
          .update(salesOrders)
          .set({
            status: 'paid',
            closedAt: op.closedAt,
            total: op.total,
            itemCount: op.itemCount,
            receiptNumber: op.receiptNumber,
          })
          .where(eq(salesOrders.id, op.orderId));
        // Paid: its ingredients leave the stock.
        lowStock.push(...(await consumeForOrder(tx, { orderId: op.orderId, branchId: ctx.branchId })));
        break;

      case 'cancelOrder':
        await tx.update(salesOrders).set({ status: 'cancelled', closedAt: op.closedAt }).where(eq(salesOrders.id, op.orderId));
        break;

      case 'openCashSession':
        await tx
          .insert(cashSessions)
          .values({
            id: op.sessionId,
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            deviceId: ctx.deviceId,
            drawerDeviceId: op.drawerId,
            openedAt: op.openedAt,
            openedBy: op.staffId,
            openingFloat: op.openingFloat,
          })
          .onConflictDoNothing();
        break;

      case 'cashMovement':
        await tx
          .insert(cashMovements)
          .values({ ...op.movement, sessionId: op.sessionId })
          .onConflictDoNothing();
        break;

      case 'closeCashSession':
        await tx
          .update(cashSessions)
          .set({ status: 'closed', closedAt: op.closedAt, closedBy: op.staffId, note: op.note, ...op.totals })
          .where(eq(cashSessions.id, op.sessionId));
        break;
    }
  }

  // 🔔 What the owner should know about (same transaction: no notice without its data).
  const day = todayInTunis(new Date());
  const notices = [
    ...(await ownerNotices(ops, ctx.branchId, drizzleLookup(tx))),
    ...lowStock.map((i) => stockLowNotice(i, ctx.branchId, day)),
  ];
  for (const n of notices) await notifyOwnersSql(tx, ctx.tenantId, n);
}

function drizzleLookup(tx: Tx): NoticeLookup {
  return {
    async line(lineId) {
      const [l] = await tx
        .select({ name: salesOrderLines.name, qty: salesOrderLines.qty, orderId: salesOrderLines.orderId, receiptNumber: salesOrders.receiptNumber })
        .from(salesOrderLines)
        .innerJoin(salesOrders, eq(salesOrders.id, salesOrderLines.orderId))
        .where(eq(salesOrderLines.id, lineId));
      return l ?? null;
    },
    async receiptNumber(orderId) {
      const [o] = await tx.select({ n: salesOrders.receiptNumber }).from(salesOrders).where(eq(salesOrders.id, orderId));
      return o?.n ?? null;
    },
    async drawerCode(sessionId) {
      const [d] = await tx
        .select({ code: devices.code })
        .from(cashSessions)
        .innerJoin(devices, eq(devices.id, cashSessions.drawerDeviceId))
        .where(eq(cashSessions.id, sessionId));
      return d?.code ?? null;
    },
  };
}
