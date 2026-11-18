import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { branches, staff, type StaffRole } from '../../db/schema.js';

export interface StaffRecord {
  id: string;
  tenantId: string;
  branchId: string;
  name: string;
  role: StaffRole;
  pinHash: string;
  active: boolean;
}

export interface StaffRepo {
  branchTenant(branchId: string): Promise<string | null>;
  list(branchId: string): Promise<StaffRecord[]>;
  find(id: string): Promise<StaffRecord | null>;
  insert(s: StaffRecord, now: Date): Promise<void>;
  update(id: string, changes: Partial<Pick<StaffRecord, 'name' | 'role' | 'pinHash' | 'active'>>, now: Date): Promise<StaffRecord | null>;
}

const columns = {
  id: staff.id,
  tenantId: staff.tenantId,
  branchId: staff.branchId,
  name: staff.name,
  role: staff.role,
  pinHash: staff.pinHash,
  active: staff.active,
};

export class DrizzleStaffRepo implements StaffRepo {
  constructor(private readonly db: Db) {}

  async branchTenant(branchId: string) {
    const [b] = await this.db.select({ tenantId: branches.tenantId }).from(branches).where(eq(branches.id, branchId));
    return b?.tenantId ?? null;
  }

  list(branchId: string) {
    return this.db.select(columns).from(staff).where(eq(staff.branchId, branchId)).orderBy(asc(staff.name));
  }

  async find(id: string) {
    const [s] = await this.db.select(columns).from(staff).where(eq(staff.id, id));
    return s ?? null;
  }

  async insert(s: StaffRecord, now: Date) {
    await this.db.insert(staff).values({ ...s, updatedAt: now, createdAt: now });
  }

  async update(id: string, changes: Partial<Pick<StaffRecord, 'name' | 'role' | 'pinHash' | 'active'>>, now: Date) {
    const [s] = await this.db
      .update(staff)
      .set({ ...changes, updatedAt: now })
      .where(and(eq(staff.id, id)))
      .returning(columns);
    return s ?? null;
  }
}
