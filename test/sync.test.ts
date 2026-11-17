import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import type { buildApp } from '../src/app.js';
import type { SyncEvent } from '../src/modules/sync/sync.schema.js';
import { findSeqGaps } from '../src/modules/sync/sync.service.js';
import { branchId, buildTestApp, fakeRepos, publicKey, type FakeSyncRepo } from './fakes.js';

describe('sync API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sync: FakeSyncRepo;
  let device: { deviceId: string; token: string };

  beforeEach(async () => {
    const f = fakeRepos();
    sync = f.sync;
    f.devices.codes.set('ABCD-EFGH', { role: 'hub', used: false });
    app = await buildTestApp(f.repos);
    device = (
      await app.inject({
        method: 'POST',
        url: '/v1/devices/pair',
        payload: { code: 'ABCD-EFGH', name: 'Caisse', publicKey },
      })
    ).json();
  });
  afterEach(() => app.close());

  const event = (seq: number, overrides: Partial<SyncEvent> = {}): SyncEvent => ({
    id: v7(),
    type: 'order.opened',
    version: 1,
    branchId,
    deviceId: device.deviceId,
    entityId: v7(),
    deviceSeq: seq,
    occurredAt: new Date().toISOString(),
    payload: { table: 'T5' },
    ...overrides,
  });

  const push = (events: SyncEvent[], token = device.token) =>
    app.inject({
      method: 'POST',
      url: '/v1/sync/push',
      headers: { authorization: `Device ${token}` },
      payload: { events },
    });

  it('stores a batch and is idempotent on retry', async () => {
    const batch = [event(1), event(2)];

    const first = (await push(batch)).json();
    expect(first).toEqual({ accepted: batch.map((e) => e.id), rejected: [], duplicates: 0 });

    const retry = (await push(batch)).json();
    expect(retry.accepted).toHaveLength(2);
    expect(retry.duplicates).toBe(2);
    expect(sync.events.size).toBe(2);
  });

  it('rejects events that claim another device or branch', async () => {
    const res = (await push([event(1, { deviceId: v7() }), event(2, { branchId: v7() })])).json();
    expect(res.accepted).toEqual([]);
    expect(res.rejected.map((r: { code: string }) => r.code)).toEqual(['WRONG_DEVICE_OR_BRANCH', 'WRONG_DEVICE_OR_BRANCH']);
    expect(sync.errors).toHaveLength(2);
  });

  it('records sequence gaps without blocking the batch', async () => {
    const res = (await push([event(1), event(4)])).json();
    expect(res.accepted).toHaveLength(2);
    expect(sync.errors).toEqual([{ eventId: null, code: 'SEQ_GAP', details: { from: 2, to: 3 } }]);
  });

  it('refuses invalid events with VALIDATION_ERROR', async () => {
    const res = await push([event(0)]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses push without a valid device token', async () => {
    const res = await push([event(1)], 'wrong-token');
    expect(res.statusCode).toBe(401);
  });

  it('pull returns the full catalog first, then only changes', async () => {
    const auth = { authorization: `Device ${device.token}` };
    const full = (await app.inject({ url: '/v1/sync/pull', headers: auth })).json();
    expect(full.categories).toHaveLength(1);
    expect(new Date(full.cursor).getTime()).not.toBeNaN();

    const next = (await app.inject({ url: `/v1/sync/pull?cursor=${encodeURIComponent(full.cursor)}`, headers: auth })).json();
    expect(next.categories).toHaveLength(0);
  });
});

describe('findSeqGaps', () => {
  it('no gap', () => expect(findSeqGaps(0, [1, 2, 3])).toEqual([]));
  it('gaps at start and middle', () =>
    expect(findSeqGaps(5, [8, 9, 12])).toEqual([
      { from: 6, to: 7 },
      { from: 10, to: 11 },
    ]));
  it('late or retried events are fine', () => expect(findSeqGaps(10, [3, 4])).toEqual([]));
  it('unordered batch', () => expect(findSeqGaps(0, [3, 1, 2])).toEqual([]));
});
