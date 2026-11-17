import { Type, type Static } from '@sinclair/typebox';

const Email = Type.String({ format: 'email', maxLength: 254 });
/** At least 10 characters — length matters more than symbols. */
const Password = Type.String({ minLength: 10, maxLength: 128 });

export const SignupBody = Type.Object(
  {
    email: Email,
    password: Password,
    name: Type.String({ minLength: 1, maxLength: 80 }),
    /** The business: "Café Le Jasmin". */
    businessName: Type.String({ minLength: 1, maxLength: 80 }),
    /** First location. Defaults to the business name. */
    branchName: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    branchType: Type.Optional(Type.Union([Type.Literal('cafe'), Type.Literal('restaurant'), Type.Literal('retail')])),
    /** Matricule fiscal (optional at signup). */
    taxId: Type.Optional(Type.String({ maxLength: 40 })),
  },
  { additionalProperties: false },
);
export type SignupBody = Static<typeof SignupBody>;

export const LoginBody = Type.Object(
  { email: Email, password: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);
export type LoginBody = Static<typeof LoginBody>;

export const RefreshBody = Type.Object({ refreshToken: Type.String({ minLength: 20, maxLength: 200 }) }, { additionalProperties: false });

const User = Type.Object({ id: Type.String(), email: Type.String(), name: Type.String(), role: Type.String() });
const Tenant = Type.Object({ id: Type.String(), name: Type.String(), taxId: Type.Union([Type.String(), Type.Null()]) });
const Branch = Type.Object({ id: Type.String(), name: Type.String(), type: Type.String() });

export const MeResult = Type.Object({ user: User, tenant: Tenant, branches: Type.Array(Branch) });
export type MeResult = Static<typeof MeResult>;

export const AuthResult = Type.Object({
  /** Send as "Authorization: Bearer <accessToken>". Expires after `expiresIn` seconds. */
  accessToken: Type.String(),
  expiresIn: Type.Integer(),
  /** Use once with /v1/auth/refresh to get new tokens. */
  refreshToken: Type.String(),
  user: User,
  tenant: Tenant,
  branches: Type.Array(Branch),
});
export type AuthResult = Static<typeof AuthResult>;

export const OkResult = Type.Object({ ok: Type.Literal(true) });
