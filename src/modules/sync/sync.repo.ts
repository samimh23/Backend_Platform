import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { categories, devices, diningTables, events, floorAreas, products, staff, syncErrors } from '../../db/schema.js';
import { newId } from '../../shared/ids.js';
import type { DeviceContext } from '../devices/devices.service.js';
import { applyProjection } from '../sales/sales.apply.js';
import { projectEvents } from '../sales/sales.projection.js';
import type { PullResult, SyncEvent } from './sync.schema.js';

export interface SyncErrorRecord {
  eventId: string | null;
  code: string;
  details?: unknown;
}

export interface SyncRepo {
  /**
   * Inserts events (ids already stored are ignored) AND updates the sales tables
   * from the new ones, in one transaction. Returns the ids actually inserted.
   */
  insertEvents(ctx: DeviceContext, events: SyncEvent[]): Promise<string[]>;
  recordErrors(deviceId: string, errors: SyncErrorRecord[]): Promise<void>;
  /** Updates last seen time and the highest sequence received. */
  touchDevice(deviceId: string, maxSeq: number): Promise<void>;
  catalogSince(branchId: string, since: Date | null): Promise<Pick<PullResult, 'categories' | 'products'>>;
  /** First pull: active staff only. Next pulls: every change, including deactivations. */
  staffSince(branchId: string, since: Date | null): Promise<PullResult['staff']>;
  /** Same rules as the menu: live rows first, then changes incl. deletions. */
  floorSince(branchId: string, since: Date | null): Promise<Pick<PullResult, 'areas' | 'tables'>>;
}

export class DrizzleSyncRepo implements SyncRepo {
  constructor(private readonly db: Db) {}

  async insertEvents(ctx: DeviceContext, list: SyncEvent[]): Promise<string[]> {
    if (list.length === 0) return [];
    return this.db.transaction(async (tx) => {
      const rows = await tx
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
      const inserted = new Set(rows.map((r) => r.id));

      // Only NEW events change the sales tables (a retried batch changes nothing).
      const fresh = list.filter((e) => inserted.has(e.id)).sort((a, b) => a.deviceSeq - b.deviceSeq);
      const { ops, problems } = projectEvents(fresh);
      await applyProjection(tx, ctx, ops);
      if (problems.length > 0) {
        await tx.insert(syncErrors).values(
          problems.map((p) => ({ id: newId(), deviceId: ctx.deviceId, eventId: p.eventId, code: 'PROJECTION_SKIPPED', details: { reason: p.reason } })),
        );
      }
      return [...inserted];
    });
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

  async floorSince(branchId: string, since: Date | null) {
    const [areas, tables] = await Promise.all([
      this.db
        .select({ id: floorAreas.id, name: floorAreas.name, sortOrder: floorAreas.sortOrder, deletedAt: floorAreas.deletedAt })
        .from(floorAreas)
        .where(
          since
            ? and(eq(floorAreas.branchId, branchId), gt(floorAreas.updatedAt, since))
            : and(eq(floorAreas.branchId, branchId), isNull(floorAreas.deletedAt)),
        ),
      this.db
        .select({
          id: diningTables.id,
          areaId: diningTables.areaId,
          name: diningTables.name,
          seats: diningTables.seats,
          sortOrder: diningTables.sortOrder,
          deletedAt: diningTables.deletedAt,
        })
        .from(diningTables)
        .where(
          since
            ? and(eq(diningTables.branchId, branchId), gt(diningTables.updatedAt, since))
            : and(eq(diningTables.branchId, branchId), isNull(diningTables.deletedAt)),
        ),
    ]);
    return {
      areas: areas.map(({ deletedAt, ...a }) => ({ ...a, deleted: deletedAt !== null })),
      tables: tables.map(({ deletedAt, ...t }) => ({ ...t, deleted: deletedAt !== null })),
    };
  }

  staffSince(branchId: string, since: Date | null) {
    return this.db
      .select({ id: staff.id, name: staff.name, role: staff.role, pinHash: staff.pinHash, active: staff.active })
      .from(staff)
      .where(
        since
          ? and(eq(staff.branchId, branchId), gt(staff.updatedAt, since))
          : and(eq(staff.branchId, branchId), eq(staff.active, true)),
      );
  }
}
