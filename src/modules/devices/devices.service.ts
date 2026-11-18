import { AppError, Errors } from '../../shared/errors.js';
import { hashToken, newPairingCode, newToken } from '../../shared/crypto.js';
import { newId } from '../../shared/ids.js';
import type { DeviceRole } from '../../db/schema.js';
import type { OwnerContext } from '../auth/auth.service.js';
import type { DeviceSummary, DevicesRepo } from './devices.repo.js';
import type { DeviceView, LanInfo, LanReportBody, PairBody, PairResult, PairingCodeView } from './devices.schema.js';

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
  deviceNotFound: () => new AppError('DEVICE_NOT_FOUND', 'Device not found', 404),
  branchNotFound: () => new AppError('BRANCH_NOT_FOUND', 'Branch not found', 404),
};

/** A device that synced in the last 60 s is shown "online" (the POS syncs every 15 s). */
export const ONLINE_WINDOW_MS = 60_000;

/** Pairing codes are short-lived: shown on the owner's screen, typed on the POS right away. */
export const PAIRING_CODE_TTL_MS = 15 * 60_000;

/** Pairing and disabling devices is for the owner only (see Notion → Roles & permissions). */
function assertOwnerRole(owner: OwnerContext) {
  if (owner.role !== 'owner') throw Errors.forbidden();
}

/** "k7q2 m9xd" → "K7Q2-M9XD" */
export function normalizePairingCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

export class DevicesService {
  constructor(
    private readonly repo: DevicesRepo,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── Devices (POS) ────────────────────────────────────────

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

  // ── Owner app ────────────────────────────────────────────

  /** One-time code to type on a new POS (valid 15 min). */
  async createPairingCode(owner: OwnerContext, branchId: string, role: DeviceRole): Promise<PairingCodeView> {
    assertOwnerRole(owner);
    await this.assertBranch(owner, branchId);
    const record = { code: newPairingCode(), branchId, role, expiresAt: new Date(this.now().getTime() + PAIRING_CODE_TTL_MS) };
    await this.repo.createPairingCode(record);
    return { code: record.code, role, expiresAt: record.expiresAt.toISOString() };
  }

  async listPairingCodes(owner: OwnerContext, branchId: string): Promise<PairingCodeView[]> {
    await this.assertBranch(owner, branchId);
    const codes = await this.repo.listActivePairingCodes(branchId, this.now());
    return codes.map((c) => ({ code: c.code, role: c.role, expiresAt: c.expiresAt.toISOString() }));
  }

  async listDevices(owner: OwnerContext, branchId: string): Promise<DeviceView[]> {
    await this.assertBranch(owner, branchId);
    return (await this.repo.listDevices(branchId)).map((d) => this.view(d));
  }

  /** Rename, disable (locks the POS on its next sync), re-enable, or allow payments on a secondary POS. */
  async updateDevice(
    owner: OwnerContext,
    deviceId: string,
    changes: { name?: string; disabled?: boolean; canTakePayments?: boolean },
  ): Promise<DeviceView> {
    assertOwnerRole(owner);
    const device = await this.repo.findDevice(deviceId);
    // Another tenant's device looks exactly like a missing one — no information leak.
    if (!device || device.tenantId !== owner.tenantId) throw DeviceErrors.deviceNotFound();

    const updated = await this.repo.updateDevice(deviceId, {
      ...(changes.name !== undefined && { name: changes.name.trim() }),
      ...(changes.disabled !== undefined && { disabled: changes.disabled }),
      ...(changes.canTakePayments !== undefined && { canTakePayments: changes.canTakePayments }),
    });
    if (!updated) throw DeviceErrors.deviceNotFound();
    return this.view(updated);
  }

  // ── Café local network ───────────────────────────────────

  /** Only private addresses are kept: the Hub must never be advertised on the internet. */
  async reportLan(ctx: DeviceContext, body: LanReportBody): Promise<void> {
    const addresses = [...new Set(body.addresses.filter(isPrivateIpv4))];
    await this.repo.setLan(ctx.deviceId, addresses, body.port);
  }

  async lanInfo(ctx: DeviceContext): Promise<LanInfo> {
    const [lanKey, list] = await Promise.all([
      this.repo.ensureLanKey(ctx.branchId, newToken()),
      this.repo.listDevices(ctx.branchId),
    ]);
    const hub = list.find((d) => d.role === 'hub' && !d.disabled);
    return {
      lanKey,
      hub: hub ? { deviceId: hub.id, code: hub.code, addresses: hub.lanAddresses, port: hub.lanPort } : null,
      devices: list.map((d) => ({
        id: d.id,
        code: d.code,
        name: d.name,
        role: d.role,
        canTakePayments: d.role === 'hub' || d.canTakePayments,
        disabled: d.disabled,
      })),
    };
  }

  private async assertBranch(owner: OwnerContext, branchId: string) {
    const tenantId = await this.repo.branchTenant(branchId);
    if (tenantId !== owner.tenantId) throw DeviceErrors.branchNotFound();
  }

  private view(d: DeviceSummary): DeviceView {
    const lastSeen = d.lastSeenAt?.getTime();
    return {
      id: d.id,
      code: d.code,
      name: d.name,
      role: d.role,
      disabled: d.disabled,
      online: !d.disabled && lastSeen !== undefined && this.now().getTime() - lastSeen < ONLINE_WINDOW_MS,
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      lastSeq: d.lastSeq,
      pairedAt: d.createdAt.toISOString(),
      canTakePayments: d.role === 'hub' || d.canTakePayments,
      lanAddress: d.role === 'hub' && d.lanAddresses[0] && d.lanPort ? `${d.lanAddresses[0]}:${d.lanPort}` : null,
    };
  }
}

/** 10.x, 172.16–31.x, 192.168.x — addresses that only exist inside a local network. */
export function isPrivateIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
