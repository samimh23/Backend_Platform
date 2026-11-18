import { Type, type Static } from '@sinclair/typebox';

export const BranchParams = Type.Object({ branchId: Type.String({ format: 'uuid' }) });
export const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

const Role = Type.Union([Type.Literal('manager'), Type.Literal('cashier'), Type.Literal('server'), Type.Literal('kitchen')]);
/** 4 to 6 digits. */
const Pin = Type.String({ pattern: '^\\d{4,6}$' });

export const CreateStaffBody = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 40 }), role: Role, pin: Pin },
  { additionalProperties: false },
);
export type CreateStaffBody = Static<typeof CreateStaffBody>;

export const UpdateStaffBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
    role: Type.Optional(Role),
    /** New PIN (the old one stops working on the POS at its next sync). */
    pin: Type.Optional(Pin),
    /** false = can no longer log in on the POS. */
    active: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateStaffBody = Static<typeof UpdateStaffBody>;

/** What the owner app sees — never the PIN hash. */
export const StaffView = Type.Object({
  id: Type.String(),
  name: Type.String(),
  role: Type.String(),
  active: Type.Boolean(),
});
export type StaffView = Static<typeof StaffView>;
