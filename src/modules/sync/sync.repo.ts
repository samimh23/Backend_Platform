import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { categories, devices, events, products, syncErrors } from '../../db/schema.js';
import { newId } from '../../shared/ids.js';
import type { DeviceContext } from '../devices/devices.service.js';
import type { PullResult, SyncEvent } from './sync.schema.js';

export interface SyncErrorRecord {
  eventId: string | null;
  code: string;
  details?: unknown;
}

export interface SyncRepo {
  /** Inserts events, ignoring ids already stored. Returns the ids actually inserted. */
  insertEvents(ctx: DeviceContext, events: SyncEvent[]): Promise<string[]>;
  recordErrors(deviceId: string, errors: SyncErrorRecord[]): Promise<void>;
  /** Updates last seen time and the highest sequence received. */
  touchDevice(deviceId: string, maxSeq: number): Promise<void>;
  catalogSince(branchId: string, since: Date | null): Promise<Omit<PullResult, 'cursor'>>;
}

export class DrizzleSyncRepo implements SyncRepo {
  constructor(private readonly db: Db) {}

  async insertEvents(ctx: DeviceContext, list: SyncEvent[]): Promise<string[]> {
    if (list.length === 0) return [];
    const rows = await this.db
      .insert(events)
      .values(
        list.map((e) => ({
          id: e.id,
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          deviceId: ctx.deviceId,
          staffId: e.staffId ?? null,
          type: e.type,
          version: e.version,
          entityId: e.entityId,
          deviceSeq: e.deviceSeq,
          occurredAt: new Date(e.occurredAt),
          approvedBy: e.approvedBy ?? null,
          payload: e.payload,
        })),
      )
      .onConflictDoNothing({ target: events.id })
      .returning({ id: events.id });
    return rows.map((r) => r.id);
  }

  async recordErrors(deviceId: string, errors: SyncErrorRecord[]): Promise<void> {
    if (errors.length === 0) return;
    await this.db
      .insert(syncErrors)
      .values(errors.map((e) => ({ id: newId(), deviceId, eventId: e.eventId, code: e.code, details: e.details ?? null })));
  }

  async touchDevice(deviceId: string, maxSeq: number): Promise<void> {
    await this.db
      .update(devices)
      .set({ lastSeenAt: new Date(), lastSeq: sql`GREATEST(${devices.lastSeq}, ${maxSeq})` })
      .where(eq(devices.id, deviceId));
  }

  /**
   * First pull (no cursor): the live menu only.
   * Next pulls: everything changed since the cursor, INCLUDING deletions (deleted: true),
   * so the POS can remove them.
   */
  async catalogSince(branchId: string, since: Date | null) {
    const catWhere = since
      ? and(eq(categories.branchId, branchId), gt(categories.updatedAt, since))
      : and(eq(categories.branchId, branchId), isNull(categories.deletedAt));
    const prodWhere = since
      ? and(eq(products.branchId, branchId), gt(products.updatedAt, since))
      : and(eq(products.branchId, branchId), isNull(products.deletedAt));

    const [cats, prods] = await Promise.all([
      this.db
        .select({
          id: categories.id,
          name: categories.name,
          sortOrder: categories.sortOrder,
          color: categories.color,
          deletedAt: categories.deletedAt,
        })
        .from(categories)
        .where(catWhere),
      this.db
        .select({
          id: products.id,
          categoryId: products.categoryId,
          name: products.name,
          price: products.price,
          vatRateBp: products.vatRateBp,
          station: products.station,
          modifierGroups: products.modifierGroups,
          available: products.available,
          sortOrder: products.sortOrder,
          deletedAt: products.deletedAt,
        })
        .from(products)
        .where(prodWhere),
    ]);
    return {
      categories: cats.map(({ deletedAt, ...c }) => ({ ...c, deleted: deletedAt !== null })),
      products: prods.map(({ deletedAt, ...p }) => ({ ...p, deleted: deletedAt !== null })),
    };
  }
}
