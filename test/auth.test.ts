import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { Argon2Hasher } from '../src/shared/passwords.js';
import { TokenService } from '../src/shared/tokens.js';
import { buildTestApp, fakeRepos, testAuthConfig, type FakeAuthRepo } from './fakes.js';

const signupBody = {
  email: 'Sami@Example.com', // stored lowercase
  password: 'correct horse battery',
  name: 'Sami',
  businessName: 'Café Le Jasmin',
  taxId: '1234567/A/M/000',
};

describe('owner auth', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let auth: FakeAuthRepo;

  beforeEach(async () => {
    const f = fakeRepos();
    auth = f.auth;
    app = await buildTestApp(f.repos, { passwordHasher: new Argon2Hasher() }); // real hashing here
  });
  afterEach(() => app.close());

  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const signup = (body: object = signupBody) => post('/v1/auth/signup', body);

  it('signup creates business + first branch + owner, and logs in', async () => {
    const res = await signup();
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.user).toMatchObject({ email: 'sami@example.com', name: 'Sami', role: 'owner' });
    expect(body.tenant).toMatchObject({ name: 'Café Le Jasmin', taxId: '1234567/A/M/000' });
    expect(body.branches).toEqual([{ id: expect.any(String), name: 'Café Le Jasmin', type: 'cafe' }]);
    expect(body.accessToken.split('.')).toHaveLength(3); // JWT
    expect(body.expiresIn).toBe(15 * 60);
    expect(body.refreshToken.length).toBeGreaterThan(30);

    // Password and refresh token are never stored in clear
    expect(auth.users[0]!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(auth.tokens[0]!.tokenHash).not.toBe(body.refreshToken);
  });

  it('same email twice (any case) → EMAIL_TAKEN', async () => {
    await signup();
    const again = await signup({ ...signupBody, email: 'SAMI@example.com' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('EMAIL_TAKEN');
  });

  it('weak password or bad email → VALIDATION_ERROR', async () => {
    expect((await signup({ ...signupBody, password: 'short' })).json().error.code).toBe('VALIDATION_ERROR');
    expect((await signup({ ...signupBody, email: 'not-an-email' })).json().error.code).toBe('VALIDATION_ERROR');
  });

  it('login works with the right password; same error for wrong password and unknown email', async () => {
    await signup();

    const ok = await post('/v1/auth/login', { email: 'sami@example.com', password: signupBody.password });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().tenant.name).toBe('Café Le Jasmin');

    const wrong = await post('/v1/auth/login', { email: 'sami@example.com', password: 'wrong password!!' });
    const unknown = await post('/v1/auth/login', { email: 'nobody@example.com', password: 'whatever123' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json()); // no hint whether the email exists
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('GET /v1/auth/me needs a valid access token', async () => {
    const { accessToken } = (await signup()).json();

    const me = await app.inject({ url: '/v1/auth/me', headers: { authorization: `Bearer ${accessToken}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('sami@example.com');

    expect((await app.inject({ url: '/v1/auth/me' })).statusCode).toBe(401);
    const forged = await app.inject({ url: '/v1/auth/me', headers: { authorization: `Bearer ${accessToken}x` } });
    expect(forged.json().error.code).toBe('TOKEN_EXPIRED');
  });

  it('a token signed with another secret is refused', async () => {
    await signup();
    const evil = new TokenService('another-secret-another-secret-123456', 900).signAccess({
      sub: auth.users[0]!.id,
      tenantId: auth.users[0]!.tenantId,
      role: 'owner',
    });
    const res = await app.inject({ url: '/v1/auth/me', headers: { authorization: `Bearer ${evil}` } });
    expect(res.statusCode).toBe(401);
  });

  it('an expired access token is refused', async () => {
    await signup();
    const expired = new TokenService(testAuthConfig.jwtSecret, -1).signAccess({
      sub: auth.users[0]!.id,
      tenantId: auth.users[0]!.tenantId,
      role: 'owner',
    });
    const res = await app.inject({ url: '/v1/auth/me', headers: { authorization: `Bearer ${expired}` } });
    expect(res.json().error.code).toBe('TOKEN_EXPIRED');
  });

  it('refresh rotates tokens; reusing an old refresh token closes every session', async () => {
    const first = (await signup()).json();

    const second = await post('/v1/auth/refresh', { refreshToken: first.refreshToken });
    expect(second.statusCode).toBe(200);
    const fresh = second.json();
    expect(fresh.refreshToken).not.toBe(first.refreshToken);

    // Attacker replays the old token → refused, and the fresh one is revoked too.
    expect((await post('/v1/auth/refresh', { refreshToken: first.refreshToken })).statusCode).toBe(401);
    expect((await post('/v1/auth/refresh', { refreshToken: fresh.refreshToken })).statusCode).toBe(401);
  });

  it('logout revokes the refresh token', async () => {
    const { refreshToken } = (await signup()).json();
    expect((await post('/v1/auth/logout', { refreshToken })).json()).toEqual({ ok: true });
    expect((await post('/v1/auth/refresh', { refreshToken })).statusCode).toBe(401);
  });

  it('login is rate limited (10 per minute per IP)', async () => {
    const tries = [];
    for (let i = 0; i < 11; i++) {
      tries.push(await post('/v1/auth/login', { email: 'x@example.com', password: 'wrong-password' }));
    }
    expect(tries[9]!.statusCode).toBe(401);
    expect(tries[10]!.statusCode).toBe(429);
    expect(tries[10]!.json().error.code).toBe('TOO_MANY_REQUESTS');
  });
});
