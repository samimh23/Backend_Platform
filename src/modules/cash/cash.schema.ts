import { Type, type Static } from '@sinclair/typebox';

export const BranchParams = Type.Object({ branchId: Type.String({ format: 'uuid' }) });
export const SessionParams = Type.Object({ sessionId: Type.String({ format: 'uuid' }) });

export const SessionsQuery = Type.Object({
  /** A café day, Tunisia time (by opening time). Omit for the latest sessions. */
  date: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

const Money = Type.Integer();
const NullableMoney = Type.Union([Type.Integer(), Type.Null()]);
const NullableString = Type.Union([Type.String(), Type.Null()]);

/** All amounts in millimes. */
export const CashSessionView = Type.Object({
  id: Type.String(),
  status: Type.String(),
  /** The POS whose drawer this is: "T1 · Caisse principale". */
  drawer: Type.Union([Type.Object({ id: Type.String(), code: Type.String(), name: Type.String() }), Type.Null()]),
  openedAt: Type.String(),
  openedBy: NullableString,
  openingFloat: Money,
  closedAt: NullableString,
  closedBy: NullableString,
  countedCash: NullableMoney,
  expectedCash: NullableMoney,
  /** counted − expected: negative = cash missing. */
  difference: NullableMoney,
  cashSales: Money,
  cardSales: Money,
  cashIn: Money,
  cashOut: Money,
  ticketCount: Type.Integer(),
  note: NullableString,
});
export type CashSessionView = Static<typeof CashSessionView>;

export const CashSessionDetail = Type.Composite([
  CashSessionView,
  Type.Object({
    movements: Type.Array(
      Type.Object({
        id: Type.String(),
        type: Type.String(),
        amount: Money,
        reason: Type.String(),
        staff: NullableString,
        createdAt: Type.String(),
      }),
    ),
  }),
]);
export type CashSessionDetail = Static<typeof CashSessionDetail>;
