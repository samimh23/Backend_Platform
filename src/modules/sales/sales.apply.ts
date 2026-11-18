import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { salesOrderLines, salesOrders, salesPayments } from '../../db/schema.js';
import type { DeviceContext } from '../devices/devices.service.js';
import type { ProjectionOp } from './sales.projection.js';

/** A Drizzle transaction (or the db itself). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Executes projection operations. Called inside the sync transaction. */
export async function applyProjection(tx: Tx, ctx: DeviceContext, ops: ProjectionOp[]): Promise<void> {
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
        await tx.update(salesOrderLines).set({ voided: true }).where(eq(salesOrderLines.id, op.lineId));
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
        break;

      case 'cancelOrder':
        await tx.update(salesOrders).set({ status: 'cancelled', closedAt: op.closedAt }).where(eq(salesOrders.id, op.orderId));
        break;
    }
  }
}
