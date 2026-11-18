import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import type { buildApp } from '../src/app.js';
import { projectEvents } from '../src/modules/sales/sales.projection.js';
import type { SyncEvent } from '../src/modules/sync/sync.schema.js';
import { TokenService } from '../src/shared/tokens.js';
import { buildTestApp, fakeRepos, publicKey, testAuthConfig, type FakeAuthRepo, type FakeSyncRepo } from './fakes.js';

type App = Awaited<ReturnType<typeof buildApp>>;

describe('floor: rooms and tables', () => {
  let app: App;
  let auth: FakeAuthRepo;
  let sync: FakeSyncRepo;
  let token: string;
  let branchId: string;
  let device: string;
  let deviceId: string;
  let seq = 0;

  beforeEach(async () => {
    const f = fakeRepos();
    auth = f.auth;
    sync = f.sync;
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
    const { code } = (await req('POST', `/v1/owner/branches/${branchId}/pairing-codes`, { role: 'hub' })).json();
    const pos = (await app.inject({ method: 'POST', url: '/v1/devices/pair', payload: { code, name: 'Caisse', publicKey } })).json();
    device = `Device ${pos.token}`;
    deviceId = pos.deviceId;
    seq = 0;
  });
  afterEach(() => app.close());

  const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, t = token) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, ...(payload && { payload }) });
  const pull = (cursor?: string) =>
    app.inject({ url: `/v1/sync/pull${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, headers: { authorization: device } });
  const ev = (type: string, entityId: string, payload: Record<string, unknown>): SyncEvent => ({
    id: v7(),
    type,
    version: 1,
    branchId,
    deviceId,
    entityId,
    deviceSeq: ++seq,
    occurredAt: new Date().toISOString(),
    payload,
  });

  async function salle() {
    const area = (await req('POST', `/v1/owner/branches/${branchId}/areas`, { name: ' Salle ' })).json();
    const tables = (
      await req('POST', `/v1/owner/branches/${branchId}/tables`, { areaId: area.id, names: ['1', '2', '3'], seats: 2 })
    ).json();
    return { area, tables };
  }

  it('create a room with tables 1–3 in one call, read the floor plan', async () => {
    const { area, tables } = await salle();
    expect(area).toEqual({ id: expect.any(String), name: 'Salle', sortOrder: 0 });
    expect(tables.map((t: { name: string; seats: number; sortOrder: number }) => [t.name, t.seats, t.sortOrder])).toEqual([
      ['1', 2, 0],
      ['2', 2, 1],
      ['3', 2, 2],
    ]);

    const terrasse = (await req('POST', `/v1/owner/branches/${branchId}/areas`, { name: 'Terrasse' })).json();
    expect(terrasse.sortOrder).toBe(1);
    await req('POST', `/v1/owner/branches/${branchId}/tables`, { areaId: terrasse.id, names: ['T1'] });

    const floor = (await req('GET', `/v1/owner/branches/${branchId}/floor`)).json();
    expect(floor.areas.map((a: { name: string }) => a.name)).toEqual(['Salle', 'Terrasse']);
    expect(floor.tables).toHaveLength(4);
    expect(floor.tables.find((t: { name: string }) => t.name === 'T1')).toMatchObject({ areaId: terrasse.id, seats: 4 });
  });

  it('table names are unique in the branch (case and spaces ignored), also inside one request', async () => {
    const { area, tables } = await salle();
    const dup = await req('POST', `/v1/owner/branches/${branchId}/tables`, { areaId: area.id, names: [' 2 ', '4'] });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('TABLE_NAME_TAKEN');
    expect(dup.json().error.message).toContain('2');

    const twice = await req('POST', `/v1/owner/branches/${branchId}/tables`, { areaId: area.id, names: ['t5', 'T5'] });
    expect(twice.json().error.code).toBe('TABLE_NAME_TAKEN');

    const rename = await req('PATCH', `/v1/owner/tables/${tables[0].id}`, { name: '3' });
    expect(rename.json().error.code).toBe('TABLE_NAME_TAKEN');
    // Same name, other case → allowed (it is the same table).
    expect((await req('PATCH', `/v1/owner/tables/${tables[0].id}`, { name: '1', seats: 6 })).json()).toMatchObject({ seats: 6 });
  });

  it('move a table to another room; a room with tables cannot be deleted', async () => {
    const { area, tables } = await salle();
    const terrasse = (await req('POST', `/v1/owner/branches/${branchId}/areas`, { name: 'Terrasse' })).json();
    const moved = (await req('PATCH', `/v1/owner/tables/${tables[2].id}`, { areaId: terrasse.id })).json();
    expect(moved.areaId).toBe(terrasse.id);

    const refused = await req('DELETE', `/v1/owner/areas/${area.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('AREA_NOT_EMPTY');

    await req('DELETE', `/v1/owner/tables/${tables[0].id}`);
    await req('DELETE', `/v1/owner/tables/${tables[1].id}`);
    expect((await req('DELETE', `/v1/owner/areas/${area.id}`)).json()).toEqual({ ok: true });
    expect((await req('GET', `/v1/owner/branches/${branchId}/floor`)).json().areas.map((a: { name: string }) => a.name)).toEqual([
      'Terrasse',
    ]);
  });

  it('another business cannot see or change my tables', async () => {
    const { area, tables } = await salle();
    const other = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'x@example.com', password: 'correct horse battery', name: 'X', businessName: 'Autre' },
      })
    ).json();
    const t = other.accessToken;
    expect((await req('GET', `/v1/owner/branches/${branchId}/floor`, undefined, t)).json().error.code).toBe('BRANCH_NOT_FOUND');
    expect((await req('PATCH', `/v1/owner/tables/${tables[0].id}`, { name: 'X' }, t)).json().error.code).toBe('TABLE_NOT_FOUND');
    expect((await req('DELETE', `/v1/owner/areas/${area.id}`, undefined, t)).json().error.code).toBe('AREA_NOT_FOUND');
    // Their room cannot receive my tables either.
    const theirArea = (await req('POST', `/v1/owner/branches/${other.branches[0].id}/areas`, { name: 'Leur salle' }, t)).json();
    expect((await req('PATCH', `/v1/owner/tables/${tables[0].id}`, { areaId: theirArea.id })).json().error.code).toBe(
      'AREA_NOT_FOUND',
    );
  });

  it('managers can edit the floor plan (like the menu)', async () => {
    const { area } = await salle();
    const owner = auth.users[0]!;
    const managerToken = new TokenService(testAuthConfig.jwtSecret, 900).signAccess({
      sub: owner.id,
      tenantId: owner.tenantId,
      role: 'manager',
    });
    const r = await req('POST', `/v1/owner/branches/${branchId}/tables`, { areaId: area.id, names: ['9'] }, managerToken);
    expect(r.statusCode).toBe(200);
  });

  it('POS pull: rooms and tables, then only changes (rename, deletion)', async () => {
    const { area, tables } = await salle();
    const first = (await pull()).json();
    expect(first.areas).toEqual([{ id: area.id, name: 'Salle', sortOrder: 0, deleted: false }]);
    expect(first.tables.map((t: { name: string }) => t.name).sort()).toEqual(['1', '2', '3']);

    await new Promise((r) => setTimeout(r, 5));
    await req('PATCH', `/v1/owner/tables/${tables[0].id}`, { name: '1A' });
    await req('DELETE', `/v1/owner/tables/${tables[1].id}`);
    const next = (await pull(first.cursor)).json();
    expect(next.areas).toEqual([]);
    expect(next.tables.map((t: { name: string; deleted: boolean }) => [t.name, t.deleted]).sort()).toEqual([
      ['1A', false],
      ['2', true],
    ]);
  });

  it('tickets on tables: the sales list shows the table, also after a move', async () => {
    const { tables } = await salle();
    const [t1, t2] = tables;
    const order = v7();
    const line = v7();
    const push = await app.inject({
      method: 'POST',
      url: '/v1/sync/push',
      headers: { authorization: device },
      payload: {
        events: [
          ev('order.opened', order, { type: 'table', tableId: t1.id, tableName: '1' }),
          ev('order.item_added', order, { lineId: line, productId: 'p', name: 'Express', unitPrice: 1200, qty: 1, vatRateBp: 1900 }),
        ],
      },
    });
    expect(push.json().accepted).toHaveLength(2);
    const list = () => req('GET', `/v1/owner/branches/${branchId}/sales/orders?status=open`).then((r) => r.json());
    expect((await list())[0]).toMatchObject({ status: 'open', tableName: '1', type: 'table' });

    await app.inject({
      method: 'POST',
      url: '/v1/sync/push',
      headers: { authorization: device },
      payload: { events: [ev('order.table_changed', order, { tableId: t2.id, tableName: '2' })] },
    });
    expect((await list())[0]).toMatchObject({ tableName: '2' });
    expect(sync.errors).toEqual([]);
  });
});

describe('projection of table events', () => {
  const base = { version: 1, branchId: v7(), deviceId: v7(), occurredAt: new Date().toISOString() };
  let seq = 0;
  const ev = (type: string, payload: Record<string, unknown>): SyncEvent => ({
    ...base,
    id: v7(),
    type,
    entityId: 'order-1',
    deviceSeq: ++seq,
    payload,
  });

  it('counter tickets have no table; moving to the counter clears it', () => {
    const { ops, problems } = projectEvents([
      ev('order.opened', { type: 'takeaway' }),
      ev('order.table_changed', { tableId: null }),
    ]);
    expect(problems).toEqual([]);
    expect(ops).toEqual([
      expect.objectContaining({ kind: 'openOrder', table: null }),
      { kind: 'moveTable', orderId: 'order-1', table: null },
    ]);
  });

  it('a bad table id or a missing name is a problem, not a crash', () => {
    const { ops, problems } = projectEvents([
      ev('order.opened', { type: 'table', tableId: 'nope', tableName: '1' }),
      ev('order.table_changed', { tableId: v7() }),
    ]);
    expect(ops).toEqual([]);
    expect(problems.map((p) => p.reason)).toEqual([
      'order.opened: payload.tableId must be a uuid',
      'order.table_changed: payload.tableName must be a non-empty string',
    ]);
  });
});
