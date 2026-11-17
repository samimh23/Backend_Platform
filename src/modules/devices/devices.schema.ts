import { Type, type Static } from '@sinclair/typebox';

export const PairBody = Type.Object(
  {
    /** Code shown in the owner app, e.g. "K7Q2-M9XD" (case and spaces ignored). */
    code: Type.String({ minLength: 4, maxLength: 20 }),
    /** Friendly name: "Caisse principale", "Tablette terrasse". */
    name: Type.String({ minLength: 1, maxLength: 60 }),
    /** Ed25519 public key (base64url, 32 bytes → 43 chars). */
    publicKey: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }),
  },
  { additionalProperties: false },
);
export type PairBody = Static<typeof PairBody>;

export const PairResult = Type.Object({
  deviceId: Type.String(),
  /** T1, T2… — prefix of this device's receipt numbers. */
  deviceCode: Type.String(),
  role: Type.String(),
  tenantId: Type.String(),
  branchId: Type.String(),
  /** Secret returned once. The device keeps it in secure storage and sends it as "Authorization: Device <token>". */
  token: Type.String(),
});
export type PairResult = Static<typeof PairResult>;

export const MeResult = Type.Object({
  deviceId: Type.String(),
  tenantId: Type.String(),
  branchId: Type.String(),
});
