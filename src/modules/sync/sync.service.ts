import type { DeviceContext } from '../devices/devices.service.js';
import type { SyncErrorRecord, SyncRepo } from './sync.repo.js';
import type { PullResult, PushResult, SyncEvent } from './sync.schema.js';

export class SyncService {
  constructor(
    private readonly repo: SyncRepo,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Stores a batch of events from a device.
   * - Idempotent: sending the same events again is safe (duplicates counted, not stored twice).
   * - Events claiming another device/branch are rejected.
   * - Gaps in deviceSeq are recorded (possible data loss on the device) but never block the batch.
   */
  async push(ctx: DeviceContext, batch: SyncEvent[]): Promise<PushResult> {
    const valid: SyncEvent[] = [];
    const rejected: PushResult['rejected'] = [];
    for (const e of batch) {
      if (e.deviceId !== ctx.deviceId || e.branchId !== ctx.branchId) {
        rejected.push({ id: e.id, code: 'WRONG_DEVICE_OR_BRANCH' });
      } else {
        valid.push(e);
      }
    }

    const inserted = await this.repo.insertEvents(ctx, valid);

    const errors: SyncErrorRecord[] = rejected.map((r) => ({ eventId: r.id, code: r.code }));
    for (const gap of findSeqGaps(ctx.lastSeq, valid.map((e) => e.deviceSeq))) {
      errors.push({ eventId: null, code: 'SEQ_GAP', details: gap });
    }
    await this.repo.recordErrors(ctx.deviceId, errors);

    if (valid.length > 0) {
      await this.repo.touchDevice(ctx.deviceId, Math.max(...valid.map((e) => e.deviceSeq)));
    }

    return { accepted: valid.map((e) => e.id), rejected, duplicates: valid.length - inserted.length };
  }

  /** Menu changes made in the cloud since the device's last cursor. */
  async pull(ctx: DeviceContext, cursor: string | undefined): Promise<PullResult> {
    // Cursor = time the query STARTED, so changes made during the query are picked up next time.
    const startedAt = this.now();
    const since = cursor ? new Date(cursor) : null;
    const [data, staff] = await Promise.all([this.repo.catalogSince(ctx.branchId, since), this.repo.staffSince(ctx.branchId, since)]);
    // The POS pulls every 15 s even when idle → keeps "online" accurate in the owner app.
    await this.repo.touchDevice(ctx.deviceId, 0);
    return { cursor: startedAt.toISOString(), ...data, staff };
  }
}

/** Missing sequence ranges after `lastSeq`. Late/retried events (seq ≤ lastSeq) are fine. */
export function findSeqGaps(lastSeq: number, seqs: number[]): { from: number; to: number }[] {
  const gaps: { from: number; to: number }[] = [];
  let expected = lastSeq + 1;
  for (const s of [...new Set(seqs)].sort((a, b) => a - b)) {
    if (s < expected) continue;
    if (s > expected) gaps.push({ from: expected, to: s - 1 });
    expected = s + 1;
  }
  return gaps;
}
