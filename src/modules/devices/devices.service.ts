import { AppError, Errors } from '../../shared/errors.js';
import { hashToken, newToken } from '../../shared/crypto.js';
import { newId } from '../../shared/ids.js';
import type { DevicesRepo } from './devices.repo.js';
import type { PairBody, PairResult } from './devices.schema.js';

/** Who is calling, once a device token is verified. Passed to every device endpoint. */
export interface DeviceContext {
  deviceId: string;
  tenantId: string;
  branchId: string;
  lastSeq: number;
}

export const DeviceErrors = {
  pairingCodeInvalid: () => new AppError('PAIRING_CODE_INVALID', 'Pairing code is invalid, used or expired', 400),
  deviceDisabled: () => new AppError('DEVICE_DISABLED', 'This device was disabled by the owner', 403),
};

/** "k7q2 m9xd" → "K7Q2-M9XD" */
export function normalizePairingCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

export class DevicesService {
  constructor(private readonly repo: DevicesRepo) {}

  /** Pairs a new device with a one-time code from the owner app. */
  async pair(input: PairBody): Promise<PairResult> {
    const token = newToken();
    const device = await this.repo.pairWithCode(normalizePairingCode(input.code), (ctx) => ({
      id: newId(),
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      code: `T${ctx.deviceNumber}`,
      name: input.name.trim(),
      role: ctx.role,
      publicKey: input.publicKey,
      tokenHash: hashToken(token),
    }));
    if (!device) throw DeviceErrors.pairingCodeInvalid();

    return {
      deviceId: device.id,
      deviceCode: device.code,
      role: device.role,
      tenantId: device.tenantId,
      branchId: device.branchId,
      token,
    };
  }

  /** Verifies "Authorization: Device <token>". */
  async authenticate(authorization: string | undefined): Promise<DeviceContext> {
    const [scheme, token] = (authorization ?? '').split(' ');
    if (scheme !== 'Device' || !token) throw Errors.unauthorized();

    const device = await this.repo.findByTokenHash(hashToken(token));
    if (!device) throw Errors.unauthorized();
    if (device.disabled) throw DeviceErrors.deviceDisabled();

    return {
      deviceId: device.id,
      tenantId: device.tenantId,
      branchId: device.branchId,
      lastSeq: device.lastSeq,
    };
  }
}
