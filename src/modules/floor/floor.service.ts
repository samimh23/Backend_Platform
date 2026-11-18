import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import type { OwnerContext } from '../auth/auth.service.js';
import type { AreaRecord, FloorRepo, TableRecord } from './floor.repo.js';
import type {
  AreaView,
  CreateAreaBody,
  CreateTablesBody,
  FloorView,
  TableView,
  UpdateAreaBody,
  UpdateTableBody,
} from './floor.schema.js';

export const FloorErrors = {
  branchNotFound: () => new AppError('BRANCH_NOT_FOUND', 'Branch not found', 404),
  areaNotFound: () => new AppError('AREA_NOT_FOUND', 'Area not found', 404),
  tableNotFound: () => new AppError('TABLE_NOT_FOUND', 'Table not found', 404),
  areaNotEmpty: (n: number) =>
    new AppError('AREA_NOT_EMPTY', `This area still has ${n} table(s). Move or delete them first.`, 409),
  tableNameTaken: (names: string[]) =>
    new AppError('TABLE_NAME_TAKEN', `Table name already used in this branch: ${names.join(', ')}`, 409),
};

/** Same name for staff: "4" and " 4 " and "t4" vs "T4" are the same table. */
const key = (name: string) => name.trim().toLocaleLowerCase('fr');

/**
 * Rooms and tables of a branch (owner and manager roles, like the menu).
 * POS devices receive them on their next pull.
 */
export class FloorService {
  constructor(
    private readonly repo: FloorRepo,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getFloor(owner: OwnerContext, branchId: string): Promise<FloorView> {
    await this.assertBranch(owner, branchId);
    const [areas, tables] = await Promise.all([this.repo.listAreas(branchId), this.repo.listTables(branchId)]);
    return { areas: areas.map(areaView), tables: tables.map(tableView) };
  }

  // ── Areas ───────────────────────────────────────────────

  async createArea(owner: OwnerContext, branchId: string, body: CreateAreaBody): Promise<AreaView> {
    await this.assertBranch(owner, branchId);
    const record: AreaRecord = {
      id: newId(),
      branchId,
      name: body.name.trim(),
      sortOrder: body.sortOrder ?? (await this.repo.listAreas(branchId)).length,
    };
    await this.repo.insertArea(record, this.now());
    return areaView(record);
  }

  async updateArea(owner: OwnerContext, id: string, body: UpdateAreaBody): Promise<AreaView> {
    await this.ownedArea(owner, id);
    const updated = await this.repo.updateArea(id, { ...body, ...(body.name && { name: body.name.trim() }) }, this.now());
    if (!updated) throw FloorErrors.areaNotFound();
    return areaView(updated);
  }

  /** Refused while tables remain, so no table disappears from the POS by accident. */
  async deleteArea(owner: OwnerContext, id: string): Promise<void> {
    await this.ownedArea(owner, id);
    const n = await this.repo.countTables(id);
    if (n > 0) throw FloorErrors.areaNotEmpty(n);
    await this.repo.softDeleteArea(id, this.now());
  }

  // ── Tables ──────────────────────────────────────────────

  /** Adds one or several tables to an area ("1" … "12"). Names must be new in the branch. */
  async createTables(owner: OwnerContext, branchId: string, body: CreateTablesBody): Promise<TableView[]> {
    await this.assertBranch(owner, branchId);
    const area = await this.ownedArea(owner, body.areaId);
    if (area.branchId !== branchId) throw FloorErrors.areaNotFound();

    const names = body.names.map((n) => n.trim());
    const existing = await this.repo.listTables(branchId);
    const taken = new Set(existing.map((t) => key(t.name)));
    const clashes: string[] = [];
    for (const n of names) {
      if (taken.has(key(n))) clashes.push(n);
      taken.add(key(n)); // also catches duplicates inside the request
    }
    if (clashes.length > 0) throw FloorErrors.tableNameTaken(clashes);

    const start = existing.filter((t) => t.areaId === area.id).length;
    const records: TableRecord[] = names.map((name, i) => ({
      id: newId(),
      branchId,
      areaId: area.id,
      name,
      seats: body.seats ?? 4,
      sortOrder: start + i,
    }));
    await this.repo.insertTables(records, this.now());
    return records.map(tableView);
  }

  async updateTable(owner: OwnerContext, id: string, body: UpdateTableBody): Promise<TableView> {
    const table = await this.ownedTable(owner, id);
    if (body.areaId) {
      const area = await this.ownedArea(owner, body.areaId);
      if (area.branchId !== table.branchId) throw FloorErrors.areaNotFound();
    }
    const name = body.name?.trim();
    if (name !== undefined && key(name) !== key(table.name)) {
      const others = await this.repo.listTables(table.branchId);
      if (others.some((t) => t.id !== id && key(t.name) === key(name))) throw FloorErrors.tableNameTaken([name]);
    }
    const updated = await this.repo.updateTable(id, { ...body, ...(name !== undefined && { name }) }, this.now());
    if (!updated) throw FloorErrors.tableNotFound();
    return tableView(updated);
  }

  /** An open ticket on that table stays on the POS (it keeps the table name). */
  async deleteTable(owner: OwnerContext, id: string): Promise<void> {
    await this.ownedTable(owner, id);
    await this.repo.softDeleteTable(id, this.now());
  }

  // ── Access checks (another business's data looks "not found") ──

  private async assertBranch(owner: OwnerContext, branchId: string) {
    if ((await this.repo.branchTenant(branchId)) !== owner.tenantId) throw FloorErrors.branchNotFound();
  }

  private async ownedArea(owner: OwnerContext, id: string) {
    const a = await this.repo.findArea(id);
    if (!a || (await this.repo.branchTenant(a.branchId)) !== owner.tenantId) throw FloorErrors.areaNotFound();
    return a;
  }

  private async ownedTable(owner: OwnerContext, id: string) {
    const t = await this.repo.findTable(id);
    if (!t || (await this.repo.branchTenant(t.branchId)) !== owner.tenantId) throw FloorErrors.tableNotFound();
    return t;
  }
}

const areaView = ({ id, name, sortOrder }: AreaRecord): AreaView => ({ id, name, sortOrder });
const tableView = ({ branchId: _b, ...t }: TableRecord): TableView => t;
