import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { TokenService } from '../src/shared/tokens.js';
import { buildTestApp, fakeRepos, publicKey, testAuthConfig, type FakeAuthRepo } from './fakes.js';

type App = Awaited<ReturnType<typeof buildApp>>;

/** The café's details printed on receipts. */
describe('business details (receipt header/footer)', () => {
  let app: App;
  let auth: FakeAuthRepo;
  let token: string;
  let branchId: string;

  beforeEach(async () => {
    const f = fakeRepos();
    auth = f.auth;
    app = await buildTestApp(f.repos);
    const s = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'o@example.com', password: 'correct horse battery', name: 'Owner', businessName: "Sami's Coffe" },
      })
    ).json();
    token = s.accessToken;
    branchId = s.branches[0].id;
  });
  afterEach(() => app.close());

  const req = (method: 'GET' | 'PATCH', payload?: object, t = token) =>
    app.inject({
      method,
      url: `/v1/owner/branches/${branchId}/business`,
      headers: { authorization: `Bearer ${t}` },
      ...(payload && { payload }),
    });

  it('owner sets name, fiscal ID, address, phone, footer (trimmed; empty = removed); the POS reads them', async () => {
    expect((await req('GET')).json()).toMatchObject({ businessName: "Sami's Coffe", taxId: null, address: null });

    const updated = (
      await req('PATCH', {
        businessName: " Sami's Coffee ",
        taxId: '1234567/A/M/000',
        address: 'Rue de Marseille, Tunis',
        phone: '71 000 000',
        receiptFooter: 'Merci et à bientôt !',
      })
    ).json();
    expect(updated).toEqual({
      businessName: "Sami's Coffee",
      taxId: '1234567/A/M/000',
      branchName: "Sami's Coffe",
      address: 'Rue de Marseille, Tunis',
      phone: '71 000 000',
      receiptFooter: 'Merci et à bientôt !',
    });
    expect((await req('PATCH', { phone: '  ' })).json().phone).toBeNull();

    const { code } = (
      await app.inject({
        method: 'POST',
        url: `/v1/owner/branches/${branchId}/pairing-codes`,
        headers: { authorization: `Bearer ${token}` },
        payload: { role: 'hub' },
      })
    ).json();
    const pos = (await app.inject({ method: 'POST', url: '/v1/devices/pair', payload: { code, name: 'Caisse', publicKey } })).json();
    const forPos = (await app.inject({ url: '/v1/devices/business', headers: { authorization: `Device ${pos.token}` } })).json();
    expect(forPos).toMatchObject({ businessName: "Sami's Coffee", taxId: '1234567/A/M/000', receiptFooter: 'Merci et à bientôt !' });
  });

  it('only the owner edits; another business sees nothing', async () => {
    const o = auth.users[0]!;
    const manager = new TokenService(testAuthConfig.jwtSecret, 900).signAccess({ sub: o.id, tenantId: o.tenantId, role: 'manager' });
    expect((await req('PATCH', { phone: '1' }, manager)).statusCode).toBe(403);
    expect((await req('GET', undefined, manager)).statusCode).toBe(200); // managers can read

    const other = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'x@example.com', password: 'correct horse battery', name: 'X', businessName: 'Autre' },
      })
    ).json();
    expect((await req('GET', undefined, other.accessToken)).json().error.code).toBe('BRANCH_NOT_FOUND');
    expect((await req('PATCH', { phone: '1' }, other.accessToken)).json().error.code).toBe('BRANCH_NOT_FOUND');
  });
});
