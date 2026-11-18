import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { isPrivateIpv4 } from '../src/modules/devices/devices.service.js';
import { TokenService } from '../src/shared/tokens.js';
import { buildTestApp, fakeRepos, publicKey, testAuthConfig, type FakeAuthRepo } from './fakes.js';

type App = Awaited<ReturnType<typeof buildApp>>;

/** The café network: the Hub reports its address, the other POS find it and sign with the LAN key. */
describe('café local network (Hub)', () => {
  let app: App;
  let auth: FakeAuthRepo;
  let owner: { token: string; branchId: string };
  let hub: { token: string; deviceId: string };
  let tablet: { token: string; deviceId: string };

  beforeEach(async () => {
    const f = fakeRepos();
    auth = f.auth;
    app = await buildTestApp(f.repos);
    const s = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'o@example.com', password: 'correct horse battery', name: 'Owner', businessName: 'Café' },
      })
    ).json();
    owner = { token: s.accessToken, branchId: s.branches[0].id };
    hub = await pair('hub', 'Caisse principale');
    tablet = await pair('pos', 'Tablette serveur');
  });
  afterEach(() => app.close());

  async function pair(role: 'hub' | 'pos', name: string) {
    const { code } = (await ownerReq('POST', `/v1/owner/branches/${owner.branchId}/pairing-codes`, { role })).json();
    return (await app.inject({ method: 'POST', url: '/v1/devices/pair', payload: { code, name, publicKey } })).json();
  }
  const ownerReq = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, token = owner.token) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload && { payload }) });
  const deviceReq = (token: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Device ${token}` }, ...(payload && { payload }) });

  it('the Hub reports its address; the tablet gets it with the LAN key and the devices', async () => {
    const r = await deviceReq(hub.token, 'POST', '/v1/devices/me/lan', {
      addresses: ['192.168.1.20', '8.8.8.8', '10.0.0.5', '192.168.1.20'],
      port: 7700,
    });
    expect(r.json()).toEqual({ ok: true });

    const info = (await deviceReq(tablet.token, 'GET', '/v1/devices/lan')).json();
    // Public addresses are dropped, duplicates removed.
    expect(info.hub).toEqual({ deviceId: hub.deviceId, code: 'T1', addresses: ['192.168.1.20', '10.0.0.5'], port: 7700 });
    expect(info.lanKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(info.devices).toEqual([
      { id: hub.deviceId, code: 'T1', name: 'Caisse principale', role: 'hub', canTakePayments: true, disabled: false },
      { id: tablet.deviceId, code: 'T2', name: 'Tablette serveur', role: 'pos', canTakePayments: false, disabled: false },
    ]);
  });

  it('the LAN key is the same for every device of the café, and stays the same', async () => {
    const a = (await deviceReq(hub.token, 'GET', '/v1/devices/lan')).json().lanKey;
    const b = (await deviceReq(tablet.token, 'GET', '/v1/devices/lan')).json().lanKey;
    const c = (await deviceReq(hub.token, 'GET', '/v1/devices/lan')).json().lanKey;
    expect(new Set([a, b, c]).size).toBe(1);
  });

  it('no Hub in the café → hub is null (each POS works on its own)', async () => {
    await ownerReq('PATCH', `/v1/owner/devices/${hub.deviceId}`, { disabled: true });
    expect((await deviceReq(tablet.token, 'GET', '/v1/devices/lan')).json().hub).toBeNull();
  });

  it('owner allows payments on a tablet; the owner app shows it and the Hub address', async () => {
    await deviceReq(hub.token, 'POST', '/v1/devices/me/lan', { addresses: ['192.168.1.20'], port: 7700 });
    const updated = (await ownerReq('PATCH', `/v1/owner/devices/${tablet.deviceId}`, { canTakePayments: true })).json();
    expect(updated.canTakePayments).toBe(true);

    const list = (await ownerReq('GET', `/v1/owner/branches/${owner.branchId}/devices`)).json();
    expect(list.map((d: { code: string; canTakePayments: boolean; lanAddress: string | null }) => [d.code, d.canTakePayments, d.lanAddress])).toEqual([
      ['T1', true, '192.168.1.20:7700'],
      ['T2', true, null],
    ]);
    const lan = (await deviceReq(hub.token, 'GET', '/v1/devices/lan')).json();
    expect(lan.devices.find((d: { id: string }) => d.id === tablet.deviceId).canTakePayments).toBe(true);
  });

  it('only the owner can change payment rights', async () => {
    const o = auth.users[0]!;
    const manager = new TokenService(testAuthConfig.jwtSecret, 900).signAccess({ sub: o.id, tenantId: o.tenantId, role: 'manager' });
    const r = await ownerReq('PATCH', `/v1/owner/devices/${tablet.deviceId}`, { canTakePayments: true }, manager);
    expect(r.statusCode).toBe(403);
  });

  it('device endpoints need a device token; bad addresses are refused', async () => {
    expect((await app.inject({ url: '/v1/devices/lan' })).statusCode).toBe(401);
    const bad = await deviceReq(hub.token, 'POST', '/v1/devices/me/lan', { addresses: ['not-an-ip'], port: 7700 });
    expect(bad.statusCode).toBe(400);
    const lowPort = await deviceReq(hub.token, 'POST', '/v1/devices/me/lan', { addresses: [], port: 80 });
    expect(lowPort.statusCode).toBe(400);
  });
});

describe('isPrivateIpv4', () => {
  it.each([
    ['192.168.1.20', true],
    ['10.0.0.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['8.8.8.8', false],
    ['127.0.0.1', false],
    ['192.168.1.300', false],
  ])('%s → %s', (ip, ok) => expect(isPrivateIpv4(ip)).toBe(ok));
});
