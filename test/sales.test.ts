import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import type { buildApp } from '../src/app.js';
import { projectEvents } from '../src/modules/sales/sales.projection.js';
import { dayRange, todayInTunis } from '../src/modules/sales/sales.service.js';
import type { SyncEvent } from '../src/modules/sync/sync.schema.js';
import { splitVat, vatBreakdown } from '../src/shared/money.js';
import { buildTestApp, fakeRepos, publicKey, type FakeSyncRepo } from './fakes.js';

type App = Awaited<ReturnType<typeof buildApp>>;

/** Builds events exactly like the Flutter POS OrderRepository does. */
class PosSimulator {
  seq = 0;
  constructor(
    readonly deviceId: string,
    readonly branchId: string,
  ) {}

  private ev(type: string, entityId: string, payload: Record<string, unknown>, at = new Date()): SyncEvent {
    return { id: v7(), type, version: 1, branchId: this.branchId, deviceId: this.deviceId, entityId, deviceSeq: ++this.seq, occurredAt: at.toISOString(), payload };
  }
  open(orderId: string) {
    return this.ev('order.opened', orderId, { type: 'takeaway' });
  }
  add(orderId: string, lineId: string, name: string, unitPrice: number, opts: { vat?: number; modifiers?: { id: string; name: string; extraPrice: number }[]; productId?: string } = {}) {
    return this.ev('order.item_added', orderId, {
      lineId,
      productId: opts.productId ?? `prod-${name}`,
      name,
      unitPrice,
      qty: 1,
      vatRateBp: opts.vat ?? 1900,
      station: 'bar',
      modifiers: opts.modifiers ?? [],
    });
  }
  qty(orderId: string, lineId: string, qty: number) {
    return this.ev('order.item_updated', orderId, { lineId, qty });
  }
  void(orderId: string, lineId: string) {
    return this.ev('order.item_voided', orderId, { lineId, reason: 'removed_before_send' });
  }
  payCash(orderId: string, amount: number, tendered: number, receiptNumber: string, itemCount: number) {
    return [
      this.ev('payment.added', orderId, { paymentId: v7(), method: 'cash', amount, tendered, change: tendered - amount }),
      this.ev('order.closed', orderId, { receiptNumber, total: amount, itemCount, vat: [] }),
    ];
  }
  cancel(orderId: string) {
    return this.ev('order.cancelled', orderId, { reason: 'cancelled_by_staff' });
  }
}

describe('sales', () => {
  let app: App;
  let sync: FakeSyncRepo;
  let owner: { token: string; branchId: string };
  let pos: { token: string; deviceId: string };
  let sim: PosSimulator;

  beforeEach(async () => {
    const f = fakeRepos();
    sync = f.sync;
    app = await buildTestApp(f.repos);
    const s = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'owner@example.com', password: 'correct horse battery', name: 'Owner', businessName: 'Café' },
      })
    ).json();
    owner = { token: s.accessToken, branchId: s.branches[0].id };
    const { code } = (
      await app.inject({
        method: 'POST',
        url: `/v1/owner/branches/${owner.branchId}/pairing-codes`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { role: 'hub' },
      })
    ).json();
    pos = (await app.inject({ method: 'POST', url: '/v1/devices/pair', payload: { code, name: 'Caisse', publicKey } })).json();
    sim = new PosSimulator(pos.deviceId, owner.branchId);
  });
  afterEach(() => app.close());

  const push = (events: SyncEvent[]) =>
    app.inject({ method: 'POST', url: '/v1/sync/push', headers: { authorization: `Device ${pos.token}` }, payload: { events } });
  const get = (url: string, token = owner.token) => app.inject({ url, headers: { authorization: `Bearer ${token}` } });

  /** A realistic café morning on one POS. */
  async function sellSomeOrders() {
    const [o1, o2, o3, o4] = [v7(), v7(), v7(), v7()];
    const l = () => v7();
    const e1 = l(), e2 = l(), e3 = l(), e4 = l(), e5 = l(), e6 = l();
    const shot = { id: 'm-shot', name: 'Extra shot', extraPrice: 500 };
    await push([
      // Order 1: 2 × Express + 1 Croissant (7 %), pays 5 DT → 3.900
      sim.open(o1),
      sim.add(o1, e1, 'Express', 1200),
      sim.qty(o1, e1, 2),
      sim.add(o1, e2, 'Croissant', 1500, { vat: 700 }),
      ...sim.payCash(o1, 3900, 5000, 'T1-000001', 3),
      // Order 2: Cappuccino + extra shot, a Thé added then removed → 4.000
      sim.open(o2),
      sim.add(o2, e3, 'Cappuccino', 3500, { modifiers: [shot] }),
      sim.add(o2, e4, 'Thé', 1800),
      sim.void(o2, e4),
      ...sim.payCash(o2, 4000, 4000, 'T1-000002', 1),
      // Order 3: cancelled
      sim.open(o3),
      sim.add(o3, e5, 'Express', 1200),
      sim.cancel(o3),
      // Order 4: still open on the POS
      sim.open(o4),
      sim.add(o4, e6, 'Express', 1200),
    ]);
    return { o1, o2, o3, o4 };
  }

  it("today's summary: revenue, tickets, payments, top products, VAT", async () => {
    await sellSomeOrders();
    const res = await get(`/v1/owner/branches/${owner.branchId}/sales/summary`);
    expect(res.statusCode).toBe(200);
    const s = res.json();

    expect(s.date).toBe(todayInTunis(new Date()));
    expect(s.revenue).toBe(3900 + 4000);
    expect(s.ticketCount).toBe(2);
    expect(s.averageTicket).toBe(3950);
    expect(s.itemCount).toBe(4);
    expect(s.cancelledCount).toBe(1);
    expect(s.openCount).toBe(1);
    expect(s.byPaymentMethod).toEqual([{ method: 'cash', amount: 7900, count: 2 }]);
    expect(s.byHour).toHaveLength(1);
    expect(s.byHour[0].tickets).toBe(2);

    // Removed Thé and cancelled/open orders don't count.
    expect(s.topProducts).toEqual([
      { productId: 'prod-Cappuccino', name: 'Cappuccino', qty: 1, revenue: 4000 },
      { productId: 'prod-Express', name: 'Express', qty: 2, revenue: 2400 },
      { productId: 'prod-Croissant', name: 'Croissant', qty: 1, revenue: 1500 },
    ]);
    // VAT: 19 % on 2400 + 4000, 7 % on 1500
    expect(s.vat).toEqual([splitVat(1900, 6400), splitVat(700, 1500)]);
  });

  it('orders list: newest first, filter by status', async () => {
    const { o1, o2, o3, o4 } = await sellSomeOrders();
    const all = (await get(`/v1/owner/branches/${owner.branchId}/sales/orders`)).json();
    expect(all.map((o: { id: string }) => o.id)).toEqual([o4, o3, o2, o1]);
    expect(all[3]).toMatchObject({ status: 'paid', receiptNumber: 'T1-000001', total: 3900, paymentMethod: 'cash', deviceCode: 'T1' });

    const paid = (await get(`/v1/owner/branches/${owner.branchId}/sales/orders?status=paid`)).json();
    expect(paid.map((o: { receiptNumber: string }) => o.receiptNumber)).toEqual(['T1-000002', 'T1-000001']);
  });

  it('order detail shows removed lines (for control) but they are not counted', async () => {
    const { o2 } = await sellSomeOrders();
    const d = (await get(`/v1/owner/orders/${o2}`)).json();
    expect(d.receiptNumber).toBe('T1-000002');
    expect(d.lines.map((l: { name: string; voided: boolean; total: number }) => [l.name, l.voided, l.total])).toEqual([
      ['Cappuccino', false, 4000],
      ['Thé', true, 0],
    ]);
    expect(d.payments).toEqual([{ method: 'cash', amount: 4000, tendered: 4000, changeGiven: 0 }]);
    expect(d.vat).toEqual([splitVat(1900, 4000)]);
  });

  it('a retried push does not count sales twice', async () => {
    const o = v7();
    const batch = [sim.open(o), sim.add(o, v7(), 'Express', 1200), ...sim.payCash(o, 1200, 1200, 'T1-000001', 1)];
    await push(batch);
    await push(batch); // network retry
    const s = (await get(`/v1/owner/branches/${owner.branchId}/sales/summary`)).json();
    expect(s.ticketCount).toBe(1);
    expect(s.revenue).toBe(1200);
  });

  it('another day is empty; another owner gets 404', async () => {
    const { o1 } = await sellSomeOrders();
    const yesterday = (await get(`/v1/owner/branches/${owner.branchId}/sales/summary?date=2020-01-01`)).json();
    expect(yesterday).toMatchObject({ revenue: 0, ticketCount: 0, averageTicket: 0, topProducts: [], vat: [] });

    const other = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'other@example.com', password: 'correct horse battery', name: 'O', businessName: 'Other' },
      })
    ).json();
    expect((await get(`/v1/owner/branches/${owner.branchId}/sales/summary`, other.accessToken)).statusCode).toBe(404);
    expect((await get(`/v1/owner/orders/${o1}`, other.accessToken)).json().error.code).toBe('ORDER_NOT_FOUND');
  });

  it('a broken event payload is recorded, not fatal', async () => {
    const o = v7();
    const bad = { ...sim.open(o), type: 'order.item_added', payload: { lineId: v7() } }; // missing fields
    const res = (await push([sim.open(o), bad])).json();
    expect(res.accepted).toHaveLength(2);
    expect(sync.errors.map((e) => e.code)).toContain('PROJECTION_SKIPPED');
  });
});

describe('projection (pure)', () => {
  it('ignores unknown event types and reports bad payloads', () => {
    const base = { version: 1, branchId: v7(), deviceId: v7(), occurredAt: new Date().toISOString() };
    const { ops, problems } = projectEvents([
      { ...base, id: v7(), type: 'debug.test', entityId: v7(), deviceSeq: 1, payload: {} },
      { ...base, id: 'bad', type: 'payment.added', entityId: v7(), deviceSeq: 2, payload: { method: 'cash' } },
    ]);
    expect(ops).toEqual([]);
    expect(problems).toEqual([{ eventId: 'bad', reason: expect.stringContaining('paymentId') }]);
  });
});

describe('Tunisia day range', () => {
  it('a day is 00:00 → 24:00 Tunisia time (UTC+1)', () => {
    const { from, to } = dayRange('2026-11-18');
    expect(from.toISOString()).toBe('2026-11-17T23:00:00.000Z');
    expect(to.toISOString()).toBe('2026-11-18T23:00:00.000Z');
  });
  it('23:30 UTC is already the next day in Tunis', () => {
    expect(todayInTunis(new Date('2026-11-18T23:30:00Z'))).toBe('2026-11-19');
  });
});

describe('money (same vectors as the POS)', () => {
  it.each([
    [4500, 1900, 3782, 718],
    [2400, 1900, 2017, 383],
    [3500, 700, 3271, 229],
    [10000, 1300, 8850, 1150],
    [0, 1900, 0, 0],
    [-4500, 1900, -3782, -718],
  ])('%i @ %ibp → HT %i, VAT %i', (ttc, bp, ht, vat) => {
    expect(splitVat(bp, ttc)).toEqual({ rateBp: bp, ttc, ht, vat });
  });
  it('breakdown per rate on summed TTC', () => {
    expect(
      vatBreakdown([
        { rateBp: 1900, ttc: 4500 },
        { rateBp: 1900, ttc: 2400 },
        { rateBp: 700, ttc: 3500 },
      ]),
    ).toEqual([
      { rateBp: 1900, ttc: 6900, ht: 5798, vat: 1102 },
      { rateBp: 700, ttc: 3500, ht: 3271, vat: 229 },
    ]);
  });
});
