import { and, count, eq, gt, isNull } from 'drizzle-orm';
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

export interface DevicesRepo {
  findByTokenHash(tokenHash: string): Promise<DeviceRecord | null>;
  /**
   * Atomically: consume a valid (unused, not expired) pairing code and create
   * the device. Returns null if the code is invalid.
   */
  pairWithCode(code: string, build: (ctx: PairingContext) => NewDevice): Promise<NewDevice | null>;
}

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
}
