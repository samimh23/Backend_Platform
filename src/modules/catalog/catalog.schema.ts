import { Type, type Static } from '@sinclair/typebox';

export const BranchParams = Type.Object({ branchId: Type.String({ format: 'uuid' }) });
export const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

const Color = Type.String({ pattern: '^#[0-9A-Fa-f]{6}$', description: 'e.g. #8B5E3C' });

/** Tunisian VAT rates in basis points (19 %, 13 %, 7 %, 0 %). */
export const VatRateBp = Type.Union([Type.Literal(1900), Type.Literal(1300), Type.Literal(700), Type.Literal(0)]);
const Station = Type.Union([Type.Literal('bar'), Type.Literal('kitchen'), Type.Literal('none')]);
/** Millimes, 0 to 10 000 DT. */
const Price = Type.Integer({ minimum: 0, maximum: 10_000_000 });

// ── Categories ──────────────────────────────────────────────────

export const CreateCategoryBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 60 }),
    color: Type.Optional(Type.Union([Color, Type.Null()])),
    sortOrder: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
  },
  { additionalProperties: false },
);
export type CreateCategoryBody = Static<typeof CreateCategoryBody>;

export const UpdateCategoryBody = Type.Partial(CreateCategoryBody, { additionalProperties: false, minProperties: 1 });
export type UpdateCategoryBody = Static<typeof UpdateCategoryBody>;

export const CategoryView = Type.Object({
  id: Type.String(),
  name: Type.String(),
  color: Type.Union([Type.String(), Type.Null()]),
  sortOrder: Type.Integer(),
});
export type CategoryView = Static<typeof CategoryView>;

// ── Modifiers (options like size, extras) ───────────────────────

const ModifierInput = Type.Object(
  {
    /** Omit for a new option — the server creates the id. Keep it when editing. */
    id: Type.Optional(Type.String({ format: 'uuid' })),
    name: Type.String({ minLength: 1, maxLength: 40 }),
    extraPrice: Type.Optional(Price),
  },
  { additionalProperties: false },
);

export const ModifierGroupInput = Type.Object(
  {
    id: Type.Optional(Type.String({ format: 'uuid' })),
    /** "Taille", "Extras" */
    name: Type.String({ minLength: 1, maxLength: 40 }),
    /** 1 = the cashier must choose. */
    minSelect: Type.Integer({ minimum: 0, maximum: 20 }),
    maxSelect: Type.Integer({ minimum: 1, maximum: 20 }),
    modifiers: Type.Array(ModifierInput, { minItems: 1, maxItems: 30 }),
  },
  { additionalProperties: false },
);
export type ModifierGroupInput = Static<typeof ModifierGroupInput>;

const ModifierGroupView = Type.Object({
  id: Type.String(),
  name: Type.String(),
  minSelect: Type.Integer(),
  maxSelect: Type.Integer(),
  modifiers: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), extraPrice: Type.Integer() })),
});
export type ModifierGroupView = Static<typeof ModifierGroupView>;

// ── Products ────────────────────────────────────────────────────

export const CreateProductBody = Type.Object(
  {
    categoryId: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 80 }),
    /** Price TTC (VAT included) in millimes: 1.200 DT = 1200. */
    price: Price,
    vatRateBp: Type.Optional(VatRateBp),
    /** Where it is prepared → which printer/screen gets the ticket. */
    station: Type.Optional(Station),
    modifierGroups: Type.Optional(Type.Array(ModifierGroupInput, { maxItems: 10 })),
    available: Type.Optional(Type.Boolean()),
    sortOrder: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
  },
  { additionalProperties: false },
);
export type CreateProductBody = Static<typeof CreateProductBody>;

export const UpdateProductBody = Type.Partial(CreateProductBody, { additionalProperties: false, minProperties: 1 });
export type UpdateProductBody = Static<typeof UpdateProductBody>;

export const ProductView = Type.Object({
  id: Type.String(),
  categoryId: Type.String(),
  name: Type.String(),
  price: Type.Integer(),
  vatRateBp: Type.Integer(),
  station: Type.String(),
  modifierGroups: Type.Array(ModifierGroupView),
  available: Type.Boolean(),
  sortOrder: Type.Integer(),
});
export type ProductView = Static<typeof ProductView>;

export const MenuView = Type.Object({
  categories: Type.Array(CategoryView),
  products: Type.Array(ProductView),
});
export type MenuView = Static<typeof MenuView>;

export const OkResult = Type.Object({ ok: Type.Literal(true) });
