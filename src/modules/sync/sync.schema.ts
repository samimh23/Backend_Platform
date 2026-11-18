import { Type, type Static } from '@sinclair/typebox';

/** One append-only change recorded by a device. See Notion → Sync protocol. */
export const SyncEvent = Type.Object(
  {
    /** UUID v7 created by the device — idempotency key. */
    id: Type.String({ format: 'uuid' }),
    /** e.g. "order.item_added" */
    type: Type.String({ pattern: '^[a-z_]+\\.[a-z_]+$', maxLength: 60 }),
    /** Payload schema version, so old POS versions keep syncing after updates. */
    version: Type.Integer({ minimum: 1 }),
    branchId: Type.String({ format: 'uuid' }),
    deviceId: Type.String({ format: 'uuid' }),
    staffId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
    /** The order / payment / session this event is about. */
    entityId: Type.String({ format: 'uuid' }),
    /** Increasing counter per device (1, 2, 3…). Gaps = possible lost events. */
    deviceSeq: Type.Integer({ minimum: 1 }),
    /** Device clock. The server also stores its own receivedAt. */
    occurredAt: Type.String({ format: 'date-time' }),
    approvedBy: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type SyncEvent = Static<typeof SyncEvent>;

export const PushBody = Type.Object({
  events: Type.Array(SyncEvent, { minItems: 1, maxItems: 500 }),
});

export const PushResult = Type.Object({
  /** Ids the device can remove from its outbox (new + already known). */
  accepted: Type.Array(Type.String()),
  /** Refused events: the device keeps them; they show in super-admin. */
  rejected: Type.Array(Type.Object({ id: Type.String(), code: Type.String() })),
  /** How many accepted events were already stored (safe retries). */
  duplicates: Type.Integer(),
});
export type PushResult = Static<typeof PushResult>;

export const PullQuery = Type.Object({
  /** Cursor from the previous pull. Omit for a full download. */
  cursor: Type.Optional(Type.String({ format: 'date-time' })),
});

const Category = Type.Object({
  id: Type.String(),
  name: Type.String(),
  sortOrder: Type.Integer(),
  color: Type.Union([Type.String(), Type.Null()]),
  /** true = removed by the owner → the POS deletes it locally. */
  deleted: Type.Boolean(),
});

const Product = Type.Object({
  id: Type.String(),
  categoryId: Type.String(),
  name: Type.String(),
  /** TTC in millimes. */
  price: Type.Integer(),
  vatRateBp: Type.Integer(),
  station: Type.String(),
  modifierGroups: Type.Unknown(),
  available: Type.Boolean(),
  sortOrder: Type.Integer(),
  /** true = removed by the owner → the POS deletes it locally. */
  deleted: Type.Boolean(),
});

const StaffMember = Type.Object({
  id: Type.String(),
  name: Type.String(),
  role: Type.String(),
  /** PBKDF2 hash so the POS can check the PIN offline. Never the PIN. */
  pinHash: Type.String(),
  /** false = deactivated by the owner → the POS removes this person. */
  active: Type.Boolean(),
});

export const PullResult = Type.Object({
  /** Send this back as ?cursor= next time. */
  cursor: Type.String(),
  categories: Type.Array(Category),
  products: Type.Array(Product),
  staff: Type.Array(StaffMember),
});
export type PullResult = Static<typeof PullResult>;
