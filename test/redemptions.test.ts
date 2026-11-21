import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import type { buildApp } from '../src/app.js';
import { buildTestApp, fakeRepos, publicKey, type FakeLoyaltyRepo, type FakeRedemptionsRepo } from './fakes.js';

type App = Awaited<ReturnType<typeof buildApp>>;

/** Spending points: customer code → POS checks → POS redeems (points spent once). */
describe('loyalty rewards at the counter', () => {
  let app: App;
  let loyalty: FakeLoyaltyRepo;
  let redemptions: FakeRedemptionsRepo;
  let owner: { token: string; branchId: string };
  let pos: string;
  let customer: { token: string; id: string };
  let rewards: { id: string; name: string; points: number }[];

  const as = (auth: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: auth }, ...(payload && { payload }) });
  const giveCustomerPoints = (points: number, branchId = owner.branchId) =>
    loyalty.ledger.push({
      customerId: customer.id,
      branchId,
      points,
      kind: 'earn',
      orderId: v7(),
      receiptNumber: 'T1-000001',
      rewardName: null,
      createdAt: new Date(),
    });
  const ask = (rewardId: string, token = customer.token) =>
    as(`Bearer ${token}`, 'POST', `/v1/customer/points/${owner.branchId}/redemptions`, { rewardId });
  const check = (code: string, device = pos) => as(`Device ${device}`, 'GET', `/v1/devices/loyalty/redemptions/${code}`);
  const redeem = (code: string, orderId = v7(), device = pos) =>
    as(`Device ${device}`, 'POST', `/v1/devices/loyalty/redemptions/${code}/redeem`, { orderId });
  const balance = async () => (await as(`Bearer ${customer.token}`, 'GET', `/v1/customer/points/${owner.branchId}`)).json().balance;

  async function signupOwner(email: string) {
    const s = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email, password: 'correct horse battery', name: 'Owner', businessName: 'Kahwet Sami' },
      })
    ).json();
    const o = { token: s.accessToken as string, branchId: s.branches[0].id as string };
    const { code } = (await as(`Bearer ${o.token}`, 'POST', `/v1/owner/branches/${o.branchId}/pairing-codes`, { role: 'hub' })).json();
    const device = (await app.inject({ method: 'POST', url: '/v1/devices/pair', payload: { code, name: 'Caisse', publicKey } })).json();
    return { ...o, device: device.token as string };
  }

  beforeEach(async () => {
    const f = fakeRepos();
    loyalty = f.loyalty;
    redemptions = f.redemptions;
    app = await buildTestApp(f.repos);
    const o = await signupOwner('o@example.com');
    owner = o;
    pos = o.device;
    rewards = (
      await as(`Bearer ${owner.token}`, 'PUT', `/v1/owner/branches/${owner.branchId}/loyalty`, {
        enabled: true,
        pointsPerDinar: 1,
        rewards: [
          { name: 'Un express offert', points: 10, kind: 'free_product', productId: 'p-express' },
          { name: '5 DT de remise', points: 50, kind: 'amount_off', amount: 5000 },
        ],
      })
    ).json().rewards;
    const c = (
      await app.inject({
        method: 'POST',
        url: '/v1/customer/auth/signup',
        payload: { email: 'leila@example.com', password: 'un mot de passe', name: 'Leila' },
      })
    ).json();
    customer = { token: c.accessToken, id: c.customer.id };
  });
  afterEach(() => app.close());

  it('customer gets a code; the POS sees the reward without spending; redeeming spends the points once', async () => {
    giveCustomerPoints(25);
    const r = await ask(rewards[0]!.id);
    expect(r.statusCode).toBe(200);
    const { code, expiresAt, rewardName, points } = r.json();
    expect(code).toMatch(/^\d{6}$/);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    expect({ rewardName, points }).toEqual({ rewardName: 'Un express offert', points: 10 });

    const seen = (await check(code)).json();
    expect(seen).toMatchObject({ rewardName: 'Un express offert', kind: 'free_product', productId: 'p-express', amount: null, customerName: 'Leila', points: 10 });
    expect(await balance()).toBe(25); // just looking spends nothing

    const orderId = v7();
    expect((await redeem(code, orderId)).statusCode).toBe(200);
    expect(await balance()).toBe(15);
    const cafe = (await as(`Bearer ${customer.token}`, 'GET', `/v1/customer/points/${owner.branchId}`)).json();
    expect(cafe.history[0]).toMatchObject({ points: -10, kind: 'redeem', rewardName: 'Un express offert' });
    expect(loyalty.ledger.at(-1)).toMatchObject({ orderId });

    const again = await redeem(code);
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe('REDEMPTION_NOT_FOUND');
    expect(await balance()).toBe(15);
  });

  it('not enough points → no code', async () => {
    giveCustomerPoints(30);
    const r = await ask(rewards[1]!.id);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('NOT_ENOUGH_POINTS');
    expect((await ask('nope')).json().error.code).toBe('REWARD_NOT_FOUND');
  });

  it('a new code replaces the previous one; an expired code is refused', async () => {
    giveCustomerPoints(100);
    const first = (await ask(rewards[0]!.id)).json().code;
    const second = (await ask(rewards[1]!.id)).json().code;
    expect((await check(first)).statusCode).toBe(404);
    expect((await check(second)).json().rewardName).toBe('5 DT de remise');

    redemptions.rows.find((r) => r.code === second)!.expiresAt = new Date(Date.now() - 1000);
    expect((await redeem(second)).json().error.code).toBe('REDEMPTION_NOT_FOUND');
    expect(await balance()).toBe(100);
  });

  it('points gone meanwhile (refund, other reward) → refused at the counter', async () => {
    giveCustomerPoints(12);
    const { code } = (await ask(rewards[0]!.id)).json();
    giveCustomerPoints(-5); // e.g. a refunded ticket took points back
    const r = await check(code);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('NOT_ENOUGH_POINTS');
    expect((await redeem(code)).statusCode).toBe(409);
    expect(await balance()).toBe(7);
  });

  it("another café's POS can't use the code; only a paired POS can; codes are 6 digits", async () => {
    giveCustomerPoints(20);
    const { code } = (await ask(rewards[0]!.id)).json();
    const other = await signupOwner('other@example.com');
    expect((await check(code, other.device)).statusCode).toBe(404);
    expect((await redeem(code, v7(), other.device)).statusCode).toBe(404);

    expect((await as(`Bearer ${owner.token}`, 'GET', `/v1/devices/loyalty/redemptions/${code}`)).statusCode).toBe(401);
    expect((await as(`Bearer ${customer.token}`, 'GET', `/v1/devices/loyalty/redemptions/${code}`)).statusCode).toBe(401);
    expect((await check('12ab56')).statusCode).toBe(400);
    expect(await balance()).toBe(20);
  });
});
