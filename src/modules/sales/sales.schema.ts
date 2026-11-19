import { Type, type Static } from '@sinclair/typebox';

export const BranchParams = Type.Object({ branchId: Type.String({ format: 'uuid' }) });
export const OrderParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) });

/** A café day, Tunisia time. Default: today. */
const DateParam = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD (Tunisia time)' });

export const SummaryQuery = Type.Object({ date: Type.Optional(DateParam) });

export const OrdersQuery = Type.Object({
  date: Type.Optional(DateParam),
  status: Type.Optional(
    Type.Union([Type.Literal('open'), Type.Literal('paid'), Type.Literal('cancelled'), Type.Literal('refunded')]),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

const VatLine = Type.Object({ rateBp: Type.Integer(), ttc: Type.Integer(), ht: Type.Integer(), vat: Type.Integer() });

/** All amounts in millimes. */
export const SalesSummary = Type.Object({
  date: Type.String(),
  /** Total of paid tickets (TTC). */
  revenue: Type.Integer(),
  /** Discounts and free items on paid tickets ("Remises & offerts"). */
  discounts: Type.Object({ amount: Type.Integer(), lines: Type.Integer(), freeItems: Type.Integer() }),
  /** Tickets refunded (counted out of revenue). */
  refunds: Type.Object({ count: Type.Integer(), amount: Type.Integer() }),
  ticketCount: Type.Integer(),
  averageTicket: Type.Integer(),
  itemCount: Type.Integer(),
  cancelledCount: Type.Integer(),
  /** Orders started but not paid yet. */
  openCount: Type.Integer(),
  byPaymentMethod: Type.Array(Type.Object({ method: Type.String(), amount: Type.Integer(), count: Type.Integer() })),
  /** Hour of the day in Tunisia time (0–23), only hours with sales. */
  byHour: Type.Array(Type.Object({ hour: Type.Integer(), revenue: Type.Integer(), tickets: Type.Integer() })),
  topProducts: Type.Array(
    Type.Object({ productId: Type.String(), name: Type.String(), qty: Type.Integer(), revenue: Type.Integer() }),
  ),
  vat: Type.Array(VatLine),
});
export type SalesSummary = Static<typeof SalesSummary>;

export const OrderView = Type.Object({
  id: Type.String(),
  status: Type.String(),
  type: Type.String(),
  receiptNumber: Type.Union([Type.String(), Type.Null()]),
  openedAt: Type.String(),
  closedAt: Type.Union([Type.String(), Type.Null()]),
  total: Type.Integer(),
  itemCount: Type.Integer(),
  paymentMethod: Type.Union([Type.String(), Type.Null()]),
  /** T1, T2… — which POS took the order. */
  deviceCode: Type.Union([Type.String(), Type.Null()]),
  /** Table name at sale time, null = counter / takeaway. */
  tableName: Type.Union([Type.String(), Type.Null()]),
  /** Refunded after payment: when and why (changed_mind | error | quality | other). */
  refundedAt: Type.Union([Type.String(), Type.Null()]),
  refundReason: Type.Union([Type.String(), Type.Null()]),
});
export type OrderView = Static<typeof OrderView>;

export const OrderDetail = Type.Composite([
  OrderView,
  Type.Object({
    lines: Type.Array(
      Type.Object({
        id: Type.String(),
        productId: Type.String(),
        name: Type.String(),
        unitPrice: Type.Integer(),
        modifiersPrice: Type.Integer(),
        modifiers: Type.Unknown(),
        qty: Type.Integer(),
        vatRateBp: Type.Integer(),
        /** Removed from the ticket by the cashier (kept for control). */
        voided: Type.Boolean(),
        /** Discount on the line (millimes), with its type and reason. */
        discount: Type.Integer(),
        discountType: Type.Union([Type.String(), Type.Null()]),
        discountReason: Type.Union([Type.String(), Type.Null()]),
        /** Removed after "Envoyer": why. */
        voidReason: Type.Union([Type.String(), Type.Null()]),
        /** After discount. */
        total: Type.Integer(),
      }),
    ),
    payments: Type.Array(
      Type.Object({ method: Type.String(), amount: Type.Integer(), tendered: Type.Integer(), changeGiven: Type.Integer() }),
    ),
    vat: Type.Array(VatLine),
  }),
]);
export type OrderDetail = Static<typeof OrderDetail>;
