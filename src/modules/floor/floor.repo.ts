import { and, asc, count, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { branches, diningTables, floorAreas } from '../../db/schema.js';
import type { AreaView, TableView } from './floor.schema.js';

export interface AreaRecord extends AreaView {
  branchId: string;
}

export interface TableRecord extends TableView {
  branchId: string;
}

/** Every write sets updated_at = now so POS devices pick it up on their next pull. */
export interface FloorRepo {
  branchTenant(branchId: string): Promise<string | null>;
  /** Not deleted, sorted. */
  listAreas(branchId: string): Promise<AreaRecord[]>;
  /** Not deleted, sorted. */
  listTables(branchId: string): Promise<TableRecord[]>;
  findArea(id: string): Promise<AreaRecord | null>;
  findTable(id: string): Promise<TableRecord | null>;
  insertArea(a: AreaRecord, now: Date): Promise<void>;
  updateArea(id: string, changes: Partial<Omit<AreaView, 'id'>>, now: Date): Promise<AreaRecord | null>;
  softDeleteArea(id: string, now: Date): Promise<void>;
  countTables(areaId: string): Promise<number>;
  insertTables(t: TableRecord[], now: Date): Promise<void>;
  updateTable(id: string, changes: Partial<Omit<TableView, 'id'>>, now: Date): Promise<TableRecord | null>;
  softDeleteTable(id: string, now: Date): Promise<void>;
}

const areaColumns = {
  id: floorAreas.id,
  branchId: floorAreas.branchId,
  name: floorAreas.name,
  sortOrder: floorAreas.sortOrder,
};

const tableColumns = {
  id: diningTables.id,
  branchId: diningTables.branchId,
  areaId: diningTables.areaId,
  name: diningTables.name,
  seats: diningTables.seats,
  sortOrder: diningTables.sortOrder,
};

export class DrizzleFloorRepo implements FloorRepo {
  constructor(private readonly db: Db) {}

  async branchTenant(branchId: string) {
    const [b] = await this.db.select({ tenantId: branches.tenantId }).from(branches).where(eq(branches.id, branchId));
    return b?.tenantId ?? null;
  }

  listAreas(branchId: string) {
    return this.db
      .select(areaColumns)
      .from(floorAreas)
      .where(and(eq(floorAreas.branchId, branchId), isNull(floorAreas.deletedAt)))
      .orderBy(asc(floorAreas.sortOrder), asc(floorAreas.name));
  }

  listTables(branchId: string) {
    return this.db
      .select(tableColumns)
      .from(diningTables)
      .where(and(eq(diningTables.branchId, branchId), isNull(diningTables.deletedAt)))
      .orderBy(asc(diningTables.sortOrder), asc(diningTables.name));
  }

  async findArea(id: string) {
    const [a] = await this.db
      .select(areaColumns)
      .from(floorAreas)
      .where(and(eq(floorAreas.id, id), isNull(floorAreas.deletedAt)));
    return a ?? null;
  }

  async findTable(id: string) {
    const [t] = await this.db
      .select(tableColumns)
      .from(diningTables)
      .where(and(eq(diningTables.id, id), isNull(diningTables.deletedAt)));
    return t ?? null;
  }

  async insertArea(a: AreaRecord, now: Date) {
    await this.db.insert(floorAreas).values({ ...a, updatedAt: now });
  }

  async updateArea(id: string, changes: Partial<Omit<AreaView, 'id'>>, now: Date) {
    const [a] = await this.db
      .update(floorAreas)
      .set({ ...changes, updatedAt: now })
      .where(and(eq(floorAreas.id, id), isNull(floorAreas.deletedAt)))
      .returning(areaColumns);
    return a ?? null;
  }

  async softDeleteArea(id: string, now: Date) {
    await this.db.update(floorAreas).set({ deletedAt: now, updatedAt: now }).where(eq(floorAreas.id, id));
  }

  async countTables(areaId: string) {
    const [r] = await this.db
      .select({ n: count() })
      .from(diningTables)
      .where(and(eq(diningTables.areaId, areaId), isNull(diningTables.deletedAt)));
    return r?.n ?? 0;
  }

  async insertTables(list: TableRecord[], now: Date) {
    if (list.length === 0) return;
    await this.db.insert(diningTables).values(list.map((t) => ({ ...t, updatedAt: now })));
  }

  async updateTable(id: string, changes: Partial<Omit<TableView, 'id'>>, now: Date) {
    const [t] = await this.db
      .update(diningTables)
      .set({ ...changes, updatedAt: now })
      .where(and(eq(diningTables.id, id), isNull(diningTables.deletedAt)))
      .returning(tableColumns);
    return t ?? null;
  }

  async softDeleteTable(id: string, now: Date) {
    await this.db.update(diningTables).set({ deletedAt: now, updatedAt: now }).where(eq(diningTables.id, id));
  }
}
