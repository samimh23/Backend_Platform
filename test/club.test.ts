import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import type { buildApp } from '../src/app.js';
import type { SyncEvent } from '../src/modules/sync/sync.schema.js';
import { TokenService } from '../src/shared/tokens.js';
import { buildTestApp, fakeRepos, testAuthConfig, type FakeAuthRepo, type FakeClubRepo } from './fakes.js';

type App = Awaited<ReturnType<typeof buildApp>>;

/** The café's club: who joined, what they spent; gifts sent to them and used at the POS. */
describe('café club and gifts', () => {
  let app: App;
  let auth: FakeAuthRepo;
  let club: FakeClubRepo;
  let owner: { token: string; branchId: string };
  let pos: { token: string; deviceId: string; key: KeyObject };
  let seq = 0;

  const as = (auth: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: auth }, ...(payload && { payload }) });
  const ownerReq = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, token = owner.token) =>
    as(`Bearer ${token}`, method, url, payload);

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

  /** A paid ticket synced from the POS, and its signed receipt code. */
  async function receipt(total: number) {
    const orderId = v7();
    const n = `T1-${String(seq).padStart(6, '0')}`;
    await as(`Device ${pos.token}`, 'POST', '/v1/sync/push', {
      events: [
        ev('order.opened', orderId, { type: 'takeaway' }),
        ev('order.item_added', orderId, { lineId: v7(), productId: 'p', name: 'Café', unitPrice: total, qty: 1, vatRateBp: 1900, modifiers: [] }),
        ev('payment.added', orderId, { paymentId: v7(), method: 'cash', amount: total, tendered: total, change: 0 }),
        ev('order.closed', orderId, { receiptNumber: n, total, itemCount: 1, vat: [] }),
      ],
    });
    const payload = Buffer.from(JSON.stringify({ o: orderId, d: pos.deviceId, n, t: total, at: Math.floor(Date.now() / 1000) })).toString(
      'base64url',
    );
    return `${payload}.${sign(null, Buffer.from(payload), pos.key).toString('base64url')}`;
  }

  async function customer(name: string) {
    const c = (
      await app.inject({
        method: 'POST',
        url: '/v1/customer/auth/signup',
        payload: { email: `${name.toLowerCase()}@example.com`, password: 'un mot de passe', name },
      })
    ).json();
    return { id: c.customer.id as string, token: c.accessToken as string, auth: `Bearer ${c.accessToken}` };
  }

  beforeEach(async () => {
    const f = fakeRepos();
    auth = f.auth;
    club = f.club;
    app = await buildTestApp(f.repos);
    const s = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'o@example.com', password: 'correct horse battery', name: 'Owner', businessName: 'Kahwet Sami' },
      })
    ).json();
    owner = { token: s.accessToken, branchId: s.branches[0].id };
    await ownerReq('PUT', `/v1/owner/branches/${owner.branchId}/loyalty`, { enabled: true, pointsPerDinar: 1, rewards: [] });
    const { code } = (await ownerReq('POST', `/v1/owner/branches/${owner.branchId}/pairing-codes`, { role: 'hub' })).json();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const paired = (
      await app.inject({ method: 'POST', url: '/v1/devices/pair', payload: { code, name: 'Caisse', publicKey: publicKey.export({ format: 'jwk' }).x } })
    ).json();
    pos = { token: paired.token, deviceId: paired.deviceId, key: privateKey };
    seq = 0;
  });
  afterEach(() => app.close());

  it('only customers who joined the club are visible, with their visits and spending; leaving hides them', async () => {
    const leila = await customer('Leila');
    const karim = await customer('Karim');
    await as(leila.auth, 'POST', '/v1/customer/claims', { code: await receipt(12_500), optIn: true });
    await as(leila.auth, 'POST', '/v1/customer/claims', { code: await receipt(4_000) });
    await as(karim.auth, 'POST', '/v1/customer/claims', { code: await receipt(30_000) }); // did not join

    const view = (await ownerReq('GET', `/v1/owner/branches/${owner.branchId}/club`)).json();
    expect(view.customers).toBe(2);
    expect(view.members).toEqual([
      { id: leila.id, name: 'Leila', visits: 2, spent: 16_500, points: 16, lastVisit: expect.any(String) },
    ]);
    expect(JSON.stringify(view)).not.toContain('@'); // never an email

    const cafe = (await as(leila.auth, 'GET', `/v1/customer/points/${owner.branchId}`)).json();
    expect(cafe.optIn).toBe(true);
    await as(leila.auth, 'PUT', `/v1/customer/cafes/${owner.branchId}/club`, { optIn: false });
    expect((await ownerReq('GET', `/v1/owner/branches/${owner.branchId}/club`)).json().members).toEqual([]);
  });

  it('owner sends a gift to members; the customer shows its code; the POS applies it once, no points spent', async () => {
    const leila = await customer('Leila');
    const karim = await customer('Karim');
    await as(leila.auth, 'POST', '/v1/customer/claims', { code: await receipt(12_000), optIn: true });

    const sent = await ownerReq('POST', `/v1/owner/branches/${owner.branchId}/gifts`, {
      customerIds: [leila.id, karim.id], // Karim isn't a member: skipped
      name: 'Un express offert',
      kind: 'free_product',
      productId: 'p-express',
      validDays: 14,
    });
    expect(sent.json()).toMatchObject({ sent: 1, skipped: 1 });
    expect((await as(karim.auth, 'GET', '/v1/customer/gifts')).json()).toEqual([]);

    const gifts = (await as(leila.auth, 'GET', '/v1/customer/gifts')).json();
    expect(gifts).toEqual([
      { id: expect.any(String), cafeId: owner.branchId, cafeName: 'Kahwet Sami', name: 'Un express offert', kind: 'free_product', expiresAt: expect.any(String) },
    ]);
    expect((await as(leila.auth, 'GET', `/v1/customer/points/${owner.branchId}`)).json().gifts).toHaveLength(1);
    // Someone else can't use Leila's gift.
    expect((await as(karim.auth, 'POST', `/v1/customer/gifts/${gifts[0].id}/code`)).statusCode).toBe(404);

    const { code, points } = (await as(leila.auth, 'POST', `/v1/customer/gifts/${gifts[0].id}/code`)).json();
    expect(points).toBe(0);
    const seen = (await as(`Device ${pos.token}`, 'GET', `/v1/devices/loyalty/redemptions/${code}`)).json();
    expect(seen).toMatchObject({ rewardName: 'Un express offert', gift: true, points: 0, productId: 'p-express', customerName: 'Leila' });

    const orderId = v7();
    expect((await as(`Device ${pos.token}`, 'POST', `/v1/devices/loyalty/redemptions/${code}/redeem`, { orderId })).statusCode).toBe(200);
    expect(club.gifts[0]).toMatchObject({ orderId, usedAt: expect.any(Date) });
    expect((await as(leila.auth, 'GET', `/v1/customer/points/${owner.branchId}`)).json().balance).toBe(12); // untouched
    expect((await as(leila.auth, 'GET', '/v1/customer/gifts')).json()).toEqual([]);
    expect((await as(leila.auth, 'POST', `/v1/customer/gifts/${gifts[0].id}/code`)).json().error.code).toBe('GIFT_NOT_FOUND');

    const campaigns = (await ownerReq('GET', `/v1/owner/branches/${owner.branchId}/gifts`)).json();
    expect(campaigns).toEqual([
      { id: expect.any(String), name: 'Un express offert', kind: 'free_product', sentAt: expect.any(String), expiresAt: expect.any(String), sent: 1, used: 1 },
    ]);
  });

  it('a gift code made twice still gives one gift', async () => {
    const leila = await customer('Leila');
    await as(leila.auth, 'POST', '/v1/customer/claims', { code: await receipt(5_000), optIn: true });
    await ownerReq('POST', `/v1/owner/branches/${owner.branchId}/gifts`, {
      customerIds: [leila.id],
      name: '3 DT offerts',
      kind: 'amount_off',
      amount: 3000,
      validDays: 7,
    });
    const [gift] = (await as(leila.auth, 'GET', '/v1/customer/gifts')).json();
    const first = (await as(leila.auth, 'POST', `/v1/customer/gifts/${gift.id}/code`)).json().code;
    const second = (await as(leila.auth, 'POST', `/v1/customer/gifts/${gift.id}/code`)).json().code;
    expect((await as(`Device ${pos.token}`, 'GET', `/v1/devices/loyalty/redemptions/${first}`)).statusCode).toBe(404); // replaced
    const seen = (await as(`Device ${pos.token}`, 'POST', `/v1/devices/loyalty/redemptions/${second}/redeem`, { orderId: v7() })).json();
    expect(seen).toMatchObject({ kind: 'amount_off', amount: 3000, gift: true });
    expect(club.gifts.filter((g) => g.usedAt)).toHaveLength(1);
  });

  it('expired gifts disappear; only the owner sends; a gift needs its product or amount; nobody to send to → refused', async () => {
    const leila = await customer('Leila');
    await as(leila.auth, 'POST', '/v1/customer/claims', { code: await receipt(5_000), optIn: true });
    const send = (body: object, token?: string) =>
      ownerReq('POST', `/v1/owner/branches/${owner.branchId}/gifts`, { customerIds: [leila.id], name: 'Cadeau', validDays: 7, ...body }, token);

    const o = auth.users[0]!;
    const manager = new TokenService(testAuthConfig.jwtSecret, 900).signAccess({ sub: o.id, tenantId: o.tenantId, role: 'manager' });
    expect((await send({ kind: 'amount_off', amount: 1000 }, manager)).statusCode).toBe(403);
    expect((await ownerReq('GET', `/v1/owner/branches/${owner.branchId}/club`, undefined, manager)).statusCode).toBe(200); // can look
    expect((await send({ kind: 'free_product' })).json().error.code).toBe('INVALID_GIFT');
    expect((await send({ kind: 'amount_off' })).json().error.code).toBe('INVALID_GIFT');
    expect((await ownerReq('POST', `/v1/owner/branches/${owner.branchId}/gifts`, { customerIds: [v7()], name: 'X', kind: 'amount_off', amount: 1, validDays: 1 })).json().error.code).toBe(
      'NO_CLUB_MEMBERS',
    );

    await send({ kind: 'amount_off', amount: 1000 });
    club.gifts[0]!.expiresAt = new Date(Date.now() - 1000);
    expect((await as(leila.auth, 'GET', '/v1/customer/gifts')).json()).toEqual([]);
  });
});
