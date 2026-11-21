import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import type { buildApp } from '../src/app.js';
import { DailySummaryService } from '../src/modules/mail/daily-summary.js';
import { MemoryMailer } from '../src/modules/mail/mailer.js';
import { dailySummaryEmail, resetPasswordEmail } from '../src/modules/mail/templates.js';
import { SalesService, todayInTunis } from '../src/modules/sales/sales.service.js';
import { StockService } from '../src/modules/stock/stock.js';
import type { SyncEvent } from '../src/modules/sync/sync.schema.js';
import { buildTestApp, fakeRepos, publicKey } from './fakes.js';

type App = Awaited<ReturnType<typeof buildApp>>;
type Fakes = ReturnType<typeof fakeRepos>;

const tokenFrom = (text: string) => decodeURIComponent(/token=([^\s"&]+)/.exec(text)![1]!);

describe('mot de passe oublié', () => {
  let app: App;
  let f: Fakes;
  let mailer: MemoryMailer;
  const settle = () => app.services.passwordResets.settled();
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });

  beforeEach(async () => {
    f = fakeRepos();
    mailer = new MemoryMailer();
    app = await buildTestApp(f.repos, { mailer });
  });
  afterEach(() => app.close());

  it('owner: email with a one-time link → new password works, old one and old sessions do not', async () => {
    const s = (
      await post('/v1/auth/signup', { email: 'sami@example.com', password: 'ancien mot de passe', name: 'Sami', businessName: 'Café' })
    ).json();

    const r = await post('/v1/auth/password/forgot', { email: ' SAMI@example.com ' });
    expect(r.json()).toEqual({ ok: true });
    await settle();
    const mail = mailer.sent.single();
    expect(mail).toMatchObject({ to: 'sami@example.com', toName: 'Sami', subject: 'Réinitialiser votre mot de passe Kahwti' });
    expect(mail.text).toContain('https://kahwti.test/reset-password?token=');
    expect(mail.html).toContain('https://kahwti.test/reset-password?token=');
    const token = tokenFrom(mail.text);

    expect((await post('/v1/auth/password/reset', { token, password: 'court' })).statusCode).toBe(400);
    expect((await post('/v1/auth/password/reset', { token, password: 'un nouveau mot de passe' })).json()).toEqual({ ok: true });

    expect((await post('/v1/auth/login', { email: 'sami@example.com', password: 'ancien mot de passe' })).statusCode).toBe(401);
    expect((await post('/v1/auth/login', { email: 'sami@example.com', password: 'un nouveau mot de passe' })).statusCode).toBe(200);
    // Sessions opened before (maybe by someone else) are closed.
    expect((await post('/v1/auth/refresh', { refreshToken: s.refreshToken })).statusCode).toBe(401);

    const again = await post('/v1/auth/password/reset', { token, password: 'encore un autre mot de passe' });
    expect(again.json().error.code).toBe('RESET_LINK_INVALID');
  });

  it('unknown email: same answer, no email; an expired link does not work', async () => {
    expect((await post('/v1/auth/password/forgot', { email: 'personne@example.com' })).json()).toEqual({ ok: true });
    await settle();
    expect(mailer.sent).toEqual([]);

    await post('/v1/auth/signup', { email: 'sami@example.com', password: 'ancien mot de passe', name: 'Sami', businessName: 'Café' });
    await post('/v1/auth/password/forgot', { email: 'sami@example.com' });
    await settle();
    f.passwordResets.links[0]!.expiresAt = new Date(Date.now() - 1000);
    const r = await post('/v1/auth/password/reset', { token: tokenFrom(mailer.sent[0]!.text), password: 'un nouveau mot de passe' });
    expect(r.json().error.code).toBe('RESET_LINK_INVALID');
  });

  it('customer: own link to the customer app; an owner link does not reset a customer and vice versa', async () => {
    await post('/v1/customer/auth/signup', { email: 'leila@example.com', password: 'un mot de passe', name: 'Leila' });
    await post('/v1/customer/auth/password/forgot', { email: 'leila@example.com' });
    await settle();
    const mail = mailer.sent.single();
    expect(mail.text).toContain('https://kahwti.test/app/reset-password?token=');
    const token = tokenFrom(mail.text);

    expect((await post('/v1/auth/password/reset', { token, password: 'un nouveau mot de passe' })).json().error.code).toBe('RESET_LINK_INVALID');
    expect((await post('/v1/customer/auth/password/reset', { token, password: 'nouveau mdp' })).json()).toEqual({ ok: true });
    expect((await post('/v1/customer/auth/login', { email: 'leila@example.com', password: 'nouveau mdp' })).statusCode).toBe(200);
  });

  it('a failing email provider does not change the answer', async () => {
    await post('/v1/auth/signup', { email: 'sami@example.com', password: 'ancien mot de passe', name: 'Sami', businessName: 'Café' });
    mailer.failWith = new Error('Brevo down');
    expect((await post('/v1/auth/password/forgot', { email: 'sami@example.com' })).json()).toEqual({ ok: true });
    await settle();
  });

  it('names from users are escaped in the email', () => {
    const e = resetPasswordEmail({ to: 'a@b.c', name: '<script>x</script>', link: 'https://k.test/r?token=a&b', minutes: 60 });
    expect(e.html).not.toContain('<script>');
    expect(e.html).toContain('&lt;script&gt;');
    expect(e.html).toContain('token=a&amp;b');
  });
});

describe('résumé du matin', () => {
  let app: App;
  let f: Fakes;
  let mailer: MemoryMailer;
  let owner: { token: string; branchId: string; userId: string };
  let pos: { token: string; deviceId: string };
  let seq = 0;
  const today = todayInTunis(new Date());
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const at = (hourTunis: number, day = today) => new Date(Date.parse(`${day}T00:00:00Z`) + (hourTunis - 1) * 3600_000);

  const service = (clock: Date) =>
    new DailySummaryService(
      f.repos.dailySummary,
      new SalesService(f.repos.sales),
      new StockService(f.repos.stock),
      mailer,
      'https://kahwti.test',
      () => {},
      () => clock,
    );

  const ev = (type: string, entityId: string, payload: Record<string, unknown>, when: Date): SyncEvent => ({
    id: v7(),
    type,
    version: 1,
    branchId: owner.branchId,
    deviceId: pos.deviceId,
    entityId,
    deviceSeq: ++seq,
    occurredAt: when.toISOString(),
    payload,
  });
  async function sell(total: number, when: Date, status: 'paid' | 'cancelled' = 'paid') {
    const o = v7();
    const events = [
      ev('order.opened', o, { type: 'takeaway' }, when),
      ev('order.item_added', o, { lineId: v7(), productId: 'p', name: 'Cappuccino', unitPrice: total, qty: 1, vatRateBp: 1900, modifiers: [] }, when),
    ];
    events.push(
      ...(status === 'paid'
        ? [
            ev('payment.added', o, { paymentId: v7(), method: 'cash', amount: total, tendered: total, change: 0 }, when),
            ev('order.closed', o, { receiptNumber: `T1-${seq}`, total, itemCount: 1, vat: [] }, when),
          ]
        : [ev('order.cancelled', o, { reason: 'cancelled_by_staff' }, when)]),
    );
    await app.inject({ method: 'POST', url: '/v1/sync/push', headers: { authorization: `Device ${pos.token}` }, payload: { events } });
  }

  beforeEach(async () => {
    f = fakeRepos();
    mailer = new MemoryMailer();
    app = await buildTestApp(f.repos, { mailer });
    const s = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'sami@example.com', password: 'correct horse battery', name: 'Sami', businessName: 'Kahwet Sami' },
      })
    ).json();
    owner = { token: s.accessToken, branchId: s.branches[0].id, userId: s.user.id };
    const { code } = (
      await app.inject({
        method: 'POST',
        url: `/v1/owner/branches/${owner.branchId}/pairing-codes`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { role: 'hub' },
      })
    ).json();
    pos = (await app.inject({ method: 'POST', url: '/v1/devices/pair', payload: { code, name: 'Caisse', publicKey } })).json();
    seq = 0;
  });
  afterEach(() => app.close());

  it('at 07:00 the owner gets yesterday: revenue, tickets, top products, what to check — once', async () => {
    await sell(3500, at(10, yesterday));
    await sell(4500, at(15, yesterday));
    await sell(2000, at(16, yesterday), 'cancelled');
    await sell(9999, at(11, today)); // today: not in yesterday's summary
    f.dailySummary.gaps.push({ branchId: owner.branchId, drawer: 'T1', difference: -2500, closedAt: at(22, yesterday) });
    await app.inject({
      method: 'POST',
      url: `/v1/owner/branches/${owner.branchId}/stock/items`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: 'Lait', unit: 'ml', quantity: 500, lowThreshold: 1000 },
    });

    expect(await service(at(6)).run()).toBe(0); // too early
    expect(await service(at(9)).run()).toBe(1);
    const mail = mailer.sent.single();
    expect(mail.to).toBe('sami@example.com');
    expect(mail.subject).toMatch(/^Kahwet Sami · .+ : 8\.000 DT, 2 tickets$/);
    for (const s of ['Chiffre d\'affaires : 8.000 DT', 'Panier moyen : 4.000 DT', 'Cappuccino x 2', '1 ticket annulé', 'Écart de caisse T1 : -2.500 DT', 'Stock bas : Lait'])
      expect(mail.text).toContain(s);
    expect(mail.text).toContain(`https://kahwti.test/owner/dashboard?date=${yesterday}`);

    expect(await service(at(9)).run()).toBe(0); // already sent today
    expect(await service(at(18)).run()).toBe(0);
  });

  it('a quiet day sends nothing; an owner who turned it off gets nothing', async () => {
    expect(await service(at(9)).run()).toBe(0);
    await sell(3500, at(10, yesterday));

    const prefs = (method: 'GET' | 'PUT', payload?: object) =>
      app.inject({ method, url: '/v1/owner/me/preferences', headers: { authorization: `Bearer ${owner.token}` }, ...(payload && { payload }) });
    expect((await prefs('GET')).json()).toEqual({ dailyEmail: true });
    expect((await prefs('PUT', { dailyEmail: false })).json()).toEqual({ dailyEmail: false });
    f.dailySummary.sentFor.clear();
    expect(await service(at(9)).run()).toBe(0);
    expect(mailer.sent).toEqual([]);
  });

  it('a calm day reads "Rien à signaler"', () => {
    const e = dailySummaryEmail({
      ownerName: 'Sami',
      to: 'a@b.c',
      cafeName: 'Café',
      dayLabel: 'mardi 18 novembre',
      revenue: 120_000,
      tickets: 30,
      averageTicket: 4000,
      topProducts: [],
      cancelled: 0,
      refunds: { count: 0, amount: 0 },
      discounts: 0,
      cashGaps: [],
      lowStock: [],
      dashboardUrl: 'https://k.test/d',
      settingsUrl: 'https://k.test/s',
    });
    expect(e.text).toContain('Rien à signaler.');
    expect(e.html).toContain('Ne plus le recevoir');
  });
});

declare global {
  interface Array<T> {
    single(): T;
  }
}
Array.prototype.single = function <T>(this: T[]) {
  expect(this).toHaveLength(1);
  return this[0]!;
};
