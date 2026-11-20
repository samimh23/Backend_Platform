import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { customerRefreshTokens, customers } from '../../db/schema.js';
import { hashToken, newToken } from '../../shared/crypto.js';
import { AppError, Errors } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import type { PasswordHasher } from '../../shared/passwords.js';
import type { CustomerTokenService } from '../../shared/tokens.js';

// ── Schema ──────────────────────────────────────────────────────

const Email = Type.String({ format: 'email', maxLength: 254 });
const Password = Type.String({ minLength: 8, maxLength: 128 });

export const CustomerSignupBody = Type.Object(
  { email: Email, password: Password, name: Type.String({ minLength: 1, maxLength: 80 }) },
  { additionalProperties: false },
);
export type CustomerSignupBody = Static<typeof CustomerSignupBody>;

export const CustomerLoginBody = Type.Object(
  { email: Email, password: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);
const RefreshBody = Type.Object({ refreshToken: Type.String({ minLength: 20, maxLength: 200 }) }, { additionalProperties: false });

export const CustomerView = Type.Object({ id: Type.String(), email: Type.String(), name: Type.String() });
export type CustomerView = Static<typeof CustomerView>;

export const CustomerAuthResult = Type.Object({
  accessToken: Type.String(),
  expiresIn: Type.Integer(),
  refreshToken: Type.String(),
  customer: CustomerView,
});
export type CustomerAuthResult = Static<typeof CustomerAuthResult>;

// ── Repo ────────────────────────────────────────────────────────

export interface CustomerRecord extends CustomerView {
  passwordHash: string;
}

export interface CustomersRepo {
  findByEmail(email: string): Promise<CustomerRecord | null>;
  findById(id: string): Promise<CustomerRecord | null>;
  /** false if the email is already used. */
  create(c: CustomerRecord): Promise<boolean>;
  saveRefreshToken(t: { id: string; customerId: string; tokenHash: string; expiresAt: Date }): Promise<void>;
  findRefreshToken(tokenHash: string): Promise<{ id: string; customerId: string; expiresAt: Date; revokedAt: Date | null } | null>;
  /** true if it was still active. */
  revokeRefreshToken(id: string): Promise<boolean>;
  revokeAllRefreshTokens(customerId: string): Promise<void>;
}

export class DrizzleCustomersRepo implements CustomersRepo {
  constructor(private readonly db: Db) {}

  async findByEmail(email: string) {
    const [c] = await this.db.select().from(customers).where(eq(customers.email, email));
    return c ?? null;
  }
  async findById(id: string) {
    const [c] = await this.db.select().from(customers).where(eq(customers.id, id));
    return c ?? null;
  }
  async create(c: CustomerRecord) {
    const rows = await this.db.insert(customers).values(c).onConflictDoNothing().returning({ id: customers.id });
    return rows.length === 1;
  }
  async saveRefreshToken(t: { id: string; customerId: string; tokenHash: string; expiresAt: Date }) {
    await this.db.insert(customerRefreshTokens).values(t);
  }
  async findRefreshToken(tokenHash: string) {
    const [t] = await this.db
      .select({
        id: customerRefreshTokens.id,
        customerId: customerRefreshTokens.customerId,
        expiresAt: customerRefreshTokens.expiresAt,
        revokedAt: customerRefreshTokens.revokedAt,
      })
      .from(customerRefreshTokens)
      .where(eq(customerRefreshTokens.tokenHash, tokenHash));
    return t ?? null;
  }
  async revokeRefreshToken(id: string) {
    const rows = await this.db
      .update(customerRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(customerRefreshTokens.id, id), isNull(customerRefreshTokens.revokedAt)))
      .returning({ id: customerRefreshTokens.id });
    return rows.length === 1;
  }
  async revokeAllRefreshTokens(customerId: string) {
    await this.db
      .update(customerRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(customerRefreshTokens.customerId, customerId), isNull(customerRefreshTokens.revokedAt)));
  }
}

// ── Service ─────────────────────────────────────────────────────

export interface CustomerContext {
  customerId: string;
}

export const CustomerErrors = {
  emailTaken: () => new AppError('EMAIL_TAKEN', 'An account already exists with this email', 409),
  invalidCredentials: () => new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect', 401),
  tokenExpired: () => new AppError('TOKEN_EXPIRED', 'Session expired, please log in again', 401),
};

const view = ({ id, email, name }: CustomerRecord): CustomerView => ({ id, email, name });

/** Customer accounts of the loyalty app: same protections as owner accounts, separate tokens. */
export class CustomersService {
  private readonly dummyHash: Promise<string>;

  constructor(
    private readonly repo: CustomersRepo,
    private readonly passwords: PasswordHasher,
    private readonly tokens: CustomerTokenService,
    private readonly refreshTtlDays: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.dummyHash = passwords.hash('dummy-password-for-timing');
  }

  async signup(input: CustomerSignupBody): Promise<CustomerAuthResult> {
    const record: CustomerRecord = {
      id: newId(),
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      passwordHash: await this.passwords.hash(input.password),
    };
    if (!(await this.repo.create(record))) throw CustomerErrors.emailTaken();
    return this.issue(record);
  }

  async login(email: string, password: string): Promise<CustomerAuthResult> {
    const c = await this.repo.findByEmail(email.trim().toLowerCase());
    // Same work whether the email exists or not (no "this email exists" leak by timing).
    const ok = await this.passwords.verify(c?.passwordHash ?? (await this.dummyHash), password);
    if (!c || !ok) throw CustomerErrors.invalidCredentials();
    return this.issue(c);
  }

  /** Rotates the refresh token; reusing an old one closes every session (stolen token). */
  async refresh(refreshToken: string): Promise<CustomerAuthResult> {
    const t = await this.repo.findRefreshToken(hashToken(refreshToken));
    if (!t) throw Errors.unauthorized();
    if (t.revokedAt) {
      await this.repo.revokeAllRefreshTokens(t.customerId);
      throw Errors.unauthorized();
    }
    if (t.expiresAt <= this.now()) throw CustomerErrors.tokenExpired();
    if (!(await this.repo.revokeRefreshToken(t.id))) throw Errors.unauthorized();
    const c = await this.repo.findById(t.customerId);
    if (!c) throw Errors.unauthorized();
    return this.issue(c);
  }

  async logout(refreshToken: string): Promise<void> {
    const t = await this.repo.findRefreshToken(hashToken(refreshToken));
    if (t) await this.repo.revokeRefreshToken(t.id);
  }

  authenticate(authorization: string | undefined): CustomerContext {
    const [scheme, token] = (authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw Errors.unauthorized();
    const claims = this.tokens.verifyAccess(token);
    if (!claims) throw CustomerErrors.tokenExpired();
    return { customerId: claims.sub };
  }

  async me(ctx: CustomerContext): Promise<CustomerView> {
    const c = await this.repo.findById(ctx.customerId);
    if (!c) throw Errors.unauthorized();
    return view(c);
  }

  private async issue(c: CustomerRecord): Promise<CustomerAuthResult> {
    const refreshToken = newToken();
    await this.repo.saveRefreshToken({
      id: newId(),
      customerId: c.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(this.now().getTime() + this.refreshTtlDays * 86_400_000),
    });
    return {
      accessToken: this.tokens.signAccess({ sub: c.id }),
      expiresIn: this.tokens.accessTtlSeconds,
      refreshToken,
      customer: view(c),
    };
  }
}

// ── Routes ──────────────────────────────────────────────────────

const strict = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export const customerAuthRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const customers = app.services.customers;

  app.post(
    '/v1/customer/auth/signup',
    { config: strict, schema: { body: CustomerSignupBody, response: { 200: CustomerAuthResult } } },
    (req) => customers.signup(req.body),
  );
  app.post(
    '/v1/customer/auth/login',
    { config: strict, schema: { body: CustomerLoginBody, response: { 200: CustomerAuthResult } } },
    (req) => customers.login(req.body.email, req.body.password),
  );
  app.post(
    '/v1/customer/auth/refresh',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { body: RefreshBody, response: { 200: CustomerAuthResult } } },
    (req) => customers.refresh(req.body.refreshToken),
  );
  app.post('/v1/customer/auth/logout', { schema: { body: RefreshBody } }, async (req) => {
    await customers.logout(req.body.refreshToken);
    return { ok: true };
  });
  app.get('/v1/customer/me', { schema: { response: { 200: CustomerView } }, preHandler: app.requireCustomer }, (req) =>
    customers.me(req.customer),
  );
};
