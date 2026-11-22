import { v7 } from 'uuid';
import { buildApp, type Repos } from '../src/app.js';
import type { AuthRepo, BranchRecord, NewAccount, RefreshTokenRecord, TenantRecord, UserRecord } from '../src/modules/auth/auth.repo.js';
import type { PasswordHasher } from '../src/shared/passwords.js';
import type { StaffRecord, StaffRepo } from '../src/modules/staff/staff.repo.js';
import type { AreaRecord, FloorRepo, TableRecord } from '../src/modules/floor/floor.repo.js';
import type { DeviceContext } from '../src/modules/devices/devices.service.js';
import { projectEvents, type ProjectionOp } from '../src/modules/sales/sales.projection.js';
import type { SalesLineRecord, SalesOrderRecord, SalesPaymentRecord, SalesRepo } from '../src/modules/sales/sales.repo.js';
import type { CatalogRepo, CategoryRecord, ProductRecord } from '../src/modules/catalog/catalog.repo.js';
import type { CashMovementRecord, CashRepo, CashSessionRecord } from '../src/modules/cash/cash.repo.js';
import type { BusinessRecord, BusinessRepo, UpdateBusinessBody } from '../src/modules/business/business.js';
import type { DeviceRecord, DeviceSummary, DevicesRepo, NewDevice, PairingCodeRecord, PairingContext } from '../src/modules/devices/devices.repo.js';
import type { SyncErrorRecord, SyncRepo } from '../src/modules/sync/sync.repo.js';
import type { SyncEvent } from '../src/modules/sync/sync.schema.js';
import type { CustomerRecord, CustomersRepo } from '../src/modules/customers/customers.js';
import type { CafeRecord, LoyaltyProgramView, LoyaltyRepo } from '../src/modules/loyalty/loyalty.js';
import type { RedemptionRecord, RedemptionsRepo } from '../src/modules/loyalty/redemptions.js';
import type { ClubRepo, GiftRecord } from '../src/modules/loyalty/club.js';
import type { StockItemRecord, StockRepo } from '../src/modules/stock/stock.js';
import type { DailySummaryRepo } from '../src/modules/mail/daily-summary.js';
import { MemoryMailer } from '../src/modules/mail/mailer.js';
import type { AccountKind, PasswordResetRepo } from '../src/modules/mail/password-reset.js';
import type { NewNotification, NotificationsRepo, RecipientKind } from '../src/modules/notifications/notifications.js';
import { ownerNotices, stockLowNotice } from '../src/modules/notifications/sales-notices.js';
import { todayInTunis } from '../src/modules/sales/sales.service.js';
import { crossedLow, type CrossedLow } from '../src/modules/stock/stock.js';

/** In-memory repos: test HTTP + services without Postgres. */

export const tenantId = v7();
export const branchId = v7();

type FakeDevice = NewDevice & {
  disabled: boolean;
  lastSeq: number;
  lastSeenAt: Date | null;
  createdAt: Date;
  canTakePayments: boolean;
  lanAddresses: string[];
  lanPort: number | null;
};
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
    if (d.role === 'hub') {
      for (const old of this.devices.filter((x) => x.branchId === b && x.role === 'hub')) {
        Object.assign(old, { role: 'pos', canTakePayments: true, lanAddresses: [], lanPort: null });
      }
    }
    this.devices.push({
      ...d,
      disabled: false,
      lastSeq: 0,
      lastSeenAt: null,
      createdAt: new Date(),
      canTakePayments: false,
      lanAddresses: [],
      lanPort: null,
    });
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
    const { tenantId: _t, publicKey: _p, tokenHash: _h, ...summary } = d;
    return summary;
  }

  async listDevices(id: string) {
    return this.devices.filter((d) => d.branchId === id).map((d) => this.summary(d));
  }

  async findDevice(id: string) {
    const d = this.devices.find((x) => x.id === id);
    return d ? { ...this.summary(d), tenantId: d.tenantId } : null;
  }

  lanKeys = new Map<string, string>();
  async setLan(deviceId: string, addresses: string[], port: number) {
    const d = this.devices.find((x) => x.id === deviceId);
    if (d) Object.assign(d, { lanAddresses: addresses, lanPort: port });
  }
  async ensureLanKey(b: string, candidate: string) {
    if (!this.lanKeys.has(b)) this.lanKeys.set(b, candidate);
    return this.lanKeys.get(b)!;
  }

  async updateDevice(id: string, changes: { name?: string; disabled?: boolean; canTakePayments?: boolean }) {
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
    private readonly floor: FakeFloorRepo,
  ) {}

  async floorSince(b: string, since: Date | null) {
    const pick = <T extends { branchId: string; updatedAt: Date; deletedAt: Date | null }>(rows: T[]) =>
      rows.filter((r) => r.branchId === b && (since ? r.updatedAt > since : r.deletedAt === null));
    return {
      areas: pick(this.floor.areas).map(({ id, name, sortOrder, deletedAt }) => ({ id, name, sortOrder, deleted: deletedAt !== null })),
      tables: pick(this.floor.tables).map(({ branchId: _b, updatedAt: _u, deletedAt, ...t }) => ({
        ...t,
        deleted: deletedAt !== null,
      })),
    };
  }

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
    await this.sales.apply(ctx, ops);
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

export class FakeFloorRepo implements FloorRepo {
  areas: (AreaRecord & Stamped)[] = [];
  tables: (TableRecord & Stamped)[] = [];
  constructor(private readonly devices: FakeDevicesRepo) {}
  branchTenant(id: string) {
    return this.devices.branchTenant(id);
  }
  private strip<T extends Stamped>({ updatedAt: _u, deletedAt: _d, ...r }: T) {
    return r;
  }
  private sorted<T extends { sortOrder: number; name: string }>(rows: T[]) {
    return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }
  async listAreas(b: string) {
    return this.sorted(this.areas.filter((a) => a.branchId === b && !a.deletedAt)).map((a) => this.strip(a));
  }
  async listTables(b: string) {
    return this.sorted(this.tables.filter((t) => t.branchId === b && !t.deletedAt)).map((t) => this.strip(t));
  }
  async findArea(id: string) {
    const a = this.areas.find((x) => x.id === id && !x.deletedAt);
    return a ? this.strip(a) : null;
  }
  async findTable(id: string) {
    const t = this.tables.find((x) => x.id === id && !x.deletedAt);
    return t ? this.strip(t) : null;
  }
  async insertArea(a: AreaRecord, now: Date) {
    this.areas.push({ ...a, updatedAt: now, deletedAt: null });
  }
  async updateArea(id: string, changes: Partial<AreaRecord>, now: Date) {
    const a = this.areas.find((x) => x.id === id && !x.deletedAt);
    if (!a) return null;
    Object.assign(a, changes, { updatedAt: now });
    return this.strip(a);
  }
  async softDeleteArea(id: string, now: Date) {
    const a = this.areas.find((x) => x.id === id);
    if (a) Object.assign(a, { deletedAt: now, updatedAt: now });
  }
  async countTables(areaId: string) {
    return this.tables.filter((t) => t.areaId === areaId && !t.deletedAt).length;
  }
  async insertTables(list: TableRecord[], now: Date) {
    for (const t of list) this.tables.push({ ...t, updatedAt: now, deletedAt: null });
  }
  async updateTable(id: string, changes: Partial<TableRecord>, now: Date) {
    const t = this.tables.find((x) => x.id === id && !x.deletedAt);
    if (!t) return null;
    Object.assign(t, changes, { updatedAt: now });
    return this.strip(t);
  }
  async softDeleteTable(id: string, now: Date) {
    const t = this.tables.find((x) => x.id === id);
    if (t) Object.assign(t, { deletedAt: now, updatedAt: now });
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
  orders: (Omit<SalesOrderRecord, 'deviceCode'> & { deviceId: string; tableId: string | null })[] = [];
  lines: SalesLineRecord[] = [];
  payments: SalesPaymentRecord[] = [];
  cashSessions: CashSessionRecord[] = [];
  cashMovements: CashMovementRecord[] = [];

  loyalty?: FakeLoyaltyRepo;
  stock?: FakeStockRepo;
  notifications?: FakeNotificationsRepo;
  cashCodes = new Map<string, string>();
  constructor(private readonly devices: FakeDevicesRepo) {}

  /** Same notices as the real apply (sales.apply.ts). */
  async apply(ctx: DeviceContext, ops: ProjectionOp[]) {
    const low = this.applyOps(ctx, ops);
    const notices = [
      ...(await ownerNotices(ops, ctx.branchId, {
        line: async (id) => {
          const l = this.lines.find((x) => x.id === id);
          return l ? { name: l.name, qty: l.qty, orderId: l.orderId, receiptNumber: this.orders.find((o) => o.id === l.orderId)?.receiptNumber ?? null } : null;
        },
        receiptNumber: async (id) => this.orders.find((o) => o.id === id)?.receiptNumber ?? null,
        drawerCode: async (sessionId) => {
          const s = this.cashSessions.find((x) => x.id === sessionId);
          return s ? (this.devices.devices.find((d) => d.id === s.drawerDeviceId)?.code ?? null) : null;
        },
      })),
      ...low.map((i) => stockLowNotice(i, ctx.branchId, todayInTunis(new Date()))),
    ];
    for (const n of notices) await this.notifications?.forOwners(ctx.tenantId, n);
  }

  private applyOps(ctx: DeviceContext, ops: ProjectionOp[]): CrossedLow[] {
    const low: CrossedLow[] = [];
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
              tableId: op.table?.id ?? null,
              tableName: op.table?.name ?? null,
              refundedAt: null,
              refundReason: null,
            });
          break;
        case 'moveTable':
          if (order) Object.assign(order, { tableId: op.table?.id ?? null, tableName: op.table?.name ?? null, type: op.table ? 'table' : 'takeaway' });
          break;
        case 'addLine':
          if (!this.lines.some((l) => l.id === op.line.id))
            this.lines.push({ ...op.line, orderId: op.orderId, voided: false, discountType: null, discountValue: 0, discountReason: null, voidReason: null });
          break;
        case 'setLineQty':
          for (const l of this.lines) if (l.id === op.lineId) l.qty = op.qty;
          break;
        case 'voidLine':
          for (const l of this.lines) if (l.id === op.lineId) Object.assign(l, { voided: true, voidReason: op.why });
          break;
        case 'refundOrder':
          for (const p of op.payments) {
            if (!this.payments.some((x) => (x as { id?: string }).id === p.id))
              this.payments.push({ id: p.id, orderId: op.orderId, method: p.method, amount: p.amount, tendered: 0, changeGiven: 0 } as SalesPaymentRecord);
          }
          if (order) Object.assign(order, { status: 'refunded', refundedAt: op.refundedAt, refundReason: op.reason });
          this.loyalty?.takeBack(op.orderId, op.refundedAt);
          break;
        case 'discountLines':
          for (const d of op.lines) {
            const l = this.lines.find((x) => x.id === d.lineId);
            if (l) Object.assign(l, { discountType: d.type, discountValue: d.type ? d.value : 0, discountReason: d.type ? op.reason : null });
          }
          break;
        case 'payment':
          this.payments.push({ ...op.payment, orderId: op.orderId });
          if (order) order.paymentMethod = !order.paymentMethod || order.paymentMethod === op.payment.method ? op.payment.method : 'mixed';
          break;
        case 'closeOrder':
          if (order) Object.assign(order, { status: 'paid', closedAt: op.closedAt, total: op.total, itemCount: op.itemCount, receiptNumber: op.receiptNumber });
          low.push(...(this.stock?.consume(op.orderId, ctx.branchId) ?? []));
          break;
        case 'cancelOrder':
          if (order) Object.assign(order, { status: 'cancelled', closedAt: op.closedAt });
          break;
        case 'openCashSession':
          if (!this.cashSessions.some((s) => s.id === op.sessionId))
            this.cashSessions.push({
              id: op.sessionId,
              tenantId: ctx.tenantId,
              branchId: ctx.branchId,
              drawerDeviceId: op.drawerId,
              status: 'open',
              openedAt: op.openedAt,
              openedBy: op.staffId,
              openingFloat: op.openingFloat,
              closedAt: null,
              closedBy: null,
              countedCash: null,
              expectedCash: null,
              difference: null,
              cashSales: 0,
              cardSales: 0,
              cashIn: 0,
              cashOut: 0,
              ticketCount: 0,
              note: null,
            });
          break;
        case 'cashMovement':
          if (!this.cashMovements.some((m) => m.id === op.movement.id))
            this.cashMovements.push({ ...op.movement, sessionId: op.sessionId });
          break;
        case 'closeCashSession': {
          const s = this.cashSessions.find((x) => x.id === op.sessionId);
          if (s) Object.assign(s, { status: 'closed', closedAt: op.closedAt, closedBy: op.staffId, note: op.note, ...op.totals });
          break;
        }
      }
    }
    return low;
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

/** Reads the cash sessions the fake sales store projected. */
export class FakeCashRepo implements CashRepo {
  constructor(
    private readonly sales: FakeSalesRepo,
    private readonly devices: FakeDevicesRepo,
    private readonly staff: FakeStaffRepo,
  ) {}
  branchTenant(id: string) {
    return this.devices.branchTenant(id);
  }
  async listSessions(b: string, window: { from: Date; to: Date } | null, limit: number) {
    return this.sales.cashSessions
      .filter((s) => s.branchId === b && (!window || (s.openedAt >= window.from && s.openedAt < window.to)))
      .sort((x, y) => y.openedAt.getTime() - x.openedAt.getTime() || (y.id > x.id ? 1 : -1))
      .slice(0, limit);
  }
  async findSession(id: string) {
    return this.sales.cashSessions.find((s) => s.id === id) ?? null;
  }
  async movements(sessionId: string) {
    return this.sales.cashMovements.filter((m) => m.sessionId === sessionId);
  }
  async staffNames(ids: string[]) {
    return new Map(this.staff.rows.filter((r) => ids.includes(r.id)).map((r) => [r.id, r.name]));
  }
  async deviceNames(ids: string[]) {
    return new Map(this.devices.devices.filter((d) => ids.includes(d.id)).map((d) => [d.id, { code: d.code, name: d.name }]));
  }
}

/** Café details on top of the fake auth store (tenants + branches). */
type BusinessExtra = { address: string | null; phone: string | null; receiptFooter: string | null; listed: boolean; city: string | null };
const noExtra: BusinessExtra = { address: null, phone: null, receiptFooter: null, listed: false, city: null };

export class FakeBusinessRepo implements BusinessRepo {
  extra = new Map<string, BusinessExtra>();
  loyalty?: FakeLoyaltyRepo;
  constructor(private readonly auth: FakeAuthRepo) {}
  async find(branchId: string): Promise<BusinessRecord | null> {
    const b = this.auth.branches.find((x) => x.id === branchId);
    const t = b && this.auth.tenants.find((x) => x.id === b.tenantId);
    if (!b || !t) return null;
    const e = this.extra.get(branchId) ?? noExtra;
    const loyaltyEnabled = this.loyalty?.programs.get(branchId)?.enabled ?? false;
    return { tenantId: t.id, businessName: t.name, taxId: t.taxId, branchName: b.name, ...e, loyaltyEnabled };
  }
  async update(branchId: string, tenantId: string, c: UpdateBusinessBody) {
    const t = this.auth.tenants.find((x) => x.id === tenantId)!;
    const b = this.auth.branches.find((x) => x.id === branchId)!;
    if (c.businessName !== undefined) t.name = c.businessName;
    if (c.taxId !== undefined) t.taxId = c.taxId;
    if (c.branchName !== undefined) b.name = c.branchName;
    const e = this.extra.get(branchId) ?? noExtra;
    this.extra.set(branchId, {
      address: c.address !== undefined ? c.address : e.address,
      phone: c.phone !== undefined ? c.phone : e.phone,
      receiptFooter: c.receiptFooter !== undefined ? c.receiptFooter : e.receiptFooter,
      listed: c.listed ?? e.listed,
      city: c.city !== undefined ? c.city : e.city,
    });
  }
}

export class FakeCustomersRepo implements CustomersRepo {
  customers: CustomerRecord[] = [];
  tokens: { id: string; customerId: string; tokenHash: string; expiresAt: Date; revokedAt: Date | null }[] = [];
  async findByEmail(email: string) {
    return this.customers.find((c) => c.email === email) ?? null;
  }
  async findById(id: string) {
    return this.customers.find((c) => c.id === id) ?? null;
  }
  async create(c: CustomerRecord) {
    if (this.customers.some((x) => x.email === c.email)) return false;
    this.customers.push(c);
    return true;
  }
  async saveRefreshToken(t: { id: string; customerId: string; tokenHash: string; expiresAt: Date }) {
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
  async revokeAllRefreshTokens(customerId: string) {
    for (const t of this.tokens) if (t.customerId === customerId && !t.revokedAt) t.revokedAt = new Date();
  }
}

type LedgerRow = {
  customerId: string;
  branchId: string;
  points: number;
  kind: 'earn' | 'redeem' | 'refund';
  orderId: string | null;
  receiptNumber: string | null;
  rewardName: string | null;
  createdAt: Date;
};

export class FakeLoyaltyRepo implements LoyaltyRepo {
  programs = new Map<string, LoyaltyProgramView>();
  ledger: LedgerRow[] = [];
  constructor(
    private readonly auth: FakeAuthRepo,
    private readonly business: FakeBusinessRepo,
    private readonly devices: FakeDevicesRepo,
    private readonly sales: FakeSalesRepo,
  ) {}

  async listCafes(q: string | null) {
    const all = await Promise.all(this.auth.branches.map((b) => this.cafe(b.id)));
    return all
      .filter((c): c is CafeRecord => !!c && c.listed)
      .filter((c) => !q || [c.name, c.businessName, c.city ?? ''].some((s) => s.toLowerCase().includes(q.toLowerCase())))
      .map((c) => ({ ...c, program: this.programs.get(c.id) ?? null }));
  }
  async cafe(branchId: string): Promise<CafeRecord | null> {
    const r = await this.business.find(branchId);
    if (!r) return null;
    return {
      id: branchId,
      tenantId: r.tenantId,
      name: r.branchName,
      businessName: r.businessName,
      city: r.city,
      address: r.address,
      phone: r.phone,
      listed: r.listed,
    };
  }
  async program(branchId: string) {
    return this.programs.get(branchId) ?? null;
  }
  async saveProgram(branchId: string, p: LoyaltyProgramView) {
    this.programs.set(branchId, p);
  }
  async device(id: string) {
    const d = this.devices.devices.find((x) => x.id === id);
    return d ? { branchId: d.branchId, publicKey: d.publicKey, disabled: d.disabled } : null;
  }
  async orderStatus(orderId: string) {
    return this.sales.orders.find((o) => o.id === orderId)?.status ?? null;
  }
  async earn(e: { customerId: string; branchId: string; points: number; orderId: string; receiptNumber: string }) {
    if (this.ledger.some((l) => l.orderId === e.orderId && l.kind === 'earn')) return false;
    this.ledger.push({ ...e, kind: 'earn', rewardName: null, createdAt: new Date() });
    return true;
  }
  takeBack(orderId: string, at: Date) {
    const earn = this.ledger.find((l) => l.orderId === orderId && l.kind === 'earn');
    if (earn && !this.ledger.some((l) => l.orderId === orderId && l.kind === 'refund')) {
      this.ledger.push({ ...earn, points: -earn.points, kind: 'refund', createdAt: at });
    }
  }
  async balance(customerId: string, branchId: string) {
    return this.ledger.filter((l) => l.customerId === customerId && l.branchId === branchId).reduce((s, l) => s + l.points, 0);
  }
  async balances(customerId: string) {
    const ids = [...new Set(this.ledger.filter((l) => l.customerId === customerId).map((l) => l.branchId))];
    return Promise.all(ids.map(async (branchId) => ({ branchId, balance: await this.balance(customerId, branchId) })));
  }
  async history(customerId: string, branchId: string) {
    return this.ledger
      .filter((l) => l.customerId === customerId && l.branchId === branchId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(({ points, kind, receiptNumber, rewardName, createdAt }) => ({ points, kind, receiptNumber, rewardName, createdAt }));
  }
}

export class FakeClubRepo implements ClubRepo {
  consents = new Map<string, boolean>();
  gifts: (GiftRecord & { createdAt: Date; orderId: string | null })[] = [];
  constructor(
    private readonly devices: FakeDevicesRepo,
    private readonly customers: FakeCustomersRepo,
    private readonly loyalty: FakeLoyaltyRepo,
    private readonly sales: FakeSalesRepo,
    private readonly auth: FakeAuthRepo,
  ) {}
  branchTenant(id: string) {
    return this.devices.branchTenant(id);
  }
  async setOptIn(customerId: string, branchId: string, optIn: boolean) {
    this.consents.set(`${customerId}|${branchId}`, optIn);
  }
  async optIn(customerId: string, branchId: string) {
    return this.consents.get(`${customerId}|${branchId}`) ?? false;
  }
  async customerCount(branchId: string) {
    return new Set(this.loyalty.ledger.filter((l) => l.branchId === branchId).map((l) => l.customerId)).size;
  }
  async members(branchId: string) {
    return this.customers.customers
      .filter((c) => this.consents.get(`${c.id}|${branchId}`))
      .map((c) => {
        const orders = this.loyalty.ledger
          .filter((l) => l.customerId === c.id && l.branchId === branchId && l.kind === 'earn')
          .map((l) => this.sales.orders.find((o) => o.id === l.orderId))
          .filter((o) => o?.status === 'paid');
        const last = orders.map((o) => o!.closedAt!).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
        return {
          id: c.id,
          name: c.name,
          visits: orders.length,
          spent: orders.reduce((s, o) => s + o!.total, 0),
          points: this.loyalty.ledger.filter((l) => l.customerId === c.id && l.branchId === branchId).reduce((s, l) => s + l.points, 0),
          lastVisit: last,
        };
      });
  }
  async optedIn(branchId: string, ids: string[]) {
    return ids.filter((id) => this.consents.get(`${id}|${branchId}`));
  }
  async createGifts(gifts: (GiftRecord & { createdBy: string })[]) {
    for (const { createdBy: _c, ...g } of gifts) this.gifts.push({ ...g, createdAt: new Date(), orderId: null });
  }
  async campaigns(branchId: string) {
    const ids = [...new Set(this.gifts.filter((g) => g.branchId === branchId).map((g) => g.campaignId))];
    return ids.map((id) => {
      const gs = this.gifts.filter((g) => g.campaignId === id);
      return { id, name: gs[0]!.name, kind: gs[0]!.kind, sentAt: gs[0]!.createdAt, expiresAt: gs[0]!.expiresAt, sent: gs.length, used: gs.filter((g) => g.usedAt).length };
    });
  }
  async activeGifts(customerId: string, now: Date, branchId?: string) {
    return this.gifts
      .filter((g) => g.customerId === customerId && !g.usedAt && g.expiresAt > now && (!branchId || g.branchId === branchId))
      .map((g) => ({ ...g, cafeName: this.auth.branches.find((b) => b.id === g.branchId)?.name ?? '' }));
  }
  async gift(id: string) {
    return this.gifts.find((g) => g.id === id) ?? null;
  }
  async branchName(branchId: string) {
    return this.auth.branches.find((b) => b.id === branchId)?.name ?? null;
  }
  async customerName(customerId: string) {
    return this.customers.customers.find((c) => c.id === customerId)?.name ?? null;
  }
  async giftsExpiring(now: Date, before: Date) {
    return this.gifts
      .filter((g) => !g.usedAt && g.expiresAt > now && g.expiresAt < before)
      .map((g) => ({ ...g, cafeName: this.auth.branches.find((b) => b.id === g.branchId)?.name ?? '' }));
  }
}

type FakeNotification = NewNotification & { id: string; recipientKind: RecipientKind; recipientId: string; readAt: Date | null; createdAt: Date };

export class FakeNotificationsRepo implements NotificationsRepo {
  rows: FakeNotification[] = [];
  constructor(private readonly auth: FakeAuthRepo) {}
  private add(recipientKind: RecipientKind, recipientId: string, n: NewNotification) {
    if (n.dedupeKey && this.rows.some((r) => r.recipientKind === recipientKind && r.recipientId === recipientId && r.dedupeKey === n.dedupeKey)) return;
    this.rows.push({ ...n, id: v7(), recipientKind, recipientId, readAt: null, createdAt: new Date() });
  }
  async forOwners(tenantId: string, n: NewNotification) {
    for (const u of this.auth.users.filter((x) => x.tenantId === tenantId)) this.add('owner', u.id, n);
  }
  async forCustomer(customerId: string, n: NewNotification) {
    this.add('customer', customerId, n);
  }
  private mine(kind: RecipientKind, id: string) {
    return this.rows.filter((r) => r.recipientKind === kind && r.recipientId === id);
  }
  async list(kind: RecipientKind, id: string, limit: number) {
    return this.mine(kind, id)
      .slice()
      .reverse()
      .slice(0, limit)
      .map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link ?? null, readAt: r.readAt, createdAt: r.createdAt }));
  }
  async unread(kind: RecipientKind, id: string) {
    return this.mine(kind, id).filter((r) => !r.readAt).length;
  }
  async markRead(kind: RecipientKind, id: string, ids: string[] | null, at: Date) {
    for (const r of this.mine(kind, id)) if (!r.readAt && (!ids || ids.includes(r.id))) r.readAt = at;
  }
}

export class FakeRedemptionsRepo implements RedemptionsRepo {
  rows: (RedemptionRecord & { usedAt: Date | null; cancelledAt: Date | null; orderId: string | null })[] = [];
  club?: FakeClubRepo;
  constructor(
    private readonly loyalty: FakeLoyaltyRepo,
    private readonly customers: FakeCustomersRepo,
  ) {}
  private live(branchId: string, code: string, now: Date) {
    return this.rows.find((r) => r.branchId === branchId && r.code === code && !r.usedAt && !r.cancelledAt && r.expiresAt > now);
  }
  async codeTaken(branchId: string, code: string, now: Date) {
    return !!this.live(branchId, code, now);
  }
  async cancelPending(customerId: string, branchId: string, now: Date) {
    for (const r of this.rows) if (r.customerId === customerId && r.branchId === branchId && !r.usedAt && !r.cancelledAt) r.cancelledAt = now;
  }
  async create(r: RedemptionRecord) {
    this.rows.push({ ...r, usedAt: null, cancelledAt: null, orderId: null });
  }
  async findLive(branchId: string, code: string, now: Date) {
    const r = this.live(branchId, code, now);
    if (!r) return null;
    const { usedAt: _u, cancelledAt: _c, orderId: _o, ...rec } = r;
    return { ...rec, customerName: this.customers.customers.find((c) => c.id === r.customerId)?.name ?? '' };
  }
  async redeem(r: RedemptionRecord, use: { orderId: string; deviceId: string; at: Date }) {
    const row = this.rows.find((x) => x.id === r.id);
    if (!row || row.usedAt || row.cancelledAt) return false;
    if (r.giftId) {
      const g = this.club?.gifts.find((x) => x.id === r.giftId);
      if (!g || g.usedAt) return false;
      Object.assign(g, { usedAt: use.at, orderId: use.orderId });
    }
    Object.assign(row, { usedAt: use.at, orderId: use.orderId });
    if (r.points === 0) return true;
    this.loyalty.ledger.push({
      customerId: r.customerId,
      branchId: r.branchId,
      points: -r.points,
      kind: 'redeem',
      orderId: use.orderId,
      receiptNumber: null,
      rewardName: r.rewardName,
      createdAt: use.at,
    });
    return true;
  }
}

type FakeMovement = {
  stockItemId: string;
  kind: string;
  delta: number;
  quantityAfter: number;
  note: string | null;
  orderId: string | null;
  createdAt: Date;
};

export class FakeStockRepo implements StockRepo {
  items: StockItemRecord[] = [];
  recipes: { productId: string; stockItemId: string; qty: number }[] = [];
  moves: FakeMovement[] = [];
  constructor(
    private readonly devices: FakeDevicesRepo,
    private readonly catalog: FakeCatalogRepo,
    private readonly sales: FakeSalesRepo,
  ) {}
  branchTenant(id: string) {
    return this.devices.branchTenant(id);
  }
  async productBranch(productId: string) {
    return (await this.catalog.findProduct(productId))?.branchId ?? null;
  }
  async item(id: string) {
    const i = this.items.find((x) => x.id === id);
    return i ? { ...i } : null;
  }
  async listItems(branchId: string) {
    return this.items.filter((i) => i.branchId === branchId).sort((a, b) => a.name.localeCompare(b.name));
  }
  async listRecipes(branchId: string) {
    const ids = new Set(this.items.filter((i) => i.branchId === branchId).map((i) => i.id));
    return this.recipes.filter((r) => ids.has(r.stockItemId));
  }
  async createItem(item: StockItemRecord) {
    this.items.push({ ...item });
  }
  async updateItem(id: string, patch: Partial<StockItemRecord>) {
    Object.assign(this.items.find((i) => i.id === id)!, patch);
  }
  async move(id: string, m: { kind: 'delivery' | 'waste' | 'count'; quantity: number; note: string | null }) {
    const i = this.items.find((x) => x.id === id)!;
    const delta = m.kind === 'delivery' ? m.quantity : m.kind === 'waste' ? -m.quantity : m.quantity - i.quantity;
    i.quantity += delta;
    this.moves.push({ stockItemId: id, kind: m.kind, delta, quantityAfter: i.quantity, note: m.note, orderId: null, createdAt: new Date() });
    return i.quantity;
  }
  async movements(id: string, limit: number) {
    return this.moves.filter((m) => m.stockItemId === id).reverse().slice(0, limit);
  }
  async setRecipe(productId: string, lines: { stockItemId: string; qty: number }[]) {
    this.recipes = [...this.recipes.filter((r) => r.productId !== productId), ...lines.map((l) => ({ productId, ...l }))];
  }
  /** Same rule as consumeForOrder (SQL): recipes × quantities of the ticket's items, once. */
  consume(orderId: string, branchId: string): CrossedLow[] {
    const crossed: CrossedLow[] = [];
    const used = new Map<string, number>();
    for (const l of this.sales.lines.filter((x) => x.orderId === orderId && !x.voided)) {
      for (const r of this.recipes.filter((x) => x.productId === l.productId)) used.set(r.stockItemId, (used.get(r.stockItemId) ?? 0) + l.qty * r.qty);
    }
    for (const [stockItemId, n] of used) {
      const i = this.items.find((x) => x.id === stockItemId && x.branchId === branchId);
      if (!i || this.moves.some((m) => m.kind === 'sale' && m.orderId === orderId && m.stockItemId === stockItemId)) continue;
      i.quantity -= n;
      this.moves.push({ stockItemId, kind: 'sale', delta: -n, quantityAfter: i.quantity, note: null, orderId, createdAt: new Date() });
      if (i.lowThreshold !== null && !i.archived && crossedLow(i.quantity + n, i.quantity, i.lowThreshold)) {
        crossed.push({ id: i.id, name: i.name, unit: i.unit, quantity: i.quantity, lowThreshold: i.lowThreshold });
      }
    }
    return crossed;
  }
}

export class FakePasswordResetRepo implements PasswordResetRepo {
  links: { id: string; kind: AccountKind; userId: string; tokenHash: string; expiresAt: Date; usedAt: Date | null }[] = [];
  constructor(
    private readonly auth: FakeAuthRepo,
    private readonly customers: FakeCustomersRepo,
  ) {}
  async findAccount(kind: AccountKind, email: string) {
    const a = kind === 'owner' ? this.auth.users.find((u) => u.email === email) : this.customers.customers.find((c) => c.email === email);
    return a ? { id: a.id, name: a.name, email: a.email } : null;
  }
  async create(r: { id: string; kind: AccountKind; userId: string; tokenHash: string; expiresAt: Date }) {
    this.links.push({ ...r, usedAt: null });
  }
  async useAndSetPassword(kind: AccountKind, tokenHash: string, passwordHash: string, now: Date) {
    const l = this.links.find((x) => x.tokenHash === tokenHash && x.kind === kind && !x.usedAt && x.expiresAt > now);
    if (!l) return false;
    l.usedAt = now;
    if (kind === 'owner') {
      this.auth.users.find((u) => u.id === l.userId)!.passwordHash = passwordHash;
      for (const t of this.auth.tokens) if (t.userId === l.userId && !t.revokedAt) t.revokedAt = now;
    } else {
      this.customers.customers.find((c) => c.id === l.userId)!.passwordHash = passwordHash;
      for (const t of this.customers.tokens) if (t.customerId === l.userId && !t.revokedAt) t.revokedAt = now;
    }
    return true;
  }
}

export class FakeDailySummaryRepo implements DailySummaryRepo {
  prefs = new Map<string, boolean>();
  sentFor = new Map<string, string>();
  gaps: { branchId: string; drawer: string; difference: number; closedAt: Date }[] = [];
  constructor(private readonly auth: FakeAuthRepo) {}
  async dueOwners(day: string) {
    return this.auth.users
      .filter((u) => u.role === 'owner' && (this.prefs.get(u.id) ?? true) && (this.sentFor.get(u.id) ?? '') < day)
      .map((u) => ({ id: u.id, tenantId: u.tenantId, name: u.name, email: u.email }));
  }
  async claim(userId: string, day: string) {
    if ((this.sentFor.get(userId) ?? '') >= day) return false;
    this.sentFor.set(userId, day);
    return true;
  }
  async branches(tenantId: string) {
    return this.auth.branches.filter((b) => b.tenantId === tenantId).map(({ id, name }) => ({ id, name }));
  }
  async cashGaps(branchId: string, from: Date, to: Date) {
    return this.gaps.filter((g) => g.branchId === branchId && g.closedAt >= from && g.closedAt < to);
  }
  async preference(userId: string) {
    return this.prefs.get(userId) ?? true;
  }
  async setPreference(userId: string, on: boolean) {
    this.prefs.set(userId, on);
  }
}

export function fakeRepos() {
  const auth = new FakeAuthRepo();
  const devices = new FakeDevicesRepo(auth);
  const catalog = new FakeCatalogRepo(devices);
  const sales = new FakeSalesRepo(devices);
  const staff = new FakeStaffRepo(devices);
  const floor = new FakeFloorRepo(devices);
  const sync = new FakeSyncRepo(devices, catalog, sales, staff, floor);
  const cash = new FakeCashRepo(sales, devices, staff);
  const business = new FakeBusinessRepo(auth);
  const customers = new FakeCustomersRepo();
  const loyalty = new FakeLoyaltyRepo(auth, business, devices, sales);
  business.loyalty = loyalty;
  sales.loyalty = loyalty;
  const redemptions = new FakeRedemptionsRepo(loyalty, customers);
  const club = new FakeClubRepo(devices, customers, loyalty, sales, auth);
  redemptions.club = club;
  const stock = new FakeStockRepo(devices, catalog, sales);
  sales.stock = stock;
  const passwordResets = new FakePasswordResetRepo(auth, customers);
  const notifications = new FakeNotificationsRepo(auth);
  sales.notifications = notifications;
  const dailySummary = new FakeDailySummaryRepo(auth);
  const repos: Repos = {
    health: { ping: async () => {} },
    auth,
    business,
    cash,
    catalog,
    club,
    customers,
    dailySummary,
    devices,
    floor,
    loyalty,
    notifications,
    passwordResets,
    redemptions,
    sales,
    staff,
    stock,
    sync,
  };
  return { repos, devices, sync, auth, catalog, sales, staff, floor, business, customers, loyalty, redemptions, stock, club, passwordResets, dailySummary, notifications };
}

/** Fast, NOT secure — only so tests don't spend time on argon2. Auth tests use the real one. */
export const fastHasher: PasswordHasher = {
  hash: async (p) => `fake$${p}`,
  verify: async (h, p) => h === `fake$${p}`,
};

export const testAuthConfig = { jwtSecret: 'test-secret-test-secret-test-secret-123', accessTtlMinutes: 15, refreshTtlDays: 30 };

export function buildTestApp(repos: Repos, opts: { passwordHasher?: PasswordHasher; mailer?: MemoryMailer } = {}) {
  return buildApp({
    repos,
    auth: testAuthConfig,
    logLevel: 'silent',
    passwordHasher: opts.passwordHasher ?? fastHasher,
    mailer: opts.mailer ?? new MemoryMailer(),
    webUrl: 'https://kahwti.test',
  });
}

/** A valid Ed25519 public key shape (43 base64url chars). */
export const publicKey = 'A'.repeat(43);
