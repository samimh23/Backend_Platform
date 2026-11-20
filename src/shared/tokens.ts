import { createSigner, createVerifier } from 'fast-jwt';

/** What an owner access token carries. Kept small: ids and role only. */
export interface AccessClaims {
  /** owner user id */
  sub: string;
  tenantId: string;
  role: 'owner' | 'manager';
}

/** Short-lived signed access tokens (JWT, HS256). Pure — no Fastify. */
export class TokenService {
  private readonly sign: (payload: object) => string;
  private readonly check: (token: string) => AccessClaims & { exp: number };

  constructor(secret: string, readonly accessTtlSeconds: number) {
    this.sign = createSigner({ key: secret, algorithm: 'HS256', expiresIn: accessTtlSeconds * 1000, iss: 'pos-platform' });
    this.check = createVerifier({ key: secret, algorithms: ['HS256'], allowedIss: 'pos-platform' }) as never;
  }

  signAccess(claims: AccessClaims): string {
    return this.sign(claims);
  }

  /** Returns the claims, or null if the token is invalid or expired. */
  verifyAccess(token: string): AccessClaims | null {
    try {
      const c = this.check(token);
      return { sub: c.sub, tenantId: c.tenantId, role: c.role };
    } catch {
      return null;
    }
  }
}

/** What a CUSTOMER access token carries (the loyalty app). */
export interface CustomerClaims {
  /** customer id */
  sub: string;
}

/**
 * Customer tokens use another issuer: an owner endpoint rejects them, and a
 * customer endpoint rejects owner tokens, even though both are signed the same way.
 */
export class CustomerTokenService {
  private readonly sign: (payload: object) => string;
  private readonly check: (token: string) => CustomerClaims & { exp: number };

  constructor(secret: string, readonly accessTtlSeconds: number) {
    this.sign = createSigner({ key: secret, algorithm: 'HS256', expiresIn: accessTtlSeconds * 1000, iss: 'kahwti-customer' });
    this.check = createVerifier({ key: secret, algorithms: ['HS256'], allowedIss: 'kahwti-customer' }) as never;
  }

  signAccess(claims: CustomerClaims): string {
    return this.sign(claims);
  }

  verifyAccess(token: string): CustomerClaims | null {
    try {
      return { sub: this.check(token).sub };
    } catch {
      return null;
    }
  }
}
