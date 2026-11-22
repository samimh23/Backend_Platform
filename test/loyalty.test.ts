import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import type { buildApp } from '../src/app.js';
import type { SyncEvent } from '../src/modules/sync/sync.schema.js';
import { parseReceiptCode, verifyReceiptSignature } from '../src/shared/receipts.js';
import { TokenService } from '../src/shared/tokens.js';
import { buildTestApp, fakeRepos, testAuthConfig, type FakeAuthRepo, type FakeLoyaltyRepo } from './fakes.js';

type App = Awaited<ReturnType<typeof buildApp>>;

/** A POS key pair, like the one the Flutter app creates at pairing. */
function posKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: publicKey.export({ format: 'jwk' }).x! };
}

/** Same format the POS prints in the receipt QR. */
function receiptCode(key: KeyObject, r: { orderId: string; deviceId: string; receiptNumber: string; total: number; at?: Date }) {
  const payload = Buffer.from(
    JSON.stringify({ o: r.orderId, d: r.deviceId, n: r.receiptNumber, t: r.total, at: Math.floor((r.at ?? new Date()).getTime() / 1000) }),
  ).toString('base64url');
  return `${payload}.${sign(null, Buffer.from(payload), key).toString('base64url')}`;
}

describe('receipt codes', () => {
  it('accepts a code signed by the Flutter POS (same vector as pos-cafe test/features/loyalty_receipt_test.dart)', () => {
    const publicKey = '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw';
    const code =
      'eyJvIjoiMDE5YTAwMDAtMDAwMC03MDAwLTgwMDAtMDAwMDAwMDAwMDAxIiwiZCI6IjAxOWEwMDAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDBkMSIsIm4iOiJUMS0wMDAwNDIiLCJ0IjoxMjUwMCwiYXQiOjE3NjM2NDcyMDB9.o1MNkjIJaP8kUpv4BRmuw_18wpIKDrA6FaEvnZYv3C_juLAI7cgk39GuM6qu2nWOCWVLkR-rqXbmERrOqaYaDg';
    const p = parseReceiptCode(code)!;
    expect(p.claim).toEqual({
      orderId: '019a0000-0000-7000-8000-000000000001',
      deviceId: '019a0000-0000-7000-8000-0000000000d1',
      receiptNumber: 'T1-000042',
      total: 12_500,
      at: new Date('2025-11-20T14:00:00Z'),
    });
    expect(verifyReceiptSignature(publicKey, p.payload, p.signature)).toBe(true);
  });

  it('a signed code verifies; a changed total does not', () => {
    const k = posKeys();
    const code = receiptCode(k.privateKey, { orderId: v7(), deviceId: v7(), receiptNumber: 'T1-000001', total: 12_500 });
    const p = parseReceiptCode(code)!;
    expect(p.claim.total).toBe(12_500);
    expect(verifyReceiptSignature(k.publicKey, p.payload, p.signature)).toBe(true);

    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p.payload, 'base64url').toString()), t: 999_000 })).toString('base64url');
    expect(verifyReceiptSignature(k.publicKey, forged, p.signature)).toBe(false);
    expect(verifyReceiptSignature(posKeys().publicKey, p.payload, p.signature)).toBe(false);
    expect(parseReceiptCode('not-a-code')).toBeNull();
    expect(parseReceiptCode('a.b.c')).toBeNull();
  });
});

describe('loyalty', () => {
  let app: App;
  let auth: FakeAuthRepo;
  let loyalty: FakeLoyaltyRepo;
  let owner: { token: string; branchId: string };
  let pos: { token: string; deviceId: string; privateKey: KeyObject };
  let customer: string;
  let seq = 0;

  const ownerReq = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object, token = owner.token) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload && { payload }) });
  const asCustomer = (method: 'GET' | 'POST', url: string, payload?: object, token = customer) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload && { payload }) });

  const program = {
    enabled: true,
    pointsPerDinar: 1,
    rewards: [
      { name: 'Un express offert', points: 10, kind: 'free_product', productId: 'express' },
      { name: '5 DT de remise', points: 50, kind: 'amount_off', amount: 5000 },
    ],
  };

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

  /** A paid ticket synced from the POS, and its receipt code. */
  async function paidTicket(total: number, receiptNumber: string) {
    const orderId = v7();
    await push([
      ev('order.opened', orderId, { type: 'takeaway' }),
      ev('order.item_added', orderId, { lineId: v7(), productId: 'p', name: 'Café', unitPrice: total, qty: 1, vatRateBp: 1900, modifiers: [] }),
      ev('payment.added', orderId, { paymentId: v7(), method: 'cash', amount: total, tendered: total, change: 0 }),
      ev('order.closed', orderId, { receiptNumber, total, itemCount: 1, vat: [] }),
    ]);
    return { orderId, code: receiptCode(pos.privateKey, { orderId, deviceId: pos.deviceId, receiptNumber, total }) };
  }

  beforeEach(async () => {
    const f = fakeRepos();
    auth = f.auth;
    loyalty = f.loyalty;
    app = await buildTestApp(f.repos);
    const s = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'o@example.com', password: 'correct horse battery', name: 'Owner', businessName: 'Kahwet Sami' },
      })
    ).json();
    owner = { token: s.accessToken, branchId: s.branches[0].id };
    const { code } = (await ownerReq('POST', `/v1/owner/branches/${owner.branchId}/pairing-codes`, { role: 'hub' })).json();
    const keys = posKeys();
    const paired = (await app.inject({ method: 'POST', url: '/v1/devices/pair', payload: { code, name: 'Caisse', publicKey: keys.publicKey } })).json();
    pos = { token: paired.token, deviceId: paired.deviceId, privateKey: keys.privateKey };
    customer = (
      await app.inject({ method: 'POST', url: '/v1/customer/auth/signup', payload: { email: 'leila@example.com', password: 'un mot de passe', name: 'Leila' } })
    ).json().accessToken;
    seq = 0;
  });
  afterEach(() => app.close());

  it('owner turns the program on; the POS knows it (prints the QR); the café shows up in the search once listed', async () => {
    const empty = (await ownerReq('GET', `/v1/owner/branches/${owner.branchId}/loyalty`)).json();
    expect(empty).toEqual({ enabled: false, pointsEnabled: true, pointsPerDinar: 1, rewards: [], milestonesEnabled: false, milestones: [] });

    const saved = (await ownerReq('PUT', `/v1/owner/branches/${owner.branchId}/loyalty`, program)).json();
    expect(saved.rewards).toHaveLength(2);
    expect(saved.rewards[0]).toMatchObject({ id: expect.any(String), name: 'Un express offert', productId: 'express' });
    expect(saved.rewards[1]).not.toHaveProperty('productId');

    const forPos = (await app.inject({ url: '/v1/devices/business', headers: { authorization: `Device ${pos.token}` } })).json();
    expect(forPos.loyaltyEnabled).toBe(true);

    // Not listed yet: invisible to customers.
    expect((await app.inject({ url: '/v1/public/cafes' })).json()).toEqual([]);
    expect((await app.inject({ url: `/v1/public/cafes/${owner.branchId}` })).statusCode).toBe(404);

    await ownerReq('PATCH', `/v1/owner/branches/${owner.branchId}/business`, { listed: true, city: ' La Marsa ' });
    const found = (await app.inject({ url: '/v1/public/cafes?q=marsa' })).json();
    expect(found).toEqual([
      { id: owner.branchId, name: 'Kahwet Sami', businessName: 'Kahwet Sami', city: 'La Marsa', address: null, loyalty: true, pointsPerDinar: 1 },
    ]);
    expect((await app.inject({ url: '/v1/public/cafes?q=sfax' })).json()).toEqual([]);
    const detail = (await app.inject({ url: `/v1/public/cafes/${owner.branchId}` })).json();
    expect(detail.rewards.map((r: { name: string }) => r.name)).toEqual(['Un express offert', '5 DT de remise']);
  });

  it('only the owner edits the program; a reward needs its product or amount', async () => {
    const o = auth.users[0]!;
    const manager = new TokenService(testAuthConfig.jwtSecret, 900).signAccess({ sub: o.id, tenantId: o.tenantId, role: 'manager' });
    expect((await ownerReq('PUT', `/v1/owner/branches/${owner.branchId}/loyalty`, program, manager)).statusCode).toBe(403);
    const bad = await ownerReq('PUT', `/v1/owner/branches/${owner.branchId}/loyalty`, {
      ...program,
      rewards: [{ name: 'Remise', points: 10, kind: 'amount_off' }],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_REWARD');
    expect((await ownerReq('GET', `/v1/owner/branches/${v7()}/loyalty`)).statusCode).toBe(404);
  });

  it('a customer scans a receipt: points = whole dinars × rate; once per receipt; balance and history per café', async () => {
    await ownerReq('PUT', `/v1/owner/branches/${owner.branchId}/loyalty`, { ...program, pointsPerDinar: 2 });
    const t1 = await paidTicket(12_500, 'T1-000001'); // 12.500 DT × 2 → 25 points
    const t2 = await paidTicket(800, 'T1-000002'); // 0.800 DT × 2 → 1 point

    const c1 = await asCustomer('POST', '/v1/customer/claims', { code: t1.code });
    expect(c1.json()).toEqual({ cafeId: owner.branchId, cafeName: 'Kahwet Sami', receiptNumber: 'T1-000001', points: 25, balance: 25, bonuses: [] });
    expect((await asCustomer('POST', '/v1/customer/claims', { code: t2.code })).json().balance).toBe(26);

    const again = await asCustomer('POST', '/v1/customer/claims', { code: t1.code });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('RECEIPT_ALREADY_CLAIMED');

    // Another customer can't take the same receipt either.
    const other = (
      await app.inject({ method: 'POST', url: '/v1/customer/auth/signup', payload: { email: 'b@example.com', password: 'un mot de passe', name: 'B' } })
    ).json().accessToken;
    expect((await asCustomer('POST', '/v1/customer/claims', { code: t1.code }, other)).statusCode).toBe(409);

    const mine = (await asCustomer('GET', '/v1/customer/points')).json();
    expect(mine).toEqual([{ cafeId: owner.branchId, cafeName: 'Kahwet Sami', city: null, balance: 26, rewardsAvailable: 1 }]);

    // Visible to the customer even though the café isn't listed in the search.
    const cafe = (await asCustomer('GET', `/v1/customer/points/${owner.branchId}`)).json();
    expect(cafe.balance).toBe(26);
    expect(cafe.history.map((h: { points: number; receiptNumber: string }) => [h.points, h.receiptNumber])).toEqual(
      expect.arrayContaining([
        [25, 'T1-000001'],
        [1, 'T1-000002'],
      ]),
    );
  });

  it('forged, foreign, old or unknown receipts are refused', async () => {
    await ownerReq('PUT', `/v1/owner/branches/${owner.branchId}/loyalty`, program);
    const { orderId, code } = await paidTicket(5000, 'T1-000001');

    const [payload, sig] = code.split('.');
    const bigger = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), t: 500_000 })).toString('base64url');
    expect((await asCustomer('POST', '/v1/customer/claims', { code: `${bigger}.${sig}` })).json().error.code).toBe('RECEIPT_INVALID');

    // Signed by a key that is not this POS's.
    const stranger = receiptCode(posKeys().privateKey, { orderId, deviceId: pos.deviceId, receiptNumber: 'T1-000001', total: 5000 });
    expect((await asCustomer('POST', '/v1/customer/claims', { code: stranger })).json().error.code).toBe('RECEIPT_INVALID');

    // Unknown device.
    const ghost = receiptCode(pos.privateKey, { orderId, deviceId: v7(), receiptNumber: 'T1-000001', total: 5000 });
    expect((await asCustomer('POST', '/v1/customer/claims', { code: ghost })).json().error.code).toBe('RECEIPT_INVALID');

    const old = receiptCode(pos.privateKey, {
      orderId: v7(),
      deviceId: pos.deviceId,
      receiptNumber: 'T1-000009',
      total: 5000,
      at: new Date(Date.now() - 31 * 86_400_000),
    });
    expect((await asCustomer('POST', '/v1/customer/claims', { code: old })).json().error.code).toBe('RECEIPT_TOO_OLD');

    expect((await asCustomer('POST', '/v1/customer/claims', { code: 'nonsense-code-here' })).json().error.code).toBe('RECEIPT_INVALID');
    // Not logged in.
    expect((await app.inject({ method: 'POST', url: '/v1/customer/claims', payload: { code } })).statusCode).toBe(401);
    // An owner token is not a customer token.
    expect((await asCustomer('POST', '/v1/customer/claims', { code }, owner.token)).statusCode).toBe(401);
  });

  it('no program → no points', async () => {
    const { code } = await paidTicket(5000, 'T1-000001');
    expect((await asCustomer('POST', '/v1/customer/claims', { code })).json().error.code).toBe('LOYALTY_DISABLED');
  });

  it('a refunded ticket takes its points back, and can no longer be claimed', async () => {
    await ownerReq('PUT', `/v1/owner/branches/${owner.branchId}/loyalty`, program);
    const t1 = await paidTicket(20_000, 'T1-000001');
    const t2 = await paidTicket(7_000, 'T1-000002');
    await asCustomer('POST', '/v1/customer/claims', { code: t1.code });
    expect((await asCustomer('GET', '/v1/customer/points')).json()[0].balance).toBe(20);

    const refund = (orderId: string, receiptNumber: string, amount: number) =>
      ev('order.refunded', orderId, { reason: 'quality', receiptNumber, payments: [{ paymentId: v7(), method: 'cash', amount: -amount }] });
    await push([refund(t1.orderId, 'T1-000001', 20_000), refund(t2.orderId, 'T1-000002', 7_000)]);

    expect((await asCustomer('GET', '/v1/customer/points')).json()[0].balance).toBe(0);
    expect(loyalty.ledger.map((l) => [l.kind, l.points])).toEqual([
      ['earn', 20],
      ['refund', -20],
    ]);
    expect((await asCustomer('POST', '/v1/customer/claims', { code: t2.code })).json().error.code).toBe('RECEIPT_REFUNDED');
  });
});
