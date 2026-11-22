import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import type { buildApp } from '../src/app.js';
import type { SyncEvent } from '../src/modules/sync/sync.schema.js';
import { buildTestApp, fakeRepos } from './fakes.js';

type App = Awaited<ReturnType<typeof buildApp>>;
type Fakes = ReturnType<typeof fakeRepos>;

/** Monthly milestones: "spend 100 DT this month → +50 points", "200 DT → a free express". */
describe('loyalty milestones', () => {
  let app: App;
  let f: Fakes;
  let owner: { token: string; branchId: string };
  let pos: { token: string; deviceId: string; key: KeyObject };
  let leila: string;
  let seq = 0;

  const as = (auth: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: auth }, ...(payload && { payload }) });
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

  /** A paid ticket of [total] millimes and its signed receipt code. */
  async function receipt(total: number) {
    const orderId = v7();
    const n = `T1-${String(seq + 1).padStart(6, '0')}`;
    await as(`Device ${pos.token}`, 'POST', '/v1/sync/push', {
      events: [
        ev('order.opened', orderId, { type: 'takeaway' }),
        ev('order.item_added', orderId, { lineId: v7(), productId: 'p', name: 'Café', unitPrice: total, qty: 1, vatRateBp: 1900, modifiers: [] }),
        ev('payment.added', orderId, { paymentId: v7(), method: 'cash', amount: total, tendered: total, change: 0 }),
        ev('order.closed', orderId, { receiptNumber: n, total, itemCount: 1, vat: [] }),
      ],
    });
    const payload = Buffer.from(JSON.stringify({ o: orderId, d: pos.deviceId, n, t: total, at: Math.floor(Date.now() / 1000) })).toString('base64url');
    return { orderId, code: `${payload}.${sign(null, Buffer.from(payload), pos.key).toString('base64url')}` };
  }
  const claim = async (total: number) => (await as(leila, 'POST', '/v1/customer/claims', { code: (await receipt(total)).code })).json();
  const save = (body: object) => as(`Bearer ${owner.token}`, 'PUT', `/v1/owner/branches/${owner.branchId}/loyalty`, body);

  const program = {
    enabled: true,
    pointsEnabled: false, // this café only uses milestones
    pointsPerDinar: 1,
    rewards: [],
    milestonesEnabled: true,
    milestones: [
      { spend: 200_000, kind: 'free_product', productId: 'p-express', name: 'Un express offert' },
      { spend: 100_000, kind: 'points', points: 50 },
    ],
  };

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
    owner = { token: s.accessToken, branchId: s.branches[0].id };
    await app.inject({
      method: 'PATCH',
      url: `/v1/owner/branches/${owner.branchId}/business`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { listed: true },
    });
    const { code } = (await as(`Bearer ${owner.token}`, 'POST', `/v1/owner/branches/${owner.branchId}/pairing-codes`, { role: 'hub' })).json();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const paired = (
      await app.inject({ method: 'POST', url: '/v1/devices/pair', payload: { code, name: 'Caisse', publicKey: publicKey.export({ format: 'jwk' }).x } })
    ).json();
    pos = { token: paired.token, deviceId: paired.deviceId, key: privateKey };
    leila = `Bearer ${(
      await app.inject({ method: 'POST', url: '/v1/customer/auth/signup', payload: { email: 'leila@example.com', password: 'un mot de passe', name: 'Leila' } })
    ).json().accessToken}`;
    seq = 0;
  });
  afterEach(() => app.close());

  it('the owner chooses: milestones only (sorted, named); at least one system; each milestone complete', async () => {
    const saved = (await save(program)).json();
    expect(saved.pointsEnabled).toBe(false);
    expect(saved.milestones.map((m: { spend: number; name: string; id: string }) => [m.spend, m.name, typeof m.id])).toEqual([
      [100_000, '+50 points', 'string'],
      [200_000, 'Un express offert', 'string'],
    ]);
    expect((await save({ ...program, milestonesEnabled: false })).json().error.message).toMatch(/au moins un système/);
    expect((await save({ ...program, milestones: [{ spend: 50_000, kind: 'points' }] })).json().error.message).toMatch(/points manquant/);
    const pub = (await app.inject({ url: `/v1/public/cafes/${owner.branchId}` })).json();
    expect(pub).toMatchObject({ loyalty: true, pointsPerDinar: 0, rewards: [] });
    expect(pub.milestones).toHaveLength(2);
  });

  it('spending crosses 100 DT → +50 points; 200 DT → a free express (a gift); each once in the month', async () => {
    await save(program);
    const a = await claim(60_000);
    expect(a).toMatchObject({ points: 0, balance: 0, bonuses: [] }); // points off: only milestones count

    const b = await claim(50_000); // 110 DT this month
    expect(b).toMatchObject({ points: 0, balance: 50, bonuses: ['+50 points'] });

    const c = await claim(95_000); // 205 DT
    expect(c.bonuses).toEqual(['Un express offert']);
    expect(c.balance).toBe(50);
    const gifts = (await as(leila, 'GET', '/v1/customer/gifts')).json();
    expect(gifts.map((g: { name: string }) => g.name)).toEqual(['Un express offert']);
    // Not one of the owner's campaigns.
    expect((await as(`Bearer ${owner.token}`, 'GET', `/v1/owner/branches/${owner.branchId}/gifts`)).json()).toEqual([]);

    expect((await claim(80_000)).bonuses).toEqual([]); // 285 DT: nothing new
    const cafe = (await as(leila, 'GET', `/v1/customer/points/${owner.branchId}`)).json();
    expect(cafe.monthSpent).toBe(285_000);
    expect(cafe.history.find((h: { kind: string }) => h.kind === 'bonus')).toMatchObject({ points: 50, rewardName: 'Palier 100.000 DT' });

    const notes = (await as(leila, 'GET', '/v1/customer/notifications')).json().items.map((i: { kind: string; body: string }) => [i.kind, i.body]);
    expect(notes).toEqual([
      ['milestone', '200.000 DT ce mois-ci → Un express offert (dans vos cadeaux).'],
      ['milestone', '100.000 DT ce mois-ci → +50 points.'],
    ]);
  });

  it('a refund lowers the month; going over again the same month gives nothing twice; a new month starts again', async () => {
    await save(program);
    const r = await receipt(120_000);
    expect((await as(leila, 'POST', '/v1/customer/claims', { code: r.code })).json().bonuses).toEqual(['+50 points']);
    await as(`Device ${pos.token}`, 'POST', '/v1/sync/push', {
      events: [ev('order.refunded', r.orderId, { reason: 'error', payments: [{ paymentId: v7(), method: 'cash', amount: -120_000 }] })],
    });
    expect((await as(leila, 'GET', `/v1/customer/points/${owner.branchId}`)).json().monthSpent).toBe(0);
    expect((await claim(110_000)).bonuses).toEqual([]); // already given this month

    // Everything so far happened "last month".
    for (const l of f.loyalty.ledger) l.createdAt = new Date(l.createdAt.getTime() - 40 * 86_400_000);
    f.loyalty.milestoneAwards.clear(); // the fake keys awards by month; a real new month has new keys
    expect((await claim(100_000)).bonuses).toEqual(['+50 points']);
  });

  it('points and milestones together: both count', async () => {
    await save({ ...program, pointsEnabled: true, rewards: [{ name: 'Un express offert', points: 10, kind: 'free_product', productId: 'p-express' }] });
    const r = await claim(100_000);
    expect(r).toMatchObject({ points: 100, balance: 150, bonuses: ['+50 points'] });
  });
});
