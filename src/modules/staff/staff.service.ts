import { AppError, Errors } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { hashPin } from '../../shared/pin.js';
import type { OwnerContext } from '../auth/auth.service.js';
import type { StaffRecord, StaffRepo } from './staff.repo.js';
import type { CreateStaffBody, StaffView, UpdateStaffBody } from './staff.schema.js';

export const StaffErrors = {
  branchNotFound: () => new AppError('BRANCH_NOT_FOUND', 'Branch not found', 404),
  staffNotFound: () => new AppError('STAFF_NOT_FOUND', 'Staff member not found', 404),
};

/** Managing staff is for the owner only (see Notion → Roles & permissions). */
function assertOwner(owner: OwnerContext) {
  if (owner.role !== 'owner') throw Errors.forbidden();
}

const view = ({ id, name, role, active }: StaffRecord): StaffView => ({ id, name, role, active });

export class StaffService {
  constructor(
    private readonly repo: StaffRepo,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(owner: OwnerContext, branchId: string): Promise<StaffView[]> {
    await this.assertBranch(owner, branchId);
    return (await this.repo.list(branchId)).map(view);
  }

  async create(owner: OwnerContext, branchId: string, body: CreateStaffBody): Promise<StaffView> {
    assertOwner(owner);
    await this.assertBranch(owner, branchId);
    const record: StaffRecord = {
      id: newId(),
      tenantId: owner.tenantId,
      branchId,
      name: body.name.trim(),
      role: body.role,
      pinHash: hashPin(body.pin),
      active: true,
    };
    await this.repo.insert(record, this.now());
    return view(record);
  }

  async update(owner: OwnerContext, id: string, body: UpdateStaffBody): Promise<StaffView> {
    assertOwner(owner);
    const current = await this.repo.find(id);
    if (!current || current.tenantId !== owner.tenantId) throw StaffErrors.staffNotFound();
    const updated = await this.repo.update(
      id,
      {
        ...(body.name !== undefined && { name: body.name.trim() }),
        ...(body.role !== undefined && { role: body.role }),
        ...(body.active !== undefined && { active: body.active }),
        ...(body.pin !== undefined && { pinHash: hashPin(body.pin) }),
      },
      this.now(),
    );
    if (!updated) throw StaffErrors.staffNotFound();
    return view(updated);
  }

  private async assertBranch(owner: OwnerContext, branchId: string) {
    if ((await this.repo.branchTenant(branchId)) !== owner.tenantId) throw StaffErrors.branchNotFound();
  }
}
