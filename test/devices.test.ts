import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { normalizePairingCode } from '../src/modules/devices/devices.service.js';
import { fakeRepos, publicKey, type FakeDevicesRepo } from './fakes.js';

describe('device pairing', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let devices: FakeDevicesRepo;

  beforeEach(async () => {
    const f = fakeRepos();
    devices = f.devices;
    devices.codes.set('ABCD-EFGH', { role: 'hub', used: false });
    devices.codes.set('POS2-CODE', { role: 'pos', used: false });
    devices.codes.set('OLD1-CODE', { role: 'pos', used: false, expired: true });
    app = await buildApp({ repos: f.repos, logLevel: 'silent' });
  });
  afterEach(() => app.close());

  const pair = (code: string, name = 'Caisse principale') =>
    app.inject({ method: 'POST', url: '/v1/devices/pair', payload: { code, name, publicKey } });

  it('pairs a device and returns a token once', async () => {
    const res = await pair('abcd efgh'); // lowercase + space are accepted
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ deviceCode: 'T1', role: 'hub' });
    expect(body.token).toHaveLength(43);
    // Only the hash is stored
    expect(devices.devices[0]!.tokenHash).not.toBe(body.token);
  });

  it('numbers devices T1, T2…', async () => {
    await pair('ABCD-EFGH');
    const second = (await pair('POS2-CODE', 'Tablette terrasse')).json();
    expect(second).toMatchObject({ deviceCode: 'T2', role: 'pos' });
  });

  it('a code works only once', async () => {
    await pair('ABCD-EFGH');
    const again = await pair('ABCD-EFGH');
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('PAIRING_CODE_INVALID');
  });

  it('expired or unknown codes are refused', async () => {
    expect((await pair('OLD1-CODE')).json().error.code).toBe('PAIRING_CODE_INVALID');
    expect((await pair('ZZZZ-ZZZZ')).json().error.code).toBe('PAIRING_CODE_INVALID');
  });

  it('rejects a malformed public key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/pair',
      payload: { code: 'ABCD-EFGH', name: 'x', publicKey: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /v1/devices/me works with the token, fails without', async () => {
    const { token, deviceId } = (await pair('ABCD-EFGH')).json();

    const ok = await app.inject({ url: '/v1/devices/me', headers: { authorization: `Device ${token}` } });
    expect(ok.json().deviceId).toBe(deviceId);

    const noAuth = await app.inject({ url: '/v1/devices/me' });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.json().error.code).toBe('UNAUTHORIZED');

    const wrong = await app.inject({ url: '/v1/devices/me', headers: { authorization: 'Device nope' } });
    expect(wrong.statusCode).toBe(401);
  });

  it('a disabled device is locked out', async () => {
    const { token } = (await pair('ABCD-EFGH')).json();
    devices.devices[0]!.disabled = true;
    const res = await app.inject({ url: '/v1/devices/me', headers: { authorization: `Device ${token}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('DEVICE_DISABLED');
  });
});

describe('normalizePairingCode', () => {
  it.each([
    ['k7q2-m9xd', 'K7Q2-M9XD'],
    ['K7Q2 M9XD', 'K7Q2-M9XD'],
    ['k7q2m9xd', 'K7Q2-M9XD'],
  ])('%s → %s', (input, expected) => expect(normalizePairingCode(input)).toBe(expected));
});
