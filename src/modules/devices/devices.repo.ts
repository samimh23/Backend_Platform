import { and, asc, count, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { branches, devices, pairingCodes, type DeviceRole } from '../../db/schema.js';

export interface DeviceRecord {
  id: string;
  tenantId: string;
  branchId: string;
  disabled: boolean;
  lastSeq: number;
}

export interface NewDevice {
  id: string;
  tenantId: string;
  branchId: string;
  code: string;
  name: string;
  role: DeviceRole;
  publicKey: string;
  tokenHash: string;
}

export interface PairingContext {
  tenantId: string;
  branchId: string;
  role: DeviceRole;
  /** 1 for the first device of the branch → "T1". */
  deviceNumber: number;
}

/** What the owner sees about a device. */
export interface DeviceSummary {
  id: string;
  branchId: string;
  code: string;
  name: string;
  role: DeviceRole;
  disabled: boolean;
  lastSeq: number;
  lastSeenAt: Date | null;
  canTakePayments: boolean;
  lanAddresses: string[];
  lanPort: number | null;
  createdAt: Date;
}

export type DeviceChanges = { name?: string; disabled?: boolean; canTakePayments?: boolean };

export interface PairingCodeRecord {
  code: string;
  branchId: string;
  role: DeviceRole;
  expiresAt: Date;
}

export interface DevicesRepo {
  // ── Used by devices (POS) ──
  findByTokenHash(tokenHash: string): Promise<DeviceRecord | null>;
  /**
   * Atomically: consume a valid (unused, not expired) pairing code and create
   * the device. Returns null if the code is invalid.
   */
  pairWithCode(code: string, build: (ctx: PairingContext) => NewDevice): Promise<NewDevice | null>;

  // ── Used by the owner app ──
  /** Tenant owning this branch, or null if the branch does not exist. */
  branchTenant(branchId: string): Promise<string | null>;
  createPairingCode(code: PairingCodeRecord): Promise<void>;
  /** Unused, not expired codes. */
  listActivePairingCodes(branchId: string, now: Date): Promise<PairingCodeRecord[]>;
  listDevices(branchId: string): Promise<DeviceSummary[]>;
  findDevice(id: string): Promise<(DeviceSummary & { tenantId: string }) | null>;
  updateDevice(id: string, changes: DeviceChanges): Promise<DeviceSummary | null>;

  // ── Café local network (Hub) ──
  setLan(deviceId: string, addresses: string[], port: number): Promise<void>;
  /** The branch's LAN key; stores [candidate] first if there is none yet (race-safe). */
  ensureLanKey(branchId: string, candidate: string): Promise<string>;
}

const summaryColumns = {
  id: devices.id,
  branchId: devices.branchId,
  code: devices.code,
  name: devices.name,
  role: devices.role,
  disabled: devices.disabled,
  lastSeq: devices.lastSeq,
  lastSeenAt: devices.lastSeenAt,
  canTakePayments: devices.canTakePayments,
  lanAddresses: devices.lanAddresses,
  lanPort: devices.lanPort,
  createdAt: devices.createdAt,
};

export class DrizzleDevicesRepo implements DevicesRepo {
  constructor(private readonly db: Db) {}

  async findByTokenHash(tokenHash: string): Promise<DeviceRecord | null> {
    const [row] = await this.db
      .select({
        id: devices.id,
        tenantId: devices.tenantId,
        branchId: devices.branchId,
        disabled: devices.disabled,
        lastSeq: devices.lastSeq,
      })
      .from(devices)
      .where(eq(devices.tokenHash, tokenHash))
      .limit(1);
    return row ?? null;
  }

  async pairWithCode(code: string, build: (ctx: PairingContext) => NewDevice): Promise<NewDevice | null> {
    return this.db.transaction(async (tx) => {
      // Mark the code used only if it is still valid — two devices can't use the same code.
      const [pc] = await tx
        .update(pairingCodes)
        .set({ usedAt: new Date() })
        .where(and(eq(pairingCodes.code, code), isNull(pairingCodes.usedAt), gt(pairingCodes.expiresAt, new Date())))
        .returning({ branchId: pairingCodes.branchId, role: pairingCodes.role });
      if (!pc) return null;

      const [branch] = await tx
        .select({ tenantId: branches.tenantId })
        .from(branches)
        .where(eq(branches.id, pc.branchId));
      if (!branch) return null;

      const [c] = await tx.select({ n: count() }).from(devices).where(eq(devices.branchId, pc.branchId));
      const device = build({
        tenantId: branch.tenantId,
        branchId: pc.branchId,
        role: pc.role,
        deviceNumber: (c?.n ?? 0) + 1,
      });
      await tx.insert(devices).values(device);
      return device;
    });
  }

  async branchTenant(branchId: string): Promise<string | null> {
    const [b] = await this.db.select({ tenantId: branches.tenantId }).from(branches).where(eq(branches.id, branchId));
    return b?.tenantId ?? null;
  }

  async createPairingCode(code: PairingCodeRecord): Promise<void> {
    await this.db.insert(pairingCodes).values(code);
  }

  listActivePairingCodes(branchId: string, now: Date): Promise<PairingCodeRecord[]> {
    return this.db
      .select({ code: pairingCodes.code, branchId: pairingCodes.branchId, role: pairingCodes.role, expiresAt: pairingCodes.expiresAt })
      .from(pairingCodes)
      .where(and(eq(pairingCodes.branchId, branchId), isNull(pairingCodes.usedAt), gt(pairingCodes.expiresAt, now)))
      .orderBy(asc(pairingCodes.expiresAt));
  }

  listDevices(branchId: string): Promise<DeviceSummary[]> {
    return this.db.select(summaryColumns).from(devices).where(eq(devices.branchId, branchId)).orderBy(asc(devices.createdAt));
  }

  async findDevice(id: string) {
    const [d] = await this.db
      .select({ ...summaryColumns, tenantId: devices.tenantId })
      .from(devices)
      .where(eq(devices.id, id));
    return d ?? null;
  }

  async updateDevice(id: string, changes: DeviceChanges) {
    const [d] = await this.db.update(devices).set(changes).where(eq(devices.id, id)).returning(summaryColumns);
    return d ?? null;
  }

  async setLan(deviceId: string, addresses: string[], port: number) {
    await this.db.update(devices).set({ lanAddresses: addresses, lanPort: port }).where(eq(devices.id, deviceId));
  }

  async ensureLanKey(branchId: string, candidate: string) {
    await this.db.update(branches).set({ lanKey: candidate }).where(and(eq(branches.id, branchId), isNull(branches.lanKey)));
    const [b] = await this.db.select({ lanKey: branches.lanKey }).from(branches).where(eq(branches.id, branchId));
    return b?.lanKey ?? candidate;
  }
}
