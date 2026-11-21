import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import type { buildApp } from '../src/app.js';
import type { SyncEvent } from '../src/modules/sync/sync.schema.js';
import { TokenService } from '../src/shared/tokens.js';
import { buildTestApp, fakeRepos, publicKey, testAuthConfig, type FakeAuthRepo } from './fakes.js';

type App = Awaited<ReturnType<typeof buildApp>>;

describe('stock', () => {
  let app: App;
  let auth: FakeAuthRepo;
  let owner: { token: string; branchId: string };
  let pos: { token: string; deviceId: string };
  let product: Record<string, string>;
  let seq = 0;

  const req = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object, token = owner.token) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload && { payload }) });
  const createItem = async (body: object) => (await req('POST', `/v1/owner/branches/${owner.branchId}/stock/items`, body)).json();
  const stock = async () => (await req('GET', `/v1/owner/branches/${owner.branchId}/stock`)).json();
  const qty = async (name: string) => (await stock()).items.find((i: { name: string }) => i.name === name).quantity;

  const ev = (type: string, entityId: string, payload: Record<string, unknown>): SyncEvent => ({
    id: v7(),
    type,
    version: 1,
    branchId: owner.branchId,
    deviceId: pos.deviceId,
    entityId,
    deviceSeq: ++seq,
    occurredAt: new Date().toISOString(),
    payload,
  });
  const push = (events: SyncEvent[]) =>
    app.inject({ method: 'POST', url: '/v1/sync/push', headers: { authorization: `Device ${pos.token}` }, payload: { events } });

  /** A ticket synced from the POS: items = [product name, qty, voided?]. */
  function ticket(items: [string, number, boolean?][], close: 'paid' | 'cancelled' = 'paid') {
    const orderId = v7();
    const events = [ev('order.opened', orderId, { type: 'takeaway' })];
    for (const [name, q, voided] of items) {
      const lineId = v7();
      events.push(ev('order.item_added', orderId, { lineId, productId: product[name], name, unitPrice: 1000, qty: q, vatRateBp: 1900, modifiers: [] }));
      if (voided) events.push(ev('order.item_voided', orderId, { lineId, reason: 'removed_before_send' }));
    }
    if (close === 'paid') {
      events.push(ev('payment.added', orderId, { paymentId: v7(), method: 'card', amount: 1000, tendered: 1000, change: 0 }));
      events.push(ev('order.closed', orderId, { receiptNumber: `T1-${seq}`, total: 1000, itemCount: 1, vat: [] }));
    } else {
      events.push(ev('order.cancelled', orderId, { reason: 'cancelled_by_staff' }));
    }
    return events;
  }

  beforeEach(async () => {
    const f = fakeRepos();
    auth = f.auth;
    app = await buildTestApp(f.repos);
    const s = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'o@example.com', password: 'correct horse battery', name: 'Owner', businessName: 'Café' },
      })
    ).json();
    owner = { token: s.accessToken, branchId: s.branches[0].id };
    const cat = (await req('POST', `/v1/owner/branches/${owner.branchId}/categories`, { name: 'Café' })).json();
    product = {};
    for (const name of ['Express', 'Cappuccino', 'Eau']) {
      product[name] = (
        await req('POST', `/v1/owner/branches/${owner.branchId}/products`, { name, price: 1000, categoryId: cat.id })
      ).json().id;
    }
    const { code } = (await req('POST', `/v1/owner/branches/${owner.branchId}/pairing-codes`, { role: 'hub' })).json();
    pos = (await app.inject({ method: 'POST', url: '/v1/devices/pair', payload: { code, name: 'Caisse', publicKey } })).json();
    seq = 0;
  });
  afterEach(() => app.close());

  it('paid tickets take their ingredients out (recipes × quantities); cancelled items and tickets do not; once only', async () => {
    const coffee = await createItem({ name: 'Café en grains', unit: 'g', quantity: 1000, lowThreshold: 200 });
    const milk = await createItem({ name: 'Lait', unit: 'ml', quantity: 6000 });
    expect(coffee).toMatchObject({ quantity: 1000, low: false, lowThreshold: 200 });

    await req('PUT', `/v1/owner/products/${product.Express}/recipe`, { lines: [{ stockItemId: coffee.id, qty: 8 }] });
    const r = await req('PUT', `/v1/owner/products/${product.Cappuccino}/recipe`, {
      lines: [
        { stockItemId: coffee.id, qty: 8 },
        { stockItemId: milk.id, qty: 150 },
      ],
    });
    expect(r.statusCode).toBe(200);
    expect((await stock()).recipes).toHaveLength(2);

    // 2 Cappuccino + 1 Express (+ 1 Express removed) + water (no recipe).
    const paid = ticket([
      ['Cappuccino', 2],
      ['Express', 1],
      ['Express', 1, true],
      ['Eau', 3],
    ]);
    await push(paid);
    expect(await qty('Café en grains')).toBe(1000 - 3 * 8);
    expect(await qty('Lait')).toBe(6000 - 2 * 150);

    await push(ticket([['Cappuccino', 5]], 'cancelled'));
    expect(await qty('Lait')).toBe(5700);

    // The POS sends the same events again (bad network): nothing changes.
    await push(paid);
    expect(await qty('Café en grains')).toBe(976);

    const history = (await req('GET', `/v1/owner/stock/items/${coffee.id}/movements`)).json();
    expect(history.map((m: { kind: string; delta: number; quantityAfter: number }) => [m.kind, m.delta, m.quantityAfter])).toEqual([
      ['sale', -24, 976],
      ['count', 1000, 1000],
    ]);
  });

  it('delivery, loss and count; the low-stock alert; managers can do it too', async () => {
    const croissants = await createItem({ name: 'Croissants', unit: 'piece', lowThreshold: 10 });
    expect(croissants).toMatchObject({ quantity: 0, low: true });
    const move = (body: object, token?: string) => req('POST', `/v1/owner/stock/items/${croissants.id}/movements`, body, token);

    expect((await move({ kind: 'delivery', quantity: 40, note: 'Boulangerie' })).json()).toMatchObject({ quantity: 40, low: false });
    expect((await move({ kind: 'waste', quantity: 5, note: 'Invendus' })).json().quantity).toBe(35);
    const o = auth.users[0]!;
    const manager = new TokenService(testAuthConfig.jwtSecret, 900).signAccess({ sub: o.id, tenantId: o.tenantId, role: 'manager' });
    expect((await move({ kind: 'count', quantity: 8 }, manager)).json()).toMatchObject({ quantity: 8, low: true });

    const history = (await req('GET', `/v1/owner/stock/items/${croissants.id}/movements`)).json();
    expect(history.map((m: { kind: string; delta: number; note: string | null }) => [m.kind, m.delta, m.note])).toEqual([
      ['count', -27, null],
      ['waste', -5, 'Invendus'],
      ['delivery', 40, 'Boulangerie'],
    ]);

    const renamed = (await req('PATCH', `/v1/owner/stock/items/${croissants.id}`, { name: ' Croissants beurre ', lowThreshold: null })).json();
    expect(renamed).toMatchObject({ name: 'Croissants beurre', low: false });
    expect((await req('PATCH', `/v1/owner/stock/items/${croissants.id}`, { name: '  ' })).statusCode).toBe(400);
    expect((await move({ kind: 'waste', quantity: -3 })).statusCode).toBe(400);
  });

  it('recipes only use this café’s ingredients; another business sees nothing', async () => {
    const coffee = await createItem({ name: 'Café', unit: 'g' });
    const dup = await req('PUT', `/v1/owner/products/${product.Express}/recipe`, {
      lines: [
        { stockItemId: coffee.id, qty: 8 },
        { stockItemId: coffee.id, qty: 2 },
      ],
    });
    expect(dup.json().error.code).toBe('INVALID_RECIPE');

    const other = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'x@example.com', password: 'correct horse battery', name: 'X', businessName: 'Autre' },
      })
    ).json();
    const theirs = (
      await req('POST', `/v1/owner/branches/${other.branches[0].id}/stock/items`, { name: 'Leur café', unit: 'g' }, other.accessToken)
    ).json();
    const foreign = await req('PUT', `/v1/owner/products/${product.Express}/recipe`, { lines: [{ stockItemId: theirs.id, qty: 8 }] });
    expect(foreign.json().error.code).toBe('INVALID_RECIPE');

    expect((await req('GET', `/v1/owner/branches/${owner.branchId}/stock`, undefined, other.accessToken)).statusCode).toBe(404);
    expect((await req('GET', `/v1/owner/stock/items/${coffee.id}/movements`, undefined, other.accessToken)).statusCode).toBe(404);
    expect(
      (await req('PUT', `/v1/owner/products/${product.Express}/recipe`, { lines: [] }, other.accessToken)).statusCode,
    ).toBe(404);
    // Empty recipe = the product uses nothing.
    expect((await req('PUT', `/v1/owner/products/${product.Express}/recipe`, { lines: [] })).json()).toEqual({ productId: product.Express, lines: [] });
  });
});
