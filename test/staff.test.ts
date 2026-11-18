import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { hashPin, isValidPin, verifyPin } from '../src/shared/pin.js';
import { TokenService } from '../src/shared/tokens.js';
import { buildTestApp, fakeRepos, publicKey, testAuthConfig, type FakeAuthRepo, type FakeStaffRepo } from './fakes.js';

type App = Awaited<ReturnType<typeof buildApp>>;

describe('PIN hashing', () => {
  it('shared test vector — the Dart POS must produce exactly this', () => {
    const h = hashPin('1234', Buffer.from('kahwti-test-salt'), 1000);
    expect(h).toBe('pbkdf2-sha256$1000$a2Fod3RpLXRlc3Qtc2FsdA$I4Uu_ofD4UQbzJa60p4IWhObH52R4TW-SLj5lfbAnFU');
  });
  it('verify right / wrong PIN, random salt each time', () => {
    const a = hashPin('4821');
    expect(verifyPin('4821', a)).toBe(true);
    expect(verifyPin('4822', a)).toBe(false);
    expect(hashPin('4821')).not.toBe(a);
    expect(verifyPin('4821', 'garbage')).toBe(false);
  });
  it.each([
    ['1234', true],
    ['123456', true],
    ['123', false],
    ['1234567', false],
    ['12a4', false],
  ])('isValidPin(%s) = %s', (pin, ok) => expect(isValidPin(pin)).toBe(ok));
});

describe('owner: staff', () => {
  let app: App;
  let auth: FakeAuthRepo;
  let staff: FakeStaffRepo;
  let token: string;
  let branchId: string;

  beforeEach(async () => {
    const f = fakeRepos();
    auth = f.auth;
    staff = f.staff;
    app = await buildTestApp(f.repos);
    const s = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'o@example.com', password: 'correct horse battery', name: 'Owner', businessName: 'Café' },
      })
    ).json();
    token = s.accessToken;
    branchId = s.branches[0].id;
  });
  afterEach(() => app.close());

  const req = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, t = token) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, ...(payload && { payload }) });

  it('create, list, rename, change PIN, deactivate — the PIN hash is never returned', async () => {
    const ahmed = (await req('POST', `/v1/owner/branches/${branchId}/staff`, { name: ' Ahmed ', role: 'server', pin: '4821' })).json();
    expect(ahmed).toEqual({ id: expect.any(String), name: 'Ahmed', role: 'server', active: true });
    expect(JSON.stringify(ahmed)).not.toContain('pbkdf2');
    expect(verifyPin('4821', staff.rows[0]!.pinHash)).toBe(true);

    const list = (await req('GET', `/v1/owner/branches/${branchId}/staff`)).json();
    expect(list).toEqual([ahmed]);

    await req('PATCH', `/v1/owner/staff/${ahmed.id}`, { pin: '9090', name: 'Ahmed B.' });
    expect(verifyPin('9090', staff.rows[0]!.pinHash)).toBe(true);
    expect(verifyPin('4821', staff.rows[0]!.pinHash)).toBe(false);

    const off = (await req('PATCH', `/v1/owner/staff/${ahmed.id}`, { active: false })).json();
    expect(off).toMatchObject({ name: 'Ahmed B.', active: false });
  });

  it('PIN must be 4–6 digits', async () => {
    for (const pin of ['12', '1234567', 'abcd']) {
      const r = await req('POST', `/v1/owner/branches/${branchId}/staff`, { name: 'X', role: 'cashier', pin });
      expect(r.json().error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('a manager cannot manage staff; another owner gets 404', async () => {
    const owner = auth.users[0]!;
    auth.users.push({ ...owner, id: 'm1', email: 'm@example.com', role: 'manager' });
    const manager = new TokenService(testAuthConfig.jwtSecret, 900).signAccess({ sub: 'm1', tenantId: owner.tenantId, role: 'manager' });
    expect((await req('POST', `/v1/owner/branches/${branchId}/staff`, { name: 'X', role: 'cashier', pin: '1111' }, manager)).statusCode).toBe(403);

    const other = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'x@example.com', password: 'correct horse battery', name: 'X', businessName: 'Other' },
      })
    ).json();
    expect((await req('GET', `/v1/owner/branches/${branchId}/staff`, undefined, other.accessToken)).statusCode).toBe(404);
  });

  it('the POS receives staff with the PIN hash; deactivation reaches it on the next pull', async () => {
    const ahmed = (await req('POST', `/v1/owner/branches/${branchId}/staff`, { name: 'Ahmed', role: 'server', pin: '4821' })).json();
    await req('POST', `/v1/owner/branches/${branchId}/staff`, { name: 'Leila', role: 'cashier', pin: '1357' });

    const { code } = (await req('POST', `/v1/owner/branches/${branchId}/pairing-codes`, { role: 'hub' })).json();
    const pos = (await app.inject({ method: 'POST', url: '/v1/devices/pair', payload: { code, name: 'Caisse', publicKey } })).json();
    const pull = async (cursor?: string) =>
      (
        await app.inject({
          url: `/v1/sync/pull${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
          headers: { authorization: `Device ${pos.token}` },
        })
      ).json();

    const first = await pull();
    expect(first.staff.map((s: { name: string }) => s.name).sort()).toEqual(['Ahmed', 'Leila']);
    const a = first.staff.find((s: { name: string }) => s.name === 'Ahmed');
    expect(verifyPin('4821', a.pinHash)).toBe(true); // the POS can check offline

    await new Promise((r) => setTimeout(r, 5));
    await req('PATCH', `/v1/owner/staff/${ahmed.id}`, { active: false });
    const next = await pull(first.cursor);
    expect(next.staff).toEqual([expect.objectContaining({ name: 'Ahmed', active: false })]);
  });
});
