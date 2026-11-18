import { Type, type Static } from '@sinclair/typebox';

export const BranchParams = Type.Object({ branchId: Type.String({ format: 'uuid' }) });
export const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

const SortOrder = Type.Integer({ minimum: 0, maximum: 10_000 });

// ── Areas ("Salle", "Terrasse") ─────────────────────────────────

export const CreateAreaBody = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 40 }), sortOrder: Type.Optional(SortOrder) },
  { additionalProperties: false },
);
export type CreateAreaBody = Static<typeof CreateAreaBody>;

export const UpdateAreaBody = Type.Partial(CreateAreaBody, { additionalProperties: false, minProperties: 1 });
export type UpdateAreaBody = Static<typeof UpdateAreaBody>;

export const AreaView = Type.Object({ id: Type.String(), name: Type.String(), sortOrder: Type.Integer() });
export type AreaView = Static<typeof AreaView>;

// ── Tables ──────────────────────────────────────────────────────

const TableName = Type.String({ minLength: 1, maxLength: 20 });
const Seats = Type.Integer({ minimum: 1, maximum: 50 });

/** One or several tables at once: names ["1", "2", … "12"]. */
export const CreateTablesBody = Type.Object(
  {
    areaId: Type.String({ format: 'uuid' }),
    names: Type.Array(TableName, { minItems: 1, maxItems: 100 }),
    seats: Type.Optional(Seats),
  },
  { additionalProperties: false },
);
export type CreateTablesBody = Static<typeof CreateTablesBody>;

export const UpdateTableBody = Type.Object(
  {
    name: Type.Optional(TableName),
    areaId: Type.Optional(Type.String({ format: 'uuid' })),
    seats: Type.Optional(Seats),
    sortOrder: Type.Optional(SortOrder),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateTableBody = Static<typeof UpdateTableBody>;

export const TableView = Type.Object({
  id: Type.String(),
  areaId: Type.String(),
  name: Type.String(),
  seats: Type.Integer(),
  sortOrder: Type.Integer(),
});
export type TableView = Static<typeof TableView>;

export const FloorView = Type.Object({ areas: Type.Array(AreaView), tables: Type.Array(TableView) });
export type FloorView = Static<typeof FloorView>;

export const OkResult = Type.Object({ ok: Type.Literal(true) });
