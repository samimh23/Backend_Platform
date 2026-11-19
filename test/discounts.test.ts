import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import type { buildApp } from '../src/app.js';
import type { SyncEvent } from '../src/modules/sync/sync.schema.js';
import { discountOf } from '../src/shared/money.js';
import { buildTestApp, fakeRepos, publicKey, type FakeSyncRepo } from './fakes.js';

type App = Awaited<ReturnType<typeof buildApp>>;

/** Shared test vectors — the Dart POS (test/core/discount_test.dart) must give the same results. */
export const DISCOUNT_VECTORS: [gross: number, type: string | null, value: number, discount: number][] = [
  [2400, 'free', 0, 2400],
  [3500, 'percent', 1000, 350],
  [1250, 'percent', 1500, 188], // 187.5 → 188 (half away from zero)
  [1000, 'percent', 3333, 333],
  [1000, 'percent', 20000, 1000], // never more than the line
  [1200, 'amount', 500, 500],
  [1200, 'amount', 5000, 1200],
  [1200, 'amount', -50, 0],
  [1200, null, 900, 0],
];

describe('discountOf (shared with the POS)', () => {
  it.each(DISCOUNT_VECTORS)('%i, %s %i → %i', (gross, type, value, discount) =>
    expect(discountOf(gross, type, value)).toBe(discount),
  );
});

describe('discounts from the POS', () => {
  let app: App;
  let sync: FakeSyncRepo;
  let owner: { token: string; branchId: string };
  let pos: { token: string; deviceId: string };
  let manager: string;
  let seq = 0;

  beforeEach(async () => {
    const f = fakeRepos();
    sync = f.sync;
    app = await buildTestApp(f.repos);
    const s = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'o@example.com', password: 'correct horse battery', name: 'Owner', businessName: 'Café' },
      })
    ).json();
    owner = { token: s.accessToken, branchId: s.branches[0].id };
    const auth = { authorization: `Bearer ${owner.token}` };
    const { code } = (
      await app.inject({ method: 'POST', url: `/v1/owner/branches/${owner.branchId}/pairing-codes`, headers: auth, payload: { role: 'hub' } })
    ).json();
    pos = (await app.inject({ method: 'POST', url: '/v1/devices/pair', payload: { code, name: 'Caisse', publicKey } })).json();
    manager = (
      await app.inject({
        method: 'POST',
        url: `/v1/owner/branches/${owner.branchId}/staff`,
        headers: auth,
        payload: { name: 'Sonia', role: 'manager', pin: '2580' },
      })
    ).json().id;
    seq = 0;
  });
  afterEach(() => app.close());

  const ev = (type: string, entityId: string, payload: Record<string, unknown>, approvedBy?: string): SyncEvent => ({
    id: v7(),
    type,
    version: 1,
    branchId: owner.branchId,
    deviceId: pos.deviceId,
    entityId,
    deviceSeq: ++seq,
    occurredAt: new Date().toISOString(),
    approvedBy: approvedBy ?? null,
    payload,
  });
  const push = (events: SyncEvent[]) =>
    app.inject({ method: 'POST', url: '/v1/sync/push', headers: { authorization: `Device ${pos.token}` }, payload: { events } });
  const get = (url: string) => app.inject({ url, headers: { authorization: `Bearer ${owner.token}` } }).then((r) => r.json());

  it('an offered coffee and 10 % off a cappuccino: totals, VAT, ticket detail and the day’s "Remises & offerts"', async () => {
    const order = v7();
    const [express, cappuccino] = [v7(), v7()];
    const add = (lineId: string, name: string, unitPrice: number, qty = 1) =>
      ev('order.item_added', order, { lineId, productId: name, name, unitPrice, qty, vatRateBp: 1900, modifiers: [] });
    await push([
      ev('order.opened', order, { type: 'takeaway' }),
      add(express, 'Express', 1200, 2),
      add(cappuccino, 'Cappuccino', 3500),
      ev('order.item_discounted', order, { reason: 'geste', lines: [{ lineId: express, type: 'free', value: 0 }] }, manager),
      ev('order.item_discounted', order, { reason: 'staff', lines: [{ lineId: cappuccino, type: 'percent', value: 1000 }] }, manager),
      // 2 Express offered (2.400) + Cappuccino 3.500 − 0.350 = 3.150
      ev('payment.added', order, { paymentId: v7(), method: 'cash', amount: 3150, tendered: 5000, change: 1850 }),
      ev('order.closed', order, { receiptNumber: 'T1-000001', total: 3150, itemCount: 3, vat: [] }),
    ]);
    expect(sync.errors).toEqual([]);

    const detail = await get(`/v1/owner/orders/${order}`);
    expect(detail.lines.map((l: { name: string; discount: number; discountType: string; discountReason: string; total: number }) => [l.name, l.discount, l.discountType, l.discountReason, l.total])).toEqual([
      ['Express', 2400, 'free', 'geste', 0],
      ['Cappuccino', 350, 'percent', 'staff', 3150],
    ]);
    expect(detail.vat).toEqual([{ rateBp: 1900, ttc: 3150, ht: 2647, vat: 503 }]);

    const summary = await get(`/v1/owner/branches/${owner.branchId}/sales/summary`);
    expect(summary.revenue).toBe(3150);
    expect(summary.discounts).toEqual({ amount: 2750, lines: 2, freeItems: 2 });
    expect(summary.topProducts.find((p: { name: string }) => p.name === 'Express').revenue).toBe(0);
  });

  it('removing a discount (type null) gives the full price back', async () => {
    const order = v7();
    const line = v7();
    await push([
      ev('order.opened', order, { type: 'takeaway' }),
      ev('order.item_added', order, { lineId: line, productId: 'p', name: 'Jus', unitPrice: 4000, qty: 1, vatRateBp: 1900, modifiers: [] }),
      ev('order.item_discounted', order, { reason: 'error', lines: [{ lineId: line, type: 'amount', value: 1000 }] }, manager),
      ev('order.item_discounted', order, { reason: null, lines: [{ lineId: line, type: null, value: 0 }] }),
    ]);
    const detail = await get(`/v1/owner/orders/${order}`);
    expect(detail.lines[0]).toMatchObject({ discount: 0, discountType: null, discountReason: null, total: 4000 });
  });

  it('a malformed discount event is a problem, not a crash', async () => {
    const order = v7();
    await push([
      ev('order.opened', order, { type: 'takeaway' }),
      ev('order.item_discounted', order, { reason: 'x', lines: [{ lineId: v7(), type: 'half', value: 1 }] }),
      ev('order.item_discounted', order, { reason: 'x', lines: [] }),
    ]);
    expect(sync.errors.map((e) => e.code)).toEqual(['PROJECTION_SKIPPED', 'PROJECTION_SKIPPED']);
  });
});
