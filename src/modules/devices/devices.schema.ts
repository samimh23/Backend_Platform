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

// ── Owner app ───────────────────────────────────────────────────

const DeviceRole = Type.Union([Type.Literal('hub'), Type.Literal('pos'), Type.Literal('kds')]);

export const BranchParams = Type.Object({ branchId: Type.String({ format: 'uuid' }) });
export const DeviceParams = Type.Object({ deviceId: Type.String({ format: 'uuid' }) });

export const CreatePairingCodeBody = Type.Object(
  {
    /** "hub" for the main POS of the café, "pos" for the others. */
    role: DeviceRole,
  },
  { additionalProperties: false },
);

export const PairingCodeView = Type.Object({
  /** Shown to the owner (and as a QR later); typed on the new POS. */
  code: Type.String(),
  role: Type.String(),
  expiresAt: Type.String(),
});
export type PairingCodeView = Static<typeof PairingCodeView>;

export const DeviceView = Type.Object({
  id: Type.String(),
  /** T1, T2… */
  code: Type.String(),
  name: Type.String(),
  role: Type.String(),
  disabled: Type.Boolean(),
  /** Synced in the last 60 seconds. */
  online: Type.Boolean(),
  lastSeenAt: Type.Union([Type.String(), Type.Null()]),
  /** Number of events received from this device. */
  lastSeq: Type.Integer(),
  pairedAt: Type.String(),
  /** The Hub always can; other POS only if the owner allows it. */
  canTakePayments: Type.Boolean(),
  /** Hub only: "192.168.1.20:7700" on the café network, as last reported. */
  lanAddress: Type.Union([Type.String(), Type.Null()]),
});
export type DeviceView = Static<typeof DeviceView>;

export const UpdateDeviceBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
    /** true = the POS is locked on its next sync (lost or stolen device). */
    disabled: Type.Optional(Type.Boolean()),
    /** Secondary POS: allow taking payments (e.g. a terrace POS with its own cash drawer). */
    canTakePayments: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);

// ── Café local network (Hub ↔ other POS) ───────────────────────

const Ipv4 = Type.String({ pattern: '^(\\d{1,3}\\.){3}\\d{1,3}$' });

export const LanReportBody = Type.Object(
  {
    /** Private IPv4 addresses of the Hub (Wi-Fi, Ethernet…). */
    addresses: Type.Array(Ipv4, { maxItems: 8 }),
    port: Type.Integer({ minimum: 1024, maximum: 65535 }),
  },
  { additionalProperties: false },
);
export type LanReportBody = Static<typeof LanReportBody>;

const LanDevice = Type.Object({
  id: Type.String(),
  code: Type.String(),
  name: Type.String(),
  role: Type.String(),
  canTakePayments: Type.Boolean(),
  disabled: Type.Boolean(),
});

export const LanInfo = Type.Object({
  /** Secret shared by the café's devices to sign local requests. Never shown to the owner. */
  lanKey: Type.String(),
  /** Where the other POS find the Hub; null when the café has no Hub. */
  hub: Type.Union([
    Type.Object({
      deviceId: Type.String(),
      code: Type.String(),
      addresses: Type.Array(Type.String()),
      port: Type.Union([Type.Integer(), Type.Null()]),
    }),
    Type.Null(),
  ]),
  /** Devices of the branch: the Hub checks who may connect and who may take payments. */
  devices: Type.Array(LanDevice),
});
export type LanInfo = Static<typeof LanInfo>;
