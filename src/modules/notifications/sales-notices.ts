import type { ProjectionOp } from '../sales/sales.projection.js';
import type { NewNotification } from './notifications.js';

/** What the owner is told when the POS syncs something worth a look. */

const REASON: Record<string, string> = {
  changed_mind: 'le client a changé d’avis',
  error: 'erreur de saisie',
  quality: 'problème de qualité',
  other: 'autre',
};
const reason = (r: string | null) => (r ? (REASON[r] ?? r) : 'sans motif');

/** 12500 → "12.500 DT" */
export const dt = (millimes: number) => {
  const abs = Math.abs(millimes);
  return `${millimes < 0 ? '-' : ''}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, '0')} DT`;
};

/** 1250 g → "1,25 kg", 150 ml → "150 ml", 3 → "3 pièces". */
export function qty(q: number, unit: 'g' | 'ml' | 'piece') {
  const fr = (n: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 }).format(n);
  if (unit === 'g') return Math.abs(q) >= 1000 ? `${fr(q / 1000)} kg` : `${fr(q)} g`;
  if (unit === 'ml') return Math.abs(q) >= 1000 ? `${fr(q / 1000)} L` : `${fr(q)} ml`;
  return `${fr(q)} pièce${Math.abs(q) > 1 ? 's' : ''}`;
}

/** Reads what the notices need (names, receipt numbers) — from the db or a fake. */
export interface NoticeLookup {
  line(lineId: string): Promise<{ name: string; qty: number; orderId: string; receiptNumber: string | null } | null>;
  receiptNumber(orderId: string): Promise<string | null>;
  drawerCode(sessionId: string): Promise<string | null>;
}

export async function ownerNotices(ops: ProjectionOp[], branchId: string, look: NoticeLookup): Promise<NewNotification[]> {
  const out: NewNotification[] = [];
  for (const op of ops) {
    if (op.kind === 'voidLine' && op.why) {
      // Taken back after "Envoyer" (a manager approved it).
      const l = await look.line(op.lineId);
      if (!l) continue;
      out.push({
        kind: 'void_after_send',
        branchId,
        title: 'Article annulé après envoi',
        body: `${l.qty} × ${l.name}${l.receiptNumber ? ` · ticket ${l.receiptNumber}` : ''} · ${reason(op.why)}`,
        link: `/owner/sales/${l.orderId}`,
        dedupeKey: `void:${op.lineId}`,
      });
    } else if (op.kind === 'refundOrder') {
      const n = await look.receiptNumber(op.orderId);
      const amount = -op.payments.reduce((s, p) => s + p.amount, 0);
      out.push({
        kind: 'refund',
        branchId,
        title: 'Ticket remboursé',
        body: `${n ? `Ticket ${n} · ` : ''}${dt(amount)} · ${reason(op.reason)}`,
        link: `/owner/sales/${op.orderId}`,
        dedupeKey: `refund:${op.orderId}`,
      });
    } else if (op.kind === 'closeCashSession' && op.totals.difference !== 0) {
      const code = await look.drawerCode(op.sessionId);
      out.push({
        kind: 'cash_gap',
        branchId,
        title: op.totals.difference < 0 ? 'Il manque de l’argent en caisse' : 'Trop d’argent en caisse',
        body: `Écart de ${dt(op.totals.difference)} à la clôture${code ? ` de ${code}` : ''}`,
        link: `/owner/cash/${op.sessionId}`,
        dedupeKey: `cash:${op.sessionId}`,
      });
    }
  }
  return out;
}

/** An ingredient just went at or under its alert level (once per item per day). */
export const stockLowNotice = (
  i: { id: string; name: string; quantity: number; lowThreshold: number; unit: 'g' | 'ml' | 'piece' },
  branchId: string,
  day: string,
): NewNotification => ({
  kind: 'stock_low',
  branchId,
  title: `Stock bas : ${i.name}`,
  body: `Il reste ${qty(i.quantity, i.unit)} (alerte à ${qty(i.lowThreshold, i.unit)})`,
  link: '/owner/stock',
  dedupeKey: `stock-low:${i.id}:${day}`,
});
