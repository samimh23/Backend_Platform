import { and, eq, isNull, TransactionRollbackError } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { branches, ownerUsers, refreshTokens, tenants, type OwnerRole } from '../../db/schema.js';

export interface UserRecord {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string;
  name: string;
  role: OwnerRole;
}

export interface TenantRecord {
  id: string;
  name: string;
  taxId: string | null;
}

export interface BranchRecord {
  id: string;
  name: string;
  type: string;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface NewAccount {
  tenant: TenantRecord;
  branch: BranchRecord & { type: 'cafe' | 'restaurant' | 'retail' };
  user: UserRecord;
}

export interface AuthRepo {
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  /** Tenant + first branch + owner user, in one transaction. Returns false if the email is taken. */
  createAccount(account: NewAccount): Promise<boolean>;
  getTenant(id: string): Promise<TenantRecord | null>;
  listBranches(tenantId: string): Promise<BranchRecord[]>;
  saveRefreshToken(t: { id: string; userId: string; tokenHash: string; expiresAt: Date }): Promise<void>;
  findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null>;
  /** Marks as revoked. Returns false if it was already revoked (another request used it first). */
  revokeRefreshToken(id: string): Promise<boolean>;
  revokeAllRefreshTokens(userId: string): Promise<void>;
}

export class DrizzleAuthRepo implements AuthRepo {
  constructor(private readonly db: Db) {}

  private readonly userColumns = {
    id: ownerUsers.id,
    tenantId: ownerUsers.tenantId,
    email: ownerUsers.email,
    passwordHash: ownerUsers.passwordHash,
    name: ownerUsers.name,
    role: ownerUsers.role,
  };

  async findUserByEmail(email: string) {
    const [u] = await this.db.select(this.userColumns).from(ownerUsers).where(eq(ownerUsers.email, email)).limit(1);
    return u ?? null;
  }

  async findUserById(id: string) {
    const [u] = await this.db.select(this.userColumns).from(ownerUsers).where(eq(ownerUsers.id, id)).limit(1);
    return u ?? null;
  }

  async createAccount({ tenant, branch, user }: NewAccount): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // Insert the user last; if the email is taken, roll everything back.
      await tx.insert(tenants).values(tenant);
      await tx.insert(branches).values({ ...branch, tenantId: tenant.id });
      const rows = await tx.insert(ownerUsers).values(user).onConflictDoNothing({ target: ownerUsers.email }).returning({ id: ownerUsers.id });
      if (rows.length === 0) {
        tx.rollback();
      }
      return true;
    }).catch((e: unknown) => {
      if (e instanceof TransactionRollbackError) return false;
      throw e;
    });
  }

  async getTenant(id: string) {
    const [t] = await this.db
      .select({ id: tenants.id, name: tenants.name, taxId: tenants.taxId })
      .from(tenants)
      .where(eq(tenants.id, id));
    return t ?? null;
  }

  listBranches(tenantId: string) {
    return this.db
      .select({ id: branches.id, name: branches.name, type: branches.type })
      .from(branches)
      .where(eq(branches.tenantId, tenantId))
      .orderBy(branches.createdAt);
  }

  async saveRefreshToken(t: { id: string; userId: string; tokenHash: string; expiresAt: Date }) {
    await this.db.insert(refreshTokens).values(t);
  }

  async findRefreshToken(tokenHash: string) {
    const [r] = await this.db
      .select({ id: refreshTokens.id, userId: refreshTokens.userId, expiresAt: refreshTokens.expiresAt, revokedAt: refreshTokens.revokedAt })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash));
    return r ?? null;
  }

  async revokeRefreshToken(id: string) {
    const rows = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    return rows.length > 0;
  }

  async revokeAllRefreshTokens(userId: string) {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }
}
