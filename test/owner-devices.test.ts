import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { TokenService } from '../src/shared/tokens.js';
import { buildTestApp, fakeRepos, publicKey, testAuthConfig, type FakeAuthRepo, type FakeDevicesRepo } from './fakes.js';

type App = Awaited<ReturnType<typeof buildApp>>;

async function signup(app: App, email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: 'correct horse battery', name: 'Owner', businessName: `Café of ${email}` },
  });
  const body = res.json();
  return { token: body.accessToken as string, branchId: body.branches[0].id as string, tenantId: body.tenant.id as string };
}

describe('owner: devices', () => {
  let app: App;
  let devices: FakeDevicesRepo;
  let auth: FakeAuthRepo;
  let owner: Awaited<ReturnType<typeof signup>>;

  beforeEach(async () => {
    const f = fakeRepos();
    devices = f.devices;
    auth = f.auth;
    app = await buildTestApp(f.repos);
    owner = await signup(app, 'owner@example.com');
  });
  afterEach(() => app.close());

  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  const createCode = (role = 'hub', token = owner.token, branchId = owner.branchId) =>
    app.inject({ method: 'POST', url: `/v1/owner/branches/${branchId}/pairing-codes`, headers: as(token), payload: { role } });

  const pairPos = (code: string, name = 'Caisse principale') =>
    app.inject({ method: 'POST', url: '/v1/devices/pair', payload: { code, name, publicKey } });

  it('owner creates a pairing code → a POS pairs with it → shows in the device list', async () => {
    const codeRes = await createCode('hub');
    expect(codeRes.statusCode).toBe(200);
    const { code, role, expiresAt } = codeRes.json();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(role).toBe('hub');
    const minutes = (new Date(expiresAt).getTime() - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);

    // Listed as active until used
    const active = await app.inject({ url: `/v1/owner/branches/${owner.branchId}/pairing-codes`, headers: as(owner.token) });
    expect(active.json().map((c: { code: string }) => c.code)).toEqual([code]);

    const paired = (await pairPos(code)).json();
    expect(paired).toMatchObject({ deviceCode: 'T1', role: 'hub', branchId: owner.branchId, tenantId: owner.tenantId });

    const list = await app.inject({ url: `/v1/owner/branches/${owner.branchId}/devices`, headers: as(owner.token) });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([
      expect.objectContaining({ code: 'T1', name: 'Caisse principale', role: 'hub', disabled: false, online: false, lastSeenAt: null }),
    ]);

    // Code is used → no longer active
    const after = await app.inject({ url: `/v1/owner/branches/${owner.branchId}/pairing-codes`, headers: as(owner.token) });
    expect(after.json()).toEqual([]);
  });

  it('device shows online after it syncs', async () => {
    const { code } = (await createCode()).json();
    const { token } = (await pairPos(code)).json();

    await app.inject({ url: '/v1/sync/pull', headers: { authorization: `Device ${token}` } });

    const [d] = (await app.inject({ url: `/v1/owner/branches/${owner.branchId}/devices`, headers: as(owner.token) })).json();
    expect(d.online).toBe(true);
    expect(d.lastSeenAt).not.toBeNull();
  });

  it('disabling a device locks the POS out; re-enabling lets it back in', async () => {
    const { code } = (await createCode('pos')).json();
    const pos = (await pairPos(code, 'Tablette terrasse')).json();
    const posAuth = { authorization: `Device ${pos.token}` };

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/v1/owner/devices/${pos.deviceId}`,
      headers: as(owner.token),
      payload: { disabled: true },
    });
    expect(disabled.json()).toMatchObject({ disabled: true, online: false });

    const blocked = await app.inject({ url: '/v1/sync/pull', headers: posAuth });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('DEVICE_DISABLED');

    await app.inject({ method: 'PATCH', url: `/v1/owner/devices/${pos.deviceId}`, headers: as(owner.token), payload: { disabled: false } });
    expect((await app.inject({ url: '/v1/sync/pull', headers: posAuth })).statusCode).toBe(200);
  });

  it('rename a device', async () => {
    const { code } = (await createCode()).json();
    const { deviceId } = (await pairPos(code)).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/owner/devices/${deviceId}`,
      headers: as(owner.token),
      payload: { name: '  Comptoir  ' },
    });
    expect(res.json().name).toBe('Comptoir');
  });

  it('an empty update is refused', async () => {
    const { code } = (await createCode()).json();
    const { deviceId } = (await pairPos(code)).json();
    const res = await app.inject({ method: 'PATCH', url: `/v1/owner/devices/${deviceId}`, headers: as(owner.token), payload: {} });
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it("another owner can't see or touch my café's devices", async () => {
    const { code } = (await createCode()).json();
    const { deviceId } = (await pairPos(code)).json();
    const other = await signup(app, 'other@example.com');

    const list = await app.inject({ url: `/v1/owner/branches/${owner.branchId}/devices`, headers: as(other.token) });
    expect(list.statusCode).toBe(404);
    expect(list.json().error.code).toBe('BRANCH_NOT_FOUND');

    expect((await createCode('pos', other.token, owner.branchId)).json().error.code).toBe('BRANCH_NOT_FOUND');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/owner/devices/${deviceId}`,
      headers: as(other.token),
      payload: { disabled: true },
    });
    expect(patch.statusCode).toBe(404);
    expect(devices.devices[0]!.disabled).toBe(false);
  });

  it('a manager can list devices but not pair or disable them', async () => {
    const { code } = (await createCode()).json();
    const { deviceId } = (await pairPos(code)).json();

    const ownerUser = auth.users[0]!;
    auth.users.push({ ...ownerUser, id: 'manager-1', email: 'manager@example.com', role: 'manager' });
    const managerToken = new TokenService(testAuthConfig.jwtSecret, 900).signAccess({
      sub: 'manager-1',
      tenantId: ownerUser.tenantId,
      role: 'manager',
    });

    expect((await app.inject({ url: `/v1/owner/branches/${owner.branchId}/devices`, headers: as(managerToken) })).statusCode).toBe(200);
    expect((await createCode('pos', managerToken)).json().error.code).toBe('FORBIDDEN');
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/owner/devices/${deviceId}`,
      headers: as(managerToken),
      payload: { disabled: true },
    });
    expect(patch.statusCode).toBe(403);
  });

  it('all owner device routes need a login', async () => {
    const res = await app.inject({ url: `/v1/owner/branches/${owner.branchId}/devices` });
    expect(res.statusCode).toBe(401);
    const devToken = await app.inject({
      url: `/v1/owner/branches/${owner.branchId}/devices`,
      headers: { authorization: 'Device something' },
    });
    expect(devToken.statusCode).toBe(401); // a POS token is not an owner token
  });

  it('expired pairing code is refused', async () => {
    const { code } = (await createCode()).json();
    devices.codes.get(code)!.expiresAt = new Date(Date.now() - 1000);
    expect((await pairPos(code)).json().error.code).toBe('PAIRING_CODE_INVALID');
  });
});
