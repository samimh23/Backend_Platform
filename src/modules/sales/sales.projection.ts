import type { SyncEvent } from '../sync/sync.schema.js';

/**
 * Turns POS events into simple operations on the sales tables.
 * PURE: no database here — the sync repo executes the operations in the same
 * transaction that stores the events, so events and sales never disagree.
 */
export type ProjectionOp =
  | { kind: 'openOrder'; orderId: string; type: string; openedAt: Date; table: TableRef | null }
  | { kind: 'moveTable'; orderId: string; table: TableRef | null }
  | {
      kind: 'addLine';
      orderId: string;
      line: {
        id: string;
        productId: string;
        name: string;
        unitPrice: number;
        modifiersPrice: number;
        modifiers: unknown[];
        qty: number;
        vatRateBp: number;
      };
    }
  | { kind: 'setLineQty'; lineId: string; qty: number }
  | { kind: 'voidLine'; lineId: string }
  | {
      kind: 'discountLines';
      reason: string | null;
      approvedBy: string | null;
      lines: { lineId: string; type: 'free' | 'percent' | 'amount' | null; value: number }[];
    }
  | {
      kind: 'payment';
      orderId: string;
      payment: { id: string; method: string; amount: number; tendered: number; changeGiven: number; createdAt: Date };
    }
  | { kind: 'closeOrder'; orderId: string; closedAt: Date; total: number; itemCount: number; receiptNumber: string | null }
  | { kind: 'cancelOrder'; orderId: string; closedAt: Date }
  | { kind: 'openCashSession'; sessionId: string; drawerId: string; openingFloat: number; openedAt: Date; staffId: string | null }
  | {
      kind: 'cashMovement';
      sessionId: string;
      movement: { id: string; type: 'in' | 'out'; amount: number; reason: string; staffId: string | null; createdAt: Date };
    }
  | { kind: 'closeCashSession'; sessionId: string; closedAt: Date; staffId: string | null; totals: CashTotals; note: string | null };

/** What the POS computed when the drawer was counted (millimes). */
export interface CashTotals {
  countedCash: number;
  expectedCash: number;
  difference: number;
  cashSales: number;
  cardSales: number;
  cashIn: number;
  cashOut: number;
  ticketCount: number;
}

/** Table the ticket is on; the name is a snapshot (tables can be renamed later). */
export interface TableRef {
  id: string;
  name: string;
}

export interface ProjectionProblem {
  eventId: string;
  reason: string;
}

type Payload = Record<string, unknown>;

class BadPayload extends Error {}

const str = (p: Payload, k: string): string => {
  const v = p[k];
  if (typeof v !== 'string' || v.length === 0) throw new BadPayload(`payload.${k} must be a non-empty string`);
  return v;
};
const int = (p: Payload, k: string, fallback?: number): number => {
  const v = p[k] ?? fallback;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new BadPayload(`payload.${k} must be an integer`);
  return v;
};
const optStr = (p: Payload, k: string): string | null => (typeof p[k] === 'string' ? (p[k] as string) : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (p: Payload, k: string): string => {
  const v = str(p, k);
  if (!UUID.test(v)) throw new BadPayload(`payload.${k} must be a uuid`);
  return v;
};
/** tableId + tableName, both or none. */
const tableRef = (p: Payload): TableRef | null => {
  if (p.tableId === undefined || p.tableId === null) return null;
  const id = str(p, 'tableId');
  if (!UUID.test(id)) throw new BadPayload('payload.tableId must be a uuid');
  return { id, name: str(p, 'tableName') };
};

/** Events must be from one device, in deviceSeq order. Unknown event types are ignored (not an error). */
export function projectEvents(events: SyncEvent[]): { ops: ProjectionOp[]; problems: ProjectionProblem[] } {
  const ops: ProjectionOp[] = [];
  const problems: ProjectionProblem[] = [];

  for (const e of events) {
    const p = e.payload as Payload;
    const at = new Date(e.occurredAt);
    try {
      switch (e.type) {
        case 'order.opened':
          ops.push({
            kind: 'openOrder',
            orderId: e.entityId,
            type: optStr(p, 'type') ?? 'takeaway',
            openedAt: at,
            table: tableRef(p),
          });
          break;

        case 'order.table_changed':
          // Ticket moved to another table (or from the counter to a table).
          ops.push({ kind: 'moveTable', orderId: e.entityId, table: tableRef(p) });
          break;

        case 'order.item_added': {
          const modifiers = Array.isArray(p.modifiers) ? p.modifiers : [];
          const modifiersPrice = modifiers.reduce<number>(
            (sum, m) => sum + (typeof (m as Payload)?.extraPrice === 'number' ? ((m as Payload).extraPrice as number) : 0),
            0,
          );
          ops.push({
            kind: 'addLine',
            orderId: e.entityId,
            line: {
              id: str(p, 'lineId'),
              productId: str(p, 'productId'),
              name: str(p, 'name'),
              unitPrice: int(p, 'unitPrice'),
              modifiersPrice,
              modifiers,
              qty: int(p, 'qty'),
              vatRateBp: int(p, 'vatRateBp'),
            },
          });
          break;
        }

        case 'order.item_updated':
          ops.push({ kind: 'setLineQty', lineId: str(p, 'lineId'), qty: int(p, 'qty') });
          break;

        case 'order.item_voided':
          ops.push({ kind: 'voidLine', lineId: str(p, 'lineId') });
          break;

        case 'order.item_discounted': {
          // One or several lines (a whole-ticket discount is sent line by line). type null = removed.
          if (!Array.isArray(p.lines) || p.lines.length === 0) throw new BadPayload('payload.lines must be a non-empty array');
          const lines = (p.lines as Payload[]).map((l) => {
            const type = l.type ?? null;
            if (type !== null && type !== 'free' && type !== 'percent' && type !== 'amount') {
              throw new BadPayload('payload.lines[].type must be free, percent, amount or null');
            }
            return { lineId: str(l, 'lineId'), type: type as 'free' | 'percent' | 'amount' | null, value: int(l, 'value', 0) };
          });
          ops.push({ kind: 'discountLines', reason: optStr(p, 'reason'), approvedBy: e.approvedBy ?? null, lines });
          break;
        }

        case 'payment.added':
          ops.push({
            kind: 'payment',
            orderId: e.entityId,
            payment: {
              id: str(p, 'paymentId'),
              method: str(p, 'method'),
              amount: int(p, 'amount'),
              tendered: int(p, 'tendered', 0),
              changeGiven: int(p, 'change', 0),
              createdAt: at,
            },
          });
          break;

        case 'order.closed':
          ops.push({
            kind: 'closeOrder',
            orderId: e.entityId,
            closedAt: at,
            total: int(p, 'total'),
            itemCount: int(p, 'itemCount', 0),
            receiptNumber: optStr(p, 'receiptNumber'),
          });
          break;

        case 'order.cancelled':
          ops.push({ kind: 'cancelOrder', orderId: e.entityId, closedAt: at });
          break;

        case 'cash_session.opened':
          ops.push({
            kind: 'openCashSession',
            sessionId: e.entityId,
            drawerId: uuid(p, 'drawerId'),
            openingFloat: int(p, 'openingFloat'),
            openedAt: at,
            staffId: e.staffId ?? null,
          });
          break;

        case 'cash.moved': {
          const type = str(p, 'type');
          if (type !== 'in' && type !== 'out') throw new BadPayload('payload.type must be in or out');
          ops.push({
            kind: 'cashMovement',
            sessionId: e.entityId,
            movement: {
              id: uuid(p, 'movementId'),
              type,
              amount: int(p, 'amount'),
              reason: str(p, 'reason'),
              staffId: e.staffId ?? null,
              createdAt: at,
            },
          });
          break;
        }

        case 'cash_session.closed':
          ops.push({
            kind: 'closeCashSession',
            sessionId: e.entityId,
            closedAt: at,
            staffId: e.staffId ?? null,
            note: optStr(p, 'note'),
            totals: {
              countedCash: int(p, 'countedCash'),
              expectedCash: int(p, 'expectedCash'),
              difference: int(p, 'difference'),
              cashSales: int(p, 'cashSales', 0),
              cardSales: int(p, 'cardSales', 0),
              cashIn: int(p, 'cashIn', 0),
              cashOut: int(p, 'cashOut', 0),
              ticketCount: int(p, 'ticketCount', 0),
            },
          });
          break;

        default:
          // e.g. debug.test, staff.logged_in — stored as events, no sales effect.
          break;
      }
    } catch (err) {
      if (!(err instanceof BadPayload)) throw err;
      problems.push({ eventId: e.id, reason: `${e.type}: ${err.message}` });
    }
  }
  return { ops, problems };
}
