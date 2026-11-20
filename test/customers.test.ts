import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { CustomerTokenService } from '../src/shared/tokens.js';
import { buildTestApp, fakeRepos, testAuthConfig, type FakeCustomersRepo } from './fakes.js';

type App = Awaited<ReturnType<typeof buildApp>>;

/** Customer accounts of the loyalty app: separate from owner accounts. */
describe('customer accounts', () => {
  let app: App;
  let customers: FakeCustomersRepo;

  beforeEach(async () => {
    const f = fakeRepos();
    customers = f.customers;
    app = await buildTestApp(f.repos);
  });
  afterEach(() => app.close());

  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const signup = (email = 'Leila@Example.com', password = 'un mot de passe') =>
    post('/v1/customer/auth/signup', { email, password, name: ' Leila ' });

  it('signs up (email lowercased, name trimmed), logs in, reads /me', async () => {
    const s = await signup();
    expect(s.statusCode).toBe(200);
    expect(s.json().customer).toMatchObject({ email: 'leila@example.com', name: 'Leila' });

    const l = await post('/v1/customer/auth/login', { email: 'LEILA@example.com', password: 'un mot de passe' });
    expect(l.statusCode).toBe(200);
    const me = await app.inject({ url: '/v1/customer/me', headers: { authorization: `Bearer ${l.json().accessToken}` } });
    expect(me.json()).toEqual({ id: s.json().customer.id, email: 'leila@example.com', name: 'Leila' });
  });

  it('same email twice → 409; wrong password and unknown email give the same answer', async () => {
    await signup();
    expect((await signup('leila@example.com')).statusCode).toBe(409);
    const wrong = await post('/v1/customer/auth/login', { email: 'leila@example.com', password: 'pas le bon' });
    const unknown = await post('/v1/customer/auth/login', { email: 'nobody@example.com', password: 'pas le bon' });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it('short password refused', async () => {
    expect((await signup('a@example.com', 'court')).statusCode).toBe(400);
  });

  it('refresh rotates; reusing an old refresh token closes every session', async () => {
    const first = (await signup()).json().refreshToken;
    const r = await post('/v1/customer/auth/refresh', { refreshToken: first });
    expect(r.statusCode).toBe(200);
    const second = r.json().refreshToken;
    expect(second).not.toBe(first);

    expect((await post('/v1/customer/auth/refresh', { refreshToken: first })).statusCode).toBe(401);
    // The stolen-token alarm also revoked the new one.
    expect((await post('/v1/customer/auth/refresh', { refreshToken: second })).statusCode).toBe(401);
  });

  it('logout revokes the refresh token', async () => {
    const t = (await signup()).json().refreshToken;
    await post('/v1/customer/auth/logout', { refreshToken: t });
    expect((await post('/v1/customer/auth/refresh', { refreshToken: t })).statusCode).toBe(401);
  });

  it('an owner token does not open the customer app, and a customer token does not open the owner area', async () => {
    const owner = (
      await post('/v1/auth/signup', { email: 'o@example.com', password: 'correct horse battery', name: 'Owner', businessName: 'Café' })
    ).json();
    const asOwner = await app.inject({ url: '/v1/customer/me', headers: { authorization: `Bearer ${owner.accessToken}` } });
    expect(asOwner.statusCode).toBe(401);

    const customer = (await signup()).json();
    const asCustomer = await app.inject({
      url: `/v1/owner/branches/${owner.branches[0].id}/business`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
    });
    expect(asCustomer.statusCode).toBe(401);

    // A token signed with the right secret but for a customer that doesn't exist.
    const ghost = new CustomerTokenService(testAuthConfig.jwtSecret, 900).signAccess({ sub: '00000000-0000-7000-8000-000000000000' });
    expect((await app.inject({ url: '/v1/customer/me', headers: { authorization: `Bearer ${ghost}` } })).statusCode).toBe(401);
  });
});
