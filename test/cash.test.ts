import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import type { buildApp } from '../src/app.js';
import { projectEvents } from '../src/modules/sales/sales.projection.js';
import type { SyncEvent } from '../src/modules/sync/sync.schema.js';
import { buildTestApp, fakeRepos, publicKey, type FakeSyncRepo } from './fakes.js';

type App = Awaited<ReturnType<typeof buildApp>>;

/** A drawer's day, as the POS sends it: opened with a float → cash out → counted at closing. */
describe('cash sessions (Clôtures)', () => {
  let app: App;
  let sync: FakeSyncRepo;
  let owner: { token: string; branchId: string };
  let pos: { token: string; deviceId: string };
  let cashierId: string;
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
    const { code } = (await req('POST', `/v1/owner/branches/${owner.branchId}/pairing-codes`, { role: 'hub' })).json();
    pos = (await app.inject({ method: 'POST', url: '/v1/devices/pair', payload: { code, name: 'Comptoir', publicKey } })).json();
    cashierId = (await req('POST', `/v1/owner/branches/${owner.branchId}/staff`, { name: 'Riadh', role: 'cashier', pin: '2580' })).json().id;
    seq = 0;
  });
  afterEach(() => app.close());

  const req = (method: 'GET' | 'POST', url: string, payload?: object, token = owner.token) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload && { payload }) });
  const ev = (type: string, entityId: string, payload: Record<string, unknown>, at: Date): SyncEvent => ({
    id: v7(),
    type,
    version: 1,
    branchId: owner.branchId,
    deviceId: pos.deviceId,
    staffId: cashierId,
    entityId,
    deviceSeq: ++seq,
    occurredAt: at.toISOString(),
    payload,
  });
  const push = (events: SyncEvent[]) =>
    app.inject({ method: 'POST', url: '/v1/sync/push', headers: { authorization: `Device ${pos.token}` }, payload: { events } });

  async function aDay(at: Date) {
    const session = v7();
    const later = (min: number) => new Date(at.getTime() + min * 60_000);
    await push([
      ev('cash_session.opened', session, { drawerId: pos.deviceId, openingFloat: 50_000 }, at),
      ev('cash.moved', session, { movementId: v7(), type: 'out', amount: 30_000, reason: 'Pain du fournisseur' }, later(60)),
      ev('cash.moved', session, { movementId: v7(), type: 'in', amount: 20_000, reason: 'Monnaie' }, later(90)),
      ev(
        'cash_session.closed',
        session,
        {
          countedCash: 151_500,
          expectedCash: 152_400,
          difference: -900,
          cashSales: 112_400,
          cardSales: 45_000,
          cashIn: 20_000,
          cashOut: 30_000,
          ticketCount: 37,
          note: 'Billet de 10 abîmé',
        },
        later(600),
      ),
    ]);
    return session;
  }

  it('the POS opens, moves cash and closes → the owner sees the day with the gap and who did it', async () => {
    const session = await aDay(new Date('2026-11-19T06:00:00Z')); // 7:00 in Tunis
    expect(sync.errors).toEqual([]);

    const list = (await req('GET', `/v1/owner/branches/${owner.branchId}/cash-sessions`)).json();
    expect(list).toEqual([
      expect.objectContaining({
        id: session,
        status: 'closed',
        drawer: { id: pos.deviceId, code: 'T1', name: 'Comptoir' },
        openedBy: 'Riadh',
        closedBy: 'Riadh',
        openingFloat: 50_000,
        expectedCash: 152_400,
        countedCash: 151_500,
        difference: -900,
        cardSales: 45_000,
        ticketCount: 37,
        note: 'Billet de 10 abîmé',
      }),
    ]);

    const detail = (await req('GET', `/v1/owner/cash-sessions/${session}`)).json();
    expect(detail.movements.map((m: { type: string; amount: number; reason: string; staff: string }) => [m.type, m.amount, m.reason, m.staff])).toEqual([
      ['out', 30_000, 'Pain du fournisseur', 'Riadh'],
      ['in', 20_000, 'Monnaie', 'Riadh'],
    ]);
  });

  it('an open session shows as open; sending the same events again changes nothing', async () => {
    const session = v7();
    const opened = ev('cash_session.opened', session, { drawerId: pos.deviceId, openingFloat: 40_000 }, new Date());
    await push([opened]);
    await push([opened]);
    const list = (await req('GET', `/v1/owner/branches/${owner.branchId}/cash-sessions`)).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'open', closedAt: null, difference: null, openingFloat: 40_000 });
  });

  it('filter by café day (Tunisia time), newest first', async () => {
    await aDay(new Date('2026-11-18T06:00:00Z'));
    const today = await aDay(new Date('2026-11-19T06:00:00Z'));
    const all = (await req('GET', `/v1/owner/branches/${owner.branchId}/cash-sessions`)).json();
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe(today);
    const oneDay = (await req('GET', `/v1/owner/branches/${owner.branchId}/cash-sessions?date=2026-11-19`)).json();
    expect(oneDay.map((s: { id: string }) => s.id)).toEqual([today]);
  });

  it('another business cannot see my sessions', async () => {
    const session = await aDay(new Date());
    const other = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'x@example.com', password: 'correct horse battery', name: 'X', businessName: 'Autre' },
      })
    ).json();
    expect((await req('GET', `/v1/owner/branches/${owner.branchId}/cash-sessions`, undefined, other.accessToken)).statusCode).toBe(404);
    expect((await req('GET', `/v1/owner/cash-sessions/${session}`, undefined, other.accessToken)).json().error.code).toBe(
      'CASH_SESSION_NOT_FOUND',
    );
  });

  it('a malformed cash event is a problem, not a crash', () => {
    const base = { version: 1, branchId: v7(), deviceId: v7(), occurredAt: new Date().toISOString(), entityId: v7() };
    const { ops, problems } = projectEvents([
      { ...base, id: v7(), type: 'cash_session.opened', deviceSeq: 1, payload: { drawerId: 'nope', openingFloat: 1 } },
      { ...base, id: v7(), type: 'cash.moved', deviceSeq: 2, payload: { movementId: v7(), type: 'steal', amount: 1, reason: 'x' } },
    ]);
    expect(ops).toEqual([]);
    expect(problems.map((p) => p.reason)).toEqual([
      'cash_session.opened: payload.drawerId must be a uuid',
      'cash.moved: payload.type must be in or out',
    ]);
  });
});
