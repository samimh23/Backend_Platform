/**
 * Money helpers — amounts are integer **millimes** (1 DT = 1000).
 * Must give exactly the same results as the POS (Pos_Cafe: lib/core/money). Same test vectors.
 */

/** Integer division rounded half away from zero. */
export function roundDiv(numerator: number, denominator: number): number {
  if (denominator === 0) throw new Error('Division by zero');
  const negative = numerator < 0 !== denominator < 0;
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const q = Math.floor((n * 2 + d) / (d * 2));
  return negative ? -q : q;
}

/** free | percent (value in basis points: 1000 = 10 %) | amount (value in millimes, per line). */
export type DiscountType = 'free' | 'percent' | 'amount';

/**
 * Discount of a line, from its gross total (price × qty). Same formula as the POS
 * (lib/core/money/order_totals.dart, same test vectors): never more than the line.
 */
export function discountOf(gross: number, type: string | null | undefined, value: number): number {
  switch (type) {
    case 'free':
      return gross;
    case 'percent':
      return Math.min(gross, roundDiv(gross * Math.max(0, Math.min(value, 10000)), 10000));
    case 'amount':
      return Math.min(gross, Math.max(0, value));
    default:
      return 0;
  }
}

export interface VatSplit {
  rateBp: number;
  ttc: number;
  ht: number;
  vat: number;
}

/** TTC → HT + VAT. ht = round(ttc × 10000 / (10000 + rate)). */
export function splitVat(rateBp: number, ttc: number): VatSplit {
  const ht = roundDiv(ttc * 10000, 10000 + rateBp);
  return { rateBp, ttc, ht, vat: ttc - ht };
}

/** One split per rate on the summed TTC, highest rate first. */
export function vatBreakdown(lines: { rateBp: number; ttc: number }[]): VatSplit[] {
  const totals = new Map<number, number>();
  for (const l of lines) totals.set(l.rateBp, (totals.get(l.rateBp) ?? 0) + l.ttc);
  return [...totals.entries()].sort(([a], [b]) => b - a).map(([rate, ttc]) => splitVat(rate, ttc));
}
