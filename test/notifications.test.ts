import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import type { buildApp } from '../src/app.js';
import { ClubService } from '../src/modules/loyalty/club.js';
import { NotificationsService } from '../src/modules/notifications/notifications.js';
import type { SyncEvent } from '../src/modules/sync/sync.schema.js';
import { TokenService } from '../src/shared/tokens.js';
import { buildTestApp, fakeRepos, testAuthConfig } from './fakes.js';

type App = Awaited<ReturnType<typeof buildApp>>;
type Fakes = ReturnType<typeof fakeRepos>;

/** The 🔔: what the owner and the client are told, once, and only them. */
describe('notifications', () => {
  let app: App;
  let f: Fakes;
  let owner: { token: string; branchId: string; userId: string; tenantId: string };
  let manager: string;
  let pos: { token: string; deviceId: string; key: KeyObject };
  let seq = 0;

  const as = (auth: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: auth }, ...(payload && { payload }) });
  const bell = async (auth = `Bearer ${owner.token}`, who: 'owner' | 'customer' = 'owner') =>
    (await as(auth, 'GET', `/v1/${who}/notifications`)).json() as {
      unread: number;
      items: { id: string; kind: string; title: string; body: string; link: string | null; read: boolean }[];
    };
  const ev = (type: string, entityId: string, payload: Record<string, unknown>, approvedBy?: string): SyncEvent => ({
    id: v7(),
    type,
    version: 1,
    branchId: owner.branchId,
    deviceId: pos.deviceId,
    entityId,
    deviceSeq: ++seq,
    occurredAt: new Date().toISOString(),
    ...(approvedBy && { approvedBy }),
    payload,
  });
  const push = (events: SyncEvent[]) => as(`Device ${pos.token}`, 'POST', '/v1/sync/push', { events });

  /** A paid ticket; returns its order id and line ids. */
  async function sell(items: [string, string, number][], receiptNumber: string, total = 5000) {
    const orderId = v7();
    const lines = items.map(() => v7());
    await push([
      ev('order.opened', orderId, { type: 'takeaway' }),
      ...items.map(([productId, name, qty], i) =>
        ev('order.item_added', orderId, { lineId: lines[i], productId, name, unitPrice: 1000, qty, vatRateBp: 1900, modifiers: [] }),
      ),
      ev('payment.added', orderId, { paymentId: v7(), method: 'cash', amount: total, tendered: total, change: 0 }),
      ev('order.closed', orderId, { receiptNumber, total, itemCount: 1, vat: [] }),
    ]);
    return { orderId, lines };
  }

  beforeEach(async () => {
    f = fakeRepos();
    app = await buildTestApp(f.repos);
    const s = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'sami@example.com', password: 'correct horse battery', name: 'Sami', businessName: 'Kahwet Sami' },
      })
    ).json();
    owner = { token: s.accessToken, branchId: s.branches[0].id, userId: s.user.id, tenantId: s.tenant.id };
    // A manager of the same café: gets the owner notifications too, with their own read state.
    const managerId = v7();
    f.auth.users.push({ ...f.auth.users[0]!, id: managerId, email: 'sonia@example.com', name: 'Sonia', role: 'manager' });
    manager = new TokenService(testAuthConfig.jwtSecret, 900).signAccess({ sub: managerId, tenantId: owner.tenantId, role: 'manager' });

    const { code } = (await as(`Bearer ${owner.token}`, 'POST', `/v1/owner/branches/${owner.branchId}/pairing-codes`, { role: 'hub' })).json();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const paired = (
      await app.inject({ method: 'POST', url: '/v1/devices/pair', payload: { code, name: 'Caisse', publicKey: publicKey.export({ format: 'jwk' }).x } })
    ).json();
    pos = { token: paired.token, deviceId: paired.deviceId, key: privateKey };
    seq = 0;
  });
  afterEach(() => app.close());

  it('owner: a refund, an item cancelled after "Envoyer" and a cash gap — the manager too; not a plain removal', async () => {
    const { orderId, lines } = await sell([['p1', 'Cappuccino', 2], ['p2', 'Express', 1]], 'T1-000007', 6500);
    await push([ev('order.refunded', orderId, { reason: 'quality', receiptNumber: 'T1-000007', payments: [{ paymentId: v7(), method: 'cash', amount: -6500 }] })]);

    const open = v7();
    const l1 = v7();
    const l2 = v7();
    await push([
      ev('order.opened', open, { type: 'takeaway' }),
      ev('order.item_added', open, { lineId: l1, productId: 'p1', name: 'Cappuccino', unitPrice: 1000, qty: 1, vatRateBp: 1900, modifiers: [] }),
      ev('order.item_added', open, { lineId: l2, productId: 'p2', name: 'Express', unitPrice: 1000, qty: 1, vatRateBp: 1900, modifiers: [] }),
      ev('order.item_voided', open, { lineId: l1, reason: 'removed_before_send' }), // before "Envoyer": nothing to say
      ev('order.item_voided', open, { lineId: l2, reason: 'cancelled_after_send', why: 'changed_mind' }, owner.userId),
    ]);

    const session = v7();
    await push([
      ev('cash_session.opened', session, { drawerId: pos.deviceId, openingFloat: 50_000 }),
      ev('cash_session.closed', session, {
        countedCash: 47_500,
        expectedCash: 50_000,
        difference: -2500,
        cashSales: 0,
        cardSales: 0,
        cashIn: 0,
        cashOut: 0,
        ticketCount: 0,
        note: null,
      }),
    ]);

    const mine = await bell();
    expect(mine.unread).toBe(3);
    expect(mine.items.map((i) => [i.kind, i.title, i.body, i.link])).toEqual([
      ['cash_gap', 'Il manque de l’argent en caisse', 'Écart de -2.500 DT à la clôture de T1', `/owner/cash/${session}`],
      ['void_after_send', 'Article annulé après envoi', '1 × Express · le client a changé d’avis', `/owner/sales/${open}`],
      ['refund', 'Ticket remboursé', 'Ticket T1-000007 · 6.500 DT · problème de qualité', `/owner/sales/${orderId}`],
    ]);
    expect(lines).toHaveLength(2);

    // Sonia (manager) has the same 3, and reading hers doesn't read Sami's.
    expect((await bell(`Bearer ${manager}`)).unread).toBe(3);
    await as(`Bearer ${manager}`, 'POST', '/v1/owner/notifications/read', {});
    expect((await bell(`Bearer ${manager}`)).unread).toBe(0);
    expect((await bell()).unread).toBe(3);

    // One by one.
    await as(`Bearer ${owner.token}`, 'POST', '/v1/owner/notifications/read', { ids: [mine.items[0]!.id] });
    const after = await bell();
    expect(after.unread).toBe(2);
    expect(after.items[0]!.read).toBe(true);
  });

  it('owner: "stock bas" when a sale crosses the alert level — once a day, not again on the next sale', async () => {
    const auth = `Bearer ${owner.token}`;
    const cat = (await as(auth, 'POST', `/v1/owner/branches/${owner.branchId}/categories`, { name: 'Café' })).json();
    const cap = (await as(auth, 'POST', `/v1/owner/branches/${owner.branchId}/products`, { name: 'Cappuccino', price: 3500, categoryId: cat.id })).json();
    const milk = (
      await as(auth, 'POST', `/v1/owner/branches/${owner.branchId}/stock/items`, { name: 'Lait', unit: 'ml', quantity: 1300, lowThreshold: 1000 })
    ).json();
    await as(auth, 'PUT', `/v1/owner/products/${cap.id}/recipe`, { lines: [{ stockItemId: milk.id, qty: 150 }] });

    await sell([[cap.id, 'Cappuccino', 1]], 'T1-1'); // 1150: still fine
    expect((await bell()).items).toEqual([]);
    await sell([[cap.id, 'Cappuccino', 1]], 'T1-2'); // 1000: low now
    await sell([[cap.id, 'Cappuccino', 1]], 'T1-3'); // 850: already low
    const items = (await bell()).items;
    expect(items.map((i) => [i.kind, i.title, i.body])).toEqual([['stock_low', 'Stock bas : Lait', 'Il reste 1 L (alerte à 1 L)']]);
  });

  it('client: points and a reward within reach after scanning; a gift; a reminder the day before it expires — each once', async () => {
    await as(`Bearer ${owner.token}`, 'PUT', `/v1/owner/branches/${owner.branchId}/loyalty`, {
      enabled: true,
      pointsPerDinar: 1,
      rewards: [{ name: 'Un express offert', points: 10, kind: 'free_product', productId: 'p-express' }],
    });
    const c = (
      await app.inject({ method: 'POST', url: '/v1/customer/auth/signup', payload: { email: 'leila@example.com', password: 'un mot de passe', name: 'Leila' } })
    ).json();
    const leila = `Bearer ${c.accessToken}`;

    const { orderId } = await sell([['p', 'Café', 1]], 'T1-000001', 12_500);
    const payload = Buffer.from(JSON.stringify({ o: orderId, d: pos.deviceId, n: 'T1-000001', t: 12_500, at: Math.floor(Date.now() / 1000) })).toString('base64url');
    const receipt = `${payload}.${sign(null, Buffer.from(payload), pos.key).toString('base64url')}`;
    await as(leila, 'POST', '/v1/customer/claims', { code: receipt, optIn: true });

    const mine = await bell(leila, 'customer');
    expect(mine.items.map((i) => [i.kind, i.title])).toEqual([
      ['reward_ready', 'Vous pouvez avoir : Un express offert'],
      ['points', '+12 points chez Kahwet Sami'],
    ]);
    // The owner learns Leila joined the club (she ticked the box).
    expect((await bell()).items.map((i) => [i.kind, i.body])).toEqual([
      ['club_joined', 'Leila a rejoint le club. Vous pouvez lui envoyer un cadeau.'],
    ]);
    await as(leila, 'PUT', `/v1/customer/cafes/${owner.branchId}/club`, { optIn: false });
    await as(leila, 'PUT', `/v1/customer/cafes/${owner.branchId}/club`, { optIn: true });
    expect((await bell()).items).toHaveLength(1); // not again

    await as(`Bearer ${owner.token}`, 'POST', `/v1/owner/branches/${owner.branchId}/gifts`, {
      customerIds: [c.customer.id],
      name: 'Un express offert',
      kind: 'free_product',
      productId: 'p-express',
      validDays: 1,
    });
    const gift = (await bell(leila, 'customer')).items[0]!;
    expect([gift.kind, gift.title, gift.link]).toEqual(['gift', '🎁 Cadeau de Kahwet Sami', `/app/cafes/${owner.branchId}`]);
    expect(gift.body).toMatch(/^Un express offert · valable jusqu’au \d+ \w+\.$/);

    // The reminder job (server.ts runs it every 10 minutes): once per gift.
    const club = new ClubService(f.repos.club, () => new Date(), new NotificationsService(f.repos.notifications));
    expect(await club.remindExpiringGifts()).toBe(1);
    await club.remindExpiringGifts();
    const reminders = (await bell(leila, 'customer')).items.filter((i) => i.kind === 'gift_expiring');
    expect(reminders.map((i) => i.title)).toEqual(['Votre cadeau expire bientôt']);
  });

  it('each one sees only theirs: another café, a client token, an owner token', async () => {
    await push([
      ev('cash_session.opened', v7(), { drawerId: pos.deviceId, openingFloat: 1 }),
    ]);
    const { orderId } = await sell([['p', 'Café', 1]], 'T1-9');
    await push([ev('order.refunded', orderId, { reason: 'error', payments: [{ paymentId: v7(), method: 'cash', amount: -5000 }] })]);
    expect((await bell()).unread).toBe(1);

    const other = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'x@example.com', password: 'correct horse battery', name: 'X', businessName: 'Autre' },
      })
    ).json();
    expect((await bell(`Bearer ${other.accessToken}`)).unread).toBe(0);
    expect((await as(`Bearer ${owner.token}`, 'GET', '/v1/customer/notifications')).statusCode).toBe(401);
    const c = (
      await app.inject({ method: 'POST', url: '/v1/customer/auth/signup', payload: { email: 'l@example.com', password: 'un mot de passe', name: 'L' } })
    ).json();
    expect((await as(`Bearer ${c.accessToken}`, 'GET', '/v1/owner/notifications')).statusCode).toBe(401);
    expect((await bell(`Bearer ${c.accessToken}`, 'customer')).unread).toBe(0);
  });
});
