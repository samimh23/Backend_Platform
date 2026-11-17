import { v7 } from 'uuid';
import type { Repos } from '../src/app.js';
import type { DeviceRecord, DevicesRepo, NewDevice, PairingContext } from '../src/modules/devices/devices.repo.js';
import type { SyncErrorRecord, SyncRepo } from '../src/modules/sync/sync.repo.js';
import type { SyncEvent } from '../src/modules/sync/sync.schema.js';

/** In-memory repos: test HTTP + services without Postgres. */

export const tenantId = v7();
export const branchId = v7();

export class FakeDevicesRepo implements DevicesRepo {
  devices: (NewDevice & { disabled: boolean; lastSeq: number })[] = [];
  codes = new Map<string, { role: PairingContext['role']; used: boolean; expired?: boolean }>();

  async findByTokenHash(tokenHash: string): Promise<DeviceRecord | null> {
    return this.devices.find((d) => d.tokenHash === tokenHash) ?? null;
  }

  async pairWithCode(code: string, build: (ctx: PairingContext) => NewDevice) {
    const c = this.codes.get(code);
    if (!c || c.used || c.expired) return null;
    c.used = true;
    const d = build({ tenantId, branchId, role: c.role, deviceNumber: this.devices.length + 1 });
    this.devices.push({ ...d, disabled: false, lastSeq: 0 });
    return d;
  }
}

export class FakeSyncRepo implements SyncRepo {
  events = new Map<string, SyncEvent>();
  errors: SyncErrorRecord[] = [];

  constructor(private readonly devices: FakeDevicesRepo) {}

  async insertEvents(_ctx: unknown, list: SyncEvent[]) {
    const inserted: string[] = [];
    for (const e of list) {
      if (!this.events.has(e.id)) {
        this.events.set(e.id, e);
        inserted.push(e.id);
      }
    }
    return inserted;
  }

  async recordErrors(_deviceId: string, errors: SyncErrorRecord[]) {
    this.errors.push(...errors);
  }

  async touchDevice(deviceId: string, maxSeq: number) {
    const d = this.devices.devices.find((x) => x.id === deviceId);
    if (d) d.lastSeq = Math.max(d.lastSeq, maxSeq);
  }

  async catalogSince(_branchId: string, since: Date | null) {
    return {
      categories: since ? [] : [{ id: v7(), name: 'Boissons chaudes', sortOrder: 1, color: '#8B5E3C' }],
      products: [],
    };
  }
}

export function fakeRepos() {
  const devices = new FakeDevicesRepo();
  const sync = new FakeSyncRepo(devices);
  const repos: Repos = { health: { ping: async () => {} }, devices, sync };
  return { repos, devices, sync };
}

/** A valid Ed25519 public key shape (43 base64url chars). */
export const publicKey = 'A'.repeat(43);
