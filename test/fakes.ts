import { v7 } from 'uuid';
import { buildApp, type Repos } from '../src/app.js';
import type { AuthRepo, BranchRecord, NewAccount, RefreshTokenRecord, TenantRecord, UserRecord } from '../src/modules/auth/auth.repo.js';
import type { PasswordHasher } from '../src/shared/passwords.js';
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

  constructor(private readonly devices: FakeDevicesRepo) {}

  async insertEvents(_ctx: unknown, list: SyncEvent[]) {
    const inserted: string[] = [];
    for (const e of list) {
      if (!this.events.has(e.id)) {
        this.events.set(e.id, e);
        inserted.push(e.id);
      }
    }
    return inserted;
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

  async catalogSince(_branchId: string, since: Date | null) {
    return {
      categories: since ? [] : [{ id: v7(), name: 'Boissons chaudes', sortOrder: 1, color: '#8B5E3C' }],
      products: [],
    };
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

export function fakeRepos() {
  const auth = new FakeAuthRepo();
  const devices = new FakeDevicesRepo(auth);
  const sync = new FakeSyncRepo(devices);
  const repos: Repos = { health: { ping: async () => {} }, auth, devices, sync };
  return { repos, devices, sync, auth };
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
