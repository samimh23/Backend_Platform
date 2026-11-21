import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { customerRefreshTokens, customers, ownerUsers, passwordResets, refreshTokens } from '../../db/schema.js';
import { hashToken, newToken } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import type { PasswordHasher } from '../../shared/passwords.js';
import type { Mailer } from './mailer.js';
import { resetPasswordEmail } from './templates.js';

/**
 * "Mot de passe oublié" for owners and customers: an email with a one-time link (1 hour).
 * The answer is the same whether the email exists or not, and the email is sent in the
 * background, so nobody can find out who has an account.
 */

export type AccountKind = 'owner' | 'customer';

export interface PasswordResetRepo {
  findAccount(kind: AccountKind, email: string): Promise<{ id: string; name: string; email: string } | null>;
  create(r: { id: string; kind: AccountKind; userId: string; tokenHash: string; expiresAt: Date }): Promise<void>;
  /** Marks the link used, sets the new password and closes every session — all or nothing. false if the link isn't valid. */
  useAndSetPassword(kind: AccountKind, tokenHash: string, passwordHash: string, now: Date): Promise<boolean>;
}

export class DrizzlePasswordResetRepo implements PasswordResetRepo {
  constructor(private readonly db: Db) {}

  async findAccount(kind: AccountKind, email: string) {
    const t = kind === 'owner' ? ownerUsers : customers;
    const [a] = await this.db.select({ id: t.id, name: t.name, email: t.email }).from(t).where(eq(t.email, email));
    return a ?? null;
  }

  async create(r: { id: string; kind: AccountKind; userId: string; tokenHash: string; expiresAt: Date }) {
    await this.db.insert(passwordResets).values(r);
  }

  async useAndSetPassword(kind: AccountKind, tokenHash: string, passwordHash: string, now: Date) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx
        .update(passwordResets)
        .set({ usedAt: now })
        .where(
          and(
            eq(passwordResets.tokenHash, tokenHash),
            eq(passwordResets.kind, kind),
            isNull(passwordResets.usedAt),
            gt(passwordResets.expiresAt, now),
          ),
        )
        .returning({ userId: passwordResets.userId });
      if (!r) return false;
      if (kind === 'owner') {
        await tx.update(ownerUsers).set({ passwordHash, updatedAt: now }).where(eq(ownerUsers.id, r.userId));
        await tx.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.userId, r.userId), isNull(refreshTokens.revokedAt)));
      } else {
        await tx.update(customers).set({ passwordHash }).where(eq(customers.id, r.userId));
        await tx
          .update(customerRefreshTokens)
          .set({ revokedAt: now })
          .where(and(eq(customerRefreshTokens.customerId, r.userId), isNull(customerRefreshTokens.revokedAt)));
      }
      return true;
    });
  }
}

export const ResetErrors = {
  linkInvalid: () => new AppError('RESET_LINK_INVALID', 'This link is expired or was already used', 400),
};

export const RESET_TTL_MINUTES = 60;

export class PasswordResetService {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly repo: PasswordResetRepo,
    private readonly mailer: Mailer,
    private readonly passwords: PasswordHasher,
    private readonly webUrl: string,
    private readonly log: (msg: string, err?: unknown) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Always answers the same; the email (if the account exists) goes out in the background. */
  forgot(kind: AccountKind, email: string): void {
    const job = this.sendLink(kind, email.trim().toLowerCase()).catch((e) => this.log('password reset email failed', e));
    this.inFlight.add(job);
    void job.finally(() => this.inFlight.delete(job));
  }

  /** Tests: wait for background emails. */
  async settled() {
    await Promise.all([...this.inFlight]);
  }

  async reset(kind: AccountKind, token: string, password: string): Promise<void> {
    const hash = await this.passwords.hash(password);
    if (!(await this.repo.useAndSetPassword(kind, hashToken(token), hash, this.now()))) throw ResetErrors.linkInvalid();
  }

  private async sendLink(kind: AccountKind, email: string) {
    const account = await this.repo.findAccount(kind, email);
    if (!account) return;
    const token = newToken();
    await this.repo.create({
      id: newId(),
      kind,
      userId: account.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(this.now().getTime() + RESET_TTL_MINUTES * 60_000),
    });
    const path = kind === 'owner' ? '/reset-password' : '/app/reset-password';
    await this.mailer.send(
      resetPasswordEmail({
        to: account.email,
        name: account.name,
        link: `${this.webUrl}${path}?token=${encodeURIComponent(token)}`,
        minutes: RESET_TTL_MINUTES,
      }),
    );
  }
}

// Spaces around a pasted address are fine: the service trims and lowercases it.
const Email = Type.String({ minLength: 3, maxLength: 254, pattern: '@' });
const Token = Type.String({ minLength: 20, maxLength: 200 });

export const passwordResetRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const resets = app.services.passwordResets;
  const limited = { rateLimit: { max: 5, timeWindow: '1 minute' } };
  const ok = { 200: Type.Object({ ok: Type.Literal(true) }) };

  for (const [prefix, kind, minPassword] of [
    ['/v1/auth', 'owner', 10],
    ['/v1/customer/auth', 'customer', 8],
  ] as const) {
    app.post(
      `${prefix}/password/forgot`,
      { config: limited, schema: { body: Type.Object({ email: Email }, { additionalProperties: false }), response: ok } },
      async (req) => {
        resets.forgot(kind, req.body.email);
        return { ok: true as const };
      },
    );
    app.post(
      `${prefix}/password/reset`,
      {
        config: limited,
        schema: {
          body: Type.Object({ token: Token, password: Type.String({ minLength: minPassword, maxLength: 128 }) }, { additionalProperties: false }),
          response: ok,
        },
      },
      async (req) => {
        await resets.reset(kind, req.body.token, req.body.password);
        return { ok: true as const };
      },
    );
  }
};
