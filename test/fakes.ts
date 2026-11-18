import { v7 } from 'uuid';
import { buildApp, type Repos } from '../src/app.js';
import type { AuthRepo, BranchRecord, NewAccount, RefreshTokenRecord, TenantRecord, UserRecord } from '../src/modules/auth/auth.repo.js';
import type { PasswordHasher } from '../src/shared/passwords.js';
import type { StaffRecord, StaffRepo } from '../src/modules/staff/staff.repo.js';
import type { DeviceContext } from '../src/modules/devices/devices.service.js';
import { projectEvents, type ProjectionOp } from '../src/modules/sales/sales.projection.js';
import type { SalesLineRecord, SalesOrderRecord, SalesPaymentRecord, SalesRepo } from '../src/modules/sales/sales.repo.js';
import type { CatalogRepo, CategoryRecord, ProductRecord } from '../src/modules/catalog/catalog.repo.js';
import type { DeviceRecord, DeviceSummary, DevicesRepo, NewDevice, PairingCodeRecord, PairingContext } from '../src/modules/devices/devices.repo.js';
import type { SyncErrorRecord, SyncRepo } from '../src/modules/sync/sync.repo.js';
import type { SyncEvent } from '../src/modules/sync/sync.schema.js';

/** In-memory repos: test HTTP + services without Postgres. */

export const tenantId = v7();
export const branchId = v7();

type FakeDevice = NewDevice & { disabled: boolean; lastSeq: number; lastSeenAt: Date | null; createdAt: Date };
type FakeCode = { role: PairingContext['role']; used: boolean; expired?: boolean; branchId?: string; expiresAt?: Date };

export class FakeDevicesRepo implements DevicesRepo {
  devices: FakeDevice[] = [];
  codes = new Map<string, FakeCode>();

  /** Branches come from the auth fake (signup) + the default test branch. */
  constructor(private readonly auth?: FakeAuthRepo) {}

  async findByTokenHash(tokenHash: string): Promise<DeviceRecord | null> {
    return this.devices.find((d) => d.tokenHash === tokenHash) ?? null;
  }

  async pairWithCode(code: string, build: (ctx: PairingContext) => NewDevice) {
    const c = this.codes.get(code);
    if (!c || c.used || c.expired || (c.expiresAt && c.expiresAt <= new Date())) return null;
    c.used = true;
    const b = c.branchId ?? branchId;
    const t = (await this.branchTenant(b)) ?? tenantId;
    const d = build({ tenantId: t, branchId: b, role: c.role, deviceNumber: this.devices.filter((x) => x.branchId === b).length + 1 });
    this.devices.push({ ...d, disabled: false, lastSeq: 0, lastSeenAt: null, createdAt: new Date() });
    return d;
  }

  async branchTenant(id: string) {
    if (id === branchId) return tenantId;
    return this.auth?.branches.find((b) => b.id === id)?.tenantId ?? null;
  }

  async createPairingCode(c: PairingCodeRecord) {
    this.codes.set(c.code, { role: c.role, used: false, branchId: c.branchId, expiresAt: c.expiresAt });
  }

  async listActivePairingCodes(id: string, now: Date) {
    return [...this.codes.entries()]
      .filter(([, c]) => c.branchId === id && !c.used && !c.expired && (!c.expiresAt || c.expiresAt > now))
      .map(([code, c]) => ({ code, branchId: id, role: c.role, expiresAt: c.expiresAt ?? now }));
  }

  private summary(d: FakeDevice): DeviceSummary {
    const { id, branchId: b, code, name, role, disabled, lastSeq, lastSeenAt, createdAt } = d;
    return { id, branchId: b, code, name, role, disabled, lastSeq, lastSeenAt, createdAt };
  }

  async listDevices(id: string) {
    return this.devices.filter((d) => d.branchId === id).map((d) => this.summary(d));
  }

  async findDevice(id: string) {
    const d = this.devices.find((x) => x.id === id);
    return d ? { ...this.summary(d), tenantId: d.tenantId } : null;
  }

  async updateDevice(id: string, changes: { name?: string; disabled?: boolean }) {
    const d = this.devices.find((x) => x.id === id);
    if (!d) return null;
    Object.assign(d, changes);
    return this.summary(d);
  }
}

export class FakeSyncRepo implements SyncRepo {
  events = new Map<string, SyncEvent>();
  errors: SyncErrorRecord[] = [];

  constructor(
    private readonly devices: FakeDevicesRepo,
    private readonly catalog: FakeCatalogRepo,
    readonly sales: FakeSalesRepo,
    private readonly staff: FakeStaffRepo,
  ) {}

  async staffSince(b: string, since: Date | null) {
    return this.staff.rows
      .filter((r) => r.branchId === b && (since ? r.updatedAt > since : r.active))
      .map(({ id, name, role, pinHash, active }) => ({ id, name, role, pinHash, active }));
  }

  async insertEvents(ctx: DeviceContext, list: SyncEvent[]) {
    const fresh: SyncEvent[] = [];
    for (const e of list) {
      if (!this.events.has(e.id)) {
        this.events.set(e.id, e);
        fresh.push(e);
      }
    }
    // Same projection as the real repo, applied to the in-memory sales store.
    const { ops, problems } = projectEvents(fresh.sort((a, b) => a.deviceSeq - b.deviceSeq));
    this.sales.apply(ctx, ops);
    this.errors.push(...problems.map((p) => ({ eventId: p.eventId, code: 'PROJECTION_SKIPPED', details: { reason: p.reason } })));
    return fresh.map((e) => e.id);
  }

  async recordErrors(_deviceId: string, errors: SyncErrorRecord[]) {
    this.errors.push(...errors);
  }

  async touchDevice(deviceId: string, maxSeq: number) {
    const d = this.devices.devices.find((x) => x.id === deviceId);
    if (d) {
      d.lastSeq = Math.max(d.lastSeq, maxSeq);
      d.lastSeenAt = new Date();
    }
  }

  /** Reads the fake catalog, like the real repo: live rows first, then changes incl. deletions. */
  async catalogSince(b: string, since: Date | null) {
    const pick = <T extends { branchId: string; updatedAt: Date; deletedAt: Date | null }>(rows: T[]) =>
      rows.filter((r) => r.branchId === b && (since ? r.updatedAt > since : r.deletedAt === null));
    return {
      categories: pick(this.catalog.categories).map(({ id, name, sortOrder, color, deletedAt }) => ({
        id,
        name,
        sortOrder,
        color,
        deleted: deletedAt !== null,
      })),
      products: pick(this.catalog.products).map(({ branchId: _b, updatedAt: _u, deletedAt, ...p }) => ({
        ...p,
        deleted: deletedAt !== null,
      })),
    };
  }
}

type Stamped = { updatedAt: Date; deletedAt: Date | null };

export class FakeCatalogRepo implements CatalogRepo {
  categories: (CategoryRecord & Stamped)[] = [
    // The default test branch starts with one category.
    { id: v7(), branchId, name: 'Boissons chaudes', color: '#8B5E3C', sortOrder: 1, updatedAt: new Date(0), deletedAt: null },
  ];
  products: (ProductRecord & Stamped)[] = [];

  constructor(private readonly devices: FakeDevicesRepo) {}

  branchTenant(id: string) {
    return this.devices.branchTenant(id);
  }
  private strip<T extends Stamped>({ updatedAt: _u, deletedAt: _d, ...r }: T) {
    return r;
  }
  async listCategories(b: string) {
    return this.categories.filter((c) => c.branchId === b && !c.deletedAt).map((c) => this.strip(c));
  }
  async listProducts(b: string) {
    return this.products.filter((p) => p.branchId === b && !p.deletedAt).map((p) => this.strip(p));
  }
  async findCategory(id: string) {
    const c = this.categories.find((x) => x.id === id && !x.deletedAt);
    return c ? this.strip(c) : null;
  }
  async findProduct(id: string) {
    const p = this.products.find((x) => x.id === id && !x.deletedAt);
    return p ? this.strip(p) : null;
  }
  async insertCategory(c: CategoryRecord, now: Date) {
    this.categories.push({ ...c, updatedAt: now, deletedAt: null });
  }
  async updateCategory(id: string, changes: Partial<CategoryRecord>, now: Date) {
    const c = this.categories.find((x) => x.id === id && !x.deletedAt);
    if (!c) return null;
    Object.assign(c, changes, { updatedAt: now });
    return this.strip(c);
  }
  async softDeleteCategory(id: string, now: Date) {
    Object.assign(this.categories.find((x) => x.id === id)!, { deletedAt: now, updatedAt: now });
  }
  async countProducts(categoryId: string) {
    return this.products.filter((p) => p.categoryId === categoryId && !p.deletedAt).length;
  }
  async insertProduct(p: ProductRecord, now: Date) {
    this.products.push({ ...p, updatedAt: now, deletedAt: null });
  }
  async updateProduct(id: string, changes: Partial<ProductRecord>, now: Date) {
    const p = this.products.find((x) => x.id === id && !x.deletedAt);
    if (!p) return null;
    Object.assign(p, changes, { updatedAt: now });
    return this.strip(p);
  }
  async softDeleteProduct(id: string, now: Date) {
    Object.assign(this.products.find((x) => x.id === id)!, { deletedAt: now, updatedAt: now });
  }
}

export class FakeAuthRepo implements AuthRepo {
  users: UserRecord[] = [];
  tenants: TenantRecord[] = [];
  branches: (BranchRecord & { tenantId: string })[] = [];
  tokens: (RefreshTokenRecord & { tokenHash: string })[] = [];

  async findUserByEmail(email: string) {
    return this.users.find((u) => u.email === email) ?? null;
  }
  async findUserById(id: string) {
    return this.users.find((u) => u.id === id) ?? null;
  }
  async createAccount({ tenant, branch, user }: NewAccount) {
    if (this.users.some((u) => u.email === user.email)) return false;
    this.tenants.push(tenant);
    this.branches.push({ ...branch, tenantId: tenant.id });
    this.users.push(user);
    return true;
  }
  async getTenant(id: string) {
    return this.tenants.find((t) => t.id === id) ?? null;
  }
  async listBranches(tenantId: string) {
    return this.branches.filter((b) => b.tenantId === tenantId).map(({ id, name, type }) => ({ id, name, type }));
  }
  async saveRefreshToken(t: { id: string; userId: string; tokenHash: string; expiresAt: Date }) {
    this.tokens.push({ ...t, revokedAt: null });
  }
  async findRefreshToken(tokenHash: string) {
    return this.tokens.find((t) => t.tokenHash === tokenHash) ?? null;
  }
  async revokeRefreshToken(id: string) {
    const t = this.tokens.find((x) => x.id === id && !x.revokedAt);
    if (t) t.revokedAt = new Date();
    return !!t;
  }
  async revokeAllRefreshTokens(userId: string) {
    for (const t of this.tokens) if (t.userId === userId && !t.revokedAt) t.revokedAt = new Date();
  }
}

export class FakeStaffRepo implements StaffRepo {
  rows: (StaffRecord & { updatedAt: Date })[] = [];
  constructor(private readonly devices: FakeDevicesRepo) {}
  branchTenant(id: string) {
    return this.devices.branchTenant(id);
  }
  private strip({ updatedAt: _u, ...r }: StaffRecord & { updatedAt: Date }): StaffRecord {
    return r;
  }
  async list(b: string) {
    return this.rows.filter((r) => r.branchId === b).map((r) => this.strip(r));
  }
  async find(id: string) {
    const r = this.rows.find((x) => x.id === id);
    return r ? this.strip(r) : null;
  }
  async insert(s: StaffRecord, now: Date) {
    this.rows.push({ ...s, updatedAt: now });
  }
  async update(id: string, changes: Partial<StaffRecord>, now: Date) {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return null;
    Object.assign(r, changes, { updatedAt: now });
    return this.strip(r);
  }
}

/** In-memory sales tables, filled by the projection like the real ones. */
export class FakeSalesRepo implements SalesRepo {
  orders: (Omit<SalesOrderRecord, 'deviceCode'> & { deviceId: string })[] = [];
  lines: SalesLineRecord[] = [];
  payments: SalesPaymentRecord[] = [];

  constructor(private readonly devices: FakeDevicesRepo) {}

  apply(ctx: DeviceContext, ops: ProjectionOp[]) {
    for (const op of ops) {
      const order = 'orderId' in op ? this.orders.find((o) => o.id === op.orderId) : undefined;
      switch (op.kind) {
        case 'openOrder':
          if (!order)
            this.orders.push({
              id: op.orderId,
              tenantId: ctx.tenantId,
              branchId: ctx.branchId,
              deviceId: ctx.deviceId,
              status: 'open',
              type: op.type,
              openedAt: op.openedAt,
              closedAt: null,
              total: 0,
              itemCount: 0,
              receiptNumber: null,
              paymentMethod: null,
            });
          break;
        case 'addLine':
          if (!this.lines.some((l) => l.id === op.line.id)) this.lines.push({ ...op.line, orderId: op.orderId, voided: false });
          break;
        case 'setLineQty':
          for (const l of this.lines) if (l.id === op.lineId) l.qty = op.qty;
          break;
        case 'voidLine':
          for (const l of this.lines) if (l.id === op.lineId) l.voided = true;
          break;
        case 'payment':
          this.payments.push({ ...op.payment, orderId: op.orderId });
          if (order) order.paymentMethod = !order.paymentMethod || order.paymentMethod === op.payment.method ? op.payment.method : 'mixed';
          break;
        case 'closeOrder':
          if (order) Object.assign(order, { status: 'paid', closedAt: op.closedAt, total: op.total, itemCount: op.itemCount, receiptNumber: op.receiptNumber });
          break;
        case 'cancelOrder':
          if (order) Object.assign(order, { status: 'cancelled', closedAt: op.closedAt });
          break;
      }
    }
  }

  branchTenant(id: string) {
    return this.devices.branchTenant(id);
  }

  private details(orders: FakeSalesRepo['orders']) {
    const ids = new Set(orders.map((o) => o.id));
    return {
      orders: orders.map(({ deviceId, ...o }) => ({ ...o, deviceCode: this.devices.devices.find((d) => d.id === deviceId)?.code ?? null })),
      lines: this.lines.filter((l) => ids.has(l.orderId)),
      payments: this.payments.filter((p) => ids.has(p.orderId)),
    };
  }

  async ordersInRange(b: string, from: Date, to: Date) {
    const inRange = (d: Date | null) => d !== null && d >= from && d < to;
    return this.details(
      this.orders
        .filter((o) => o.branchId === b && (inRange(o.closedAt) || (o.status === 'open' && inRange(o.openedAt))))
        .sort((a, b2) => b2.openedAt.getTime() - a.openedAt.getTime() || (b2.id > a.id ? 1 : -1)),
    );
  }

  async findOrder(id: string) {
    return this.details(this.orders.filter((o) => o.id === id));
  }
}

export function fakeRepos() {
  const auth = new FakeAuthRepo();
  const devices = new FakeDevicesRepo(auth);
  const catalog = new FakeCatalogRepo(devices);
  const sales = new FakeSalesRepo(devices);
  const staff = new FakeStaffRepo(devices);
  const sync = new FakeSyncRepo(devices, catalog, sales, staff);
  const repos: Repos = { health: { ping: async () => {} }, auth, catalog, devices, sales, staff, sync };
  return { repos, devices, sync, auth, catalog, sales, staff };
}

/** Fast, NOT secure — only so tests don't spend time on argon2. Auth tests use the real one. */
export const fastHasher: PasswordHasher = {
  hash: async (p) => `fake$${p}`,
  verify: async (h, p) => h === `fake$${p}`,
};

export const testAuthConfig = { jwtSecret: 'test-secret-test-secret-test-secret-123', accessTtlMinutes: 15, refreshTtlDays: 30 };

export function buildTestApp(repos: Repos, opts: { passwordHasher?: PasswordHasher } = {}) {
  return buildApp({ repos, auth: testAuthConfig, logLevel: 'silent', passwordHasher: opts.passwordHasher ?? fastHasher });
}

/** A valid Ed25519 public key shape (43 base64url chars). */
export const publicKey = 'A'.repeat(43);
