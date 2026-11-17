import { AppError, Errors } from '../../shared/errors.js';
import { hashToken, newToken } from '../../shared/crypto.js';
import { newId } from '../../shared/ids.js';
import type { PasswordHasher } from '../../shared/passwords.js';
import type { TokenService } from '../../shared/tokens.js';
import type { AuthRepo, UserRecord } from './auth.repo.js';
import type { AuthResult, LoginBody, MeResult, SignupBody } from './auth.schema.js';

/** Who is calling, once an owner access token is verified. Passed to every owner endpoint. */
export interface OwnerContext {
  userId: string;
  tenantId: string;
  role: 'owner' | 'manager';
}

export const AuthErrors = {
  emailTaken: () => new AppError('EMAIL_TAKEN', 'An account already exists with this email', 409),
  invalidCredentials: () => new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect', 401),
  tokenExpired: () => new AppError('TOKEN_EXPIRED', 'Session expired, please log in again', 401),
};

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export class AuthService {
  /** Hash checked when the email doesn't exist, so "unknown email" and "wrong password" take the same time. */
  private dummyHash: Promise<string>;

  constructor(
    private readonly repo: AuthRepo,
    private readonly passwords: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly refreshTtlDays: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.dummyHash = passwords.hash('dummy-password-for-timing');
  }

  /** Creates the business, its first branch and the owner account, then logs in. */
  async signup(input: SignupBody): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    if (await this.repo.findUserByEmail(email)) throw AuthErrors.emailTaken();

    const tenantId = newId();
    const user: UserRecord = {
      id: newId(),
      tenantId,
      email,
      passwordHash: await this.passwords.hash(input.password),
      name: input.name.trim(),
      role: 'owner',
    };
    const created = await this.repo.createAccount({
      tenant: { id: tenantId, name: input.businessName.trim(), taxId: input.taxId?.trim() || null },
      branch: { id: newId(), name: (input.branchName ?? input.businessName).trim(), type: input.branchType ?? 'cafe' },
      user,
    });
    if (!created) throw AuthErrors.emailTaken(); // lost a race with another signup

    return this.issueTokens(user);
  }

  async login(input: LoginBody): Promise<AuthResult> {
    const user = await this.repo.findUserByEmail(normalizeEmail(input.email));
    const ok = await this.passwords.verify(user?.passwordHash ?? (await this.dummyHash), input.password);
    if (!user || !ok) throw AuthErrors.invalidCredentials();
    return this.issueTokens(user);
  }

  /**
   * Exchanges a refresh token for new tokens (rotation).
   * A token used twice means it was stolen → every session of that user is closed.
   */
  async refresh(refreshToken: string): Promise<AuthResult> {
    const record = await this.repo.findRefreshToken(hashToken(refreshToken));
    if (!record) throw Errors.unauthorized();

    if (record.revokedAt) {
      await this.repo.revokeAllRefreshTokens(record.userId);
      throw Errors.unauthorized();
    }
    if (record.expiresAt <= this.now()) throw AuthErrors.tokenExpired();
    if (!(await this.repo.revokeRefreshToken(record.id))) {
      // Another request rotated it at the same moment → treat as reuse.
      await this.repo.revokeAllRefreshTokens(record.userId);
      throw Errors.unauthorized();
    }

    const user = await this.repo.findUserById(record.userId);
    if (!user) throw Errors.unauthorized();
    return this.issueTokens(user);
  }

  async logout(refreshToken: string): Promise<void> {
    const record = await this.repo.findRefreshToken(hashToken(refreshToken));
    if (record) await this.repo.revokeRefreshToken(record.id);
  }

  /** Verifies "Authorization: Bearer <accessToken>". */
  authenticate(authorization: string | undefined): OwnerContext {
    const [scheme, token] = (authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw Errors.unauthorized();
    const claims = this.tokens.verifyAccess(token);
    if (!claims) throw AuthErrors.tokenExpired();
    return { userId: claims.sub, tenantId: claims.tenantId, role: claims.role };
  }

  async me(ctx: OwnerContext): Promise<MeResult> {
    const user = await this.repo.findUserById(ctx.userId);
    if (!user || user.tenantId !== ctx.tenantId) throw Errors.unauthorized();
    return this.profile(user);
  }

  private async profile(user: UserRecord): Promise<MeResult> {
    const [tenant, branchList] = await Promise.all([this.repo.getTenant(user.tenantId), this.repo.listBranches(user.tenantId)]);
    if (!tenant) throw Errors.unauthorized();
    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      tenant,
      branches: branchList,
    };
  }

  private async issueTokens(user: UserRecord): Promise<AuthResult> {
    const refreshToken = newToken();
    await this.repo.saveRefreshToken({
      id: newId(),
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(this.now().getTime() + this.refreshTtlDays * 24 * 3600 * 1000),
    });
    return {
      accessToken: this.tokens.signAccess({ sub: user.id, tenantId: user.tenantId, role: user.role }),
      expiresIn: this.tokens.accessTtlSeconds,
      refreshToken,
      ...(await this.profile(user)),
    };
  }
}
