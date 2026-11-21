import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { branches, products, recipeLines, stockItems, stockMovements } from '../../db/schema.js';
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import type { OwnerContext } from '../auth/auth.service.js';

/**
 * Stock of ingredients. The owner (or a manager) lists what the café buys, says what
 * each product uses (recipe), and enters deliveries, losses and counts. Every paid
 * ticket synced from the POS takes its ingredients out (see sales.apply closeOrder).
 */

// ── Schema ──────────────────────────────────────────────────────

const Unit = Type.Union([Type.Literal('g'), Type.Literal('ml'), Type.Literal('piece')]);
const Qty = Type.Integer({ minimum: 0, maximum: 100_000_000 });

export const StockItemView = Type.Object({
  id: Type.String(),
  name: Type.String(),
  unit: Unit,
  quantity: Type.Integer(),
  lowThreshold: Type.Union([Type.Integer(), Type.Null()]),
  /** At or under the threshold (or below 0). */
  low: Type.Boolean(),
  archived: Type.Boolean(),
});
export type StockItemView = Static<typeof StockItemView>;

const RecipeLine = Type.Object({ stockItemId: Type.String({ format: 'uuid' }), qty: Type.Integer({ minimum: 1, maximum: 100_000 }) });
export const RecipeView = Type.Object({ productId: Type.String(), lines: Type.Array(RecipeLine) });

export const StockView = Type.Object({ items: Type.Array(StockItemView), recipes: Type.Array(RecipeView) });

export const CreateItemBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 60 }),
    unit: Unit,
    /** What is there now (first count). */
    quantity: Type.Optional(Qty),
    lowThreshold: Type.Optional(Type.Union([Qty, Type.Null()])),
  },
  { additionalProperties: false },
);
export type CreateItemBody = Static<typeof CreateItemBody>;

export const UpdateItemBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
    lowThreshold: Type.Optional(Type.Union([Qty, Type.Null()])),
    archived: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateItemBody = Static<typeof UpdateItemBody>;

export const MoveBody = Type.Object(
  {
    /** delivery: + quantity. waste: − quantity. count: the quantity counted (sets it). */
    kind: Type.Union([Type.Literal('delivery'), Type.Literal('waste'), Type.Literal('count')]),
    quantity: Qty,
    note: Type.Optional(Type.String({ maxLength: 120 })),
  },
  { additionalProperties: false },
);
export type MoveBody = Static<typeof MoveBody>;

export const MovementView = Type.Object({
  kind: Type.String(),
  delta: Type.Integer(),
  quantityAfter: Type.Integer(),
  note: Type.Union([Type.String(), Type.Null()]),
  orderId: Type.Union([Type.String(), Type.Null()]),
  at: Type.String(),
});
export type MovementView = Static<typeof MovementView>;

const BranchParams = Type.Object({ branchId: Type.String({ format: 'uuid' }) });
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

// ── Repo ────────────────────────────────────────────────────────

export interface StockItemRecord {
  id: string;
  branchId: string;
  name: string;
  unit: 'g' | 'ml' | 'piece';
  quantity: number;
  lowThreshold: number | null;
  archived: boolean;
}

export interface StockRepo {
  branchTenant(branchId: string): Promise<string | null>;
  /** Not deleted. */
  productBranch(productId: string): Promise<string | null>;
  item(id: string): Promise<StockItemRecord | null>;
  listItems(branchId: string): Promise<StockItemRecord[]>;
  listRecipes(branchId: string): Promise<{ productId: string; stockItemId: string; qty: number }[]>;
  createItem(item: StockItemRecord): Promise<void>;
  updateItem(id: string, patch: Partial<Pick<StockItemRecord, 'name' | 'lowThreshold' | 'archived'>>): Promise<void>;
  /** Atomically changes the quantity (count = set it) and records the movement. Returns the new quantity. */
  move(
    id: string,
    m: { kind: 'delivery' | 'waste' | 'count'; quantity: number; note: string | null; userId: string },
  ): Promise<number>;
  movements(id: string, limit: number): Promise<{ kind: string; delta: number; quantityAfter: number; note: string | null; orderId: string | null; createdAt: Date }[]>;
  setRecipe(productId: string, lines: { stockItemId: string; qty: number }[]): Promise<void>;
}

export class DrizzleStockRepo implements StockRepo {
  constructor(private readonly db: Db) {}

  async branchTenant(branchId: string) {
    const [b] = await this.db.select({ tenantId: branches.tenantId }).from(branches).where(eq(branches.id, branchId));
    return b?.tenantId ?? null;
  }

  async productBranch(productId: string) {
    const [p] = await this.db
      .select({ branchId: products.branchId })
      .from(products)
      .where(and(eq(products.id, productId), isNull(products.deletedAt)));
    return p?.branchId ?? null;
  }

  private cols = {
    id: stockItems.id,
    branchId: stockItems.branchId,
    name: stockItems.name,
    unit: stockItems.unit,
    quantity: stockItems.quantity,
    lowThreshold: stockItems.lowThreshold,
    archived: stockItems.archived,
  };

  async item(id: string) {
    const [i] = await this.db.select(this.cols).from(stockItems).where(eq(stockItems.id, id));
    return i ?? null;
  }

  listItems(branchId: string) {
    return this.db.select(this.cols).from(stockItems).where(eq(stockItems.branchId, branchId)).orderBy(stockItems.name);
  }

  listRecipes(branchId: string) {
    return this.db
      .select({ productId: recipeLines.productId, stockItemId: recipeLines.stockItemId, qty: recipeLines.qty })
      .from(recipeLines)
      .innerJoin(stockItems, eq(stockItems.id, recipeLines.stockItemId))
      .where(eq(stockItems.branchId, branchId));
  }

  async createItem(item: StockItemRecord) {
    await this.db.insert(stockItems).values(item);
  }

  async updateItem(id: string, patch: Partial<Pick<StockItemRecord, 'name' | 'lowThreshold' | 'archived'>>) {
    await this.db.update(stockItems).set({ ...patch, updatedAt: new Date() }).where(eq(stockItems.id, id));
  }

  async move(id: string, m: { kind: 'delivery' | 'waste' | 'count'; quantity: number; note: string | null; userId: string }) {
    return this.db.transaction(async (tx) => {
      // Lock the row: a sale synced at the same time waits, so the count stays right.
      const [cur] = await tx.select({ quantity: stockItems.quantity, branchId: stockItems.branchId }).from(stockItems).where(eq(stockItems.id, id)).for('update');
      if (!cur) throw StockErrors.itemNotFound();
      const delta = m.kind === 'delivery' ? m.quantity : m.kind === 'waste' ? -m.quantity : m.quantity - cur.quantity;
      const after = cur.quantity + delta;
      await tx.update(stockItems).set({ quantity: after, updatedAt: new Date() }).where(eq(stockItems.id, id));
      await tx.insert(stockMovements).values({
        id: newId(),
        stockItemId: id,
        branchId: cur.branchId,
        kind: m.kind,
        delta,
        quantityAfter: after,
        note: m.note,
        userId: m.userId,
        // created_at = database time, like sales (one clock for the whole history).
      });
      return after;
    });
  }

  movements(id: string, limit: number) {
    return this.db
      .select({
        kind: stockMovements.kind,
        delta: stockMovements.delta,
        quantityAfter: stockMovements.quantityAfter,
        note: stockMovements.note,
        orderId: stockMovements.orderId,
        createdAt: stockMovements.createdAt,
      })
      .from(stockMovements)
      .where(eq(stockMovements.stockItemId, id))
      .orderBy(desc(stockMovements.createdAt))
      .limit(limit);
  }

  async setRecipe(productId: string, lines: { stockItemId: string; qty: number }[]) {
    await this.db.transaction(async (tx) => {
      await tx.delete(recipeLines).where(eq(recipeLines.productId, productId));
      if (lines.length) await tx.insert(recipeLines).values(lines.map((l) => ({ productId, ...l })));
    });
  }
}

/**
 * Called when a paid ticket is projected: takes its ingredients out (recipes × quantities,
 * cancelled items excluded). Once per ticket and ingredient (unique index), in the sync transaction.
 * The movement is dated when the stock changed (sync time), not the ticket time: a ticket synced
 * late (POS offline) then still reads right in the history, after what was entered before it.
 */
export async function consumeForOrder(tx: { execute: Db['execute'] }, o: { orderId: string; branchId: string }): Promise<void> {
  await tx.execute(sql`
    with used as (
      select r.stock_item_id, sum(l.qty * r.qty)::int as n
      from sales_order_lines l
      join recipe_lines r on r.product_id::text = l.product_id
      join stock_items s on s.id = r.stock_item_id and s.branch_id = ${o.branchId}
      where l.order_id = ${o.orderId} and not l.voided
      group by r.stock_item_id
    ), moved as (
      insert into stock_movements (id, stock_item_id, branch_id, kind, delta, quantity_after, order_id, created_at)
      select gen_random_uuid(), u.stock_item_id, ${o.branchId}, 'sale', -u.n, s.quantity - u.n, ${o.orderId}, now()
      from used u join stock_items s on s.id = u.stock_item_id
      on conflict do nothing
      returning stock_item_id, delta
    )
    update stock_items s set quantity = s.quantity + m.delta, updated_at = now()
    from moved m where s.id = m.stock_item_id`);
}

// ── Service ─────────────────────────────────────────────────────

export const StockErrors = {
  branchNotFound: () => new AppError('BRANCH_NOT_FOUND', 'Branch not found', 404),
  itemNotFound: () => new AppError('STOCK_ITEM_NOT_FOUND', 'Stock item not found', 404),
  productNotFound: () => new AppError('PRODUCT_NOT_FOUND', 'Product not found', 404),
  invalidRecipe: (m: string) => new AppError('INVALID_RECIPE', m, 400),
  invalidName: () => new AppError('VALIDATION_ERROR', 'Name is required', 400),
};

const isLow = (i: StockItemRecord) => i.quantity < 0 || (i.lowThreshold !== null && i.quantity <= i.lowThreshold);
const view = (i: StockItemRecord): StockItemView => ({
  id: i.id,
  name: i.name,
  unit: i.unit,
  quantity: i.quantity,
  lowThreshold: i.lowThreshold,
  low: !i.archived && isLow(i),
  archived: i.archived,
});

/** Owner and managers both run the stock (deliveries are often taken by the manager). */
export class StockService {
  constructor(private readonly repo: StockRepo) {}

  async list(owner: OwnerContext, branchId: string): Promise<Static<typeof StockView>> {
    await this.ownBranch(owner, branchId);
    const [items, lines] = await Promise.all([this.repo.listItems(branchId), this.repo.listRecipes(branchId)]);
    const byProduct = new Map<string, { stockItemId: string; qty: number }[]>();
    for (const l of lines) byProduct.set(l.productId, [...(byProduct.get(l.productId) ?? []), { stockItemId: l.stockItemId, qty: l.qty }]);
    return { items: items.map(view), recipes: [...byProduct].map(([productId, ls]) => ({ productId, lines: ls })) };
  }

  async createItem(owner: OwnerContext, branchId: string, body: CreateItemBody): Promise<StockItemView> {
    await this.ownBranch(owner, branchId);
    const item: StockItemRecord = {
      id: newId(),
      branchId,
      name: body.name.trim(),
      unit: body.unit,
      quantity: 0,
      lowThreshold: body.lowThreshold ?? null,
      archived: false,
    };
    if (!item.name) throw StockErrors.invalidName();
    await this.repo.createItem(item);
    if (body.quantity) await this.repo.move(item.id, { kind: 'count', quantity: body.quantity, note: 'Stock de départ', userId: owner.userId });
    return view((await this.repo.item(item.id))!);
  }

  async updateItem(owner: OwnerContext, id: string, body: UpdateItemBody): Promise<StockItemView> {
    await this.ownItem(owner, id);
    if (body.name !== undefined && !body.name.trim()) throw StockErrors.invalidName();
    await this.repo.updateItem(id, {
      ...(body.name !== undefined && { name: body.name.trim() }),
      ...(body.lowThreshold !== undefined && { lowThreshold: body.lowThreshold }),
      ...(body.archived !== undefined && { archived: body.archived }),
    });
    return view((await this.repo.item(id))!);
  }

  async move(owner: OwnerContext, id: string, body: MoveBody): Promise<StockItemView> {
    await this.ownItem(owner, id);
    await this.repo.move(id, { kind: body.kind, quantity: body.quantity, note: body.note?.trim() || null, userId: owner.userId });
    return view((await this.repo.item(id))!);
  }

  async movements(owner: OwnerContext, id: string): Promise<MovementView[]> {
    await this.ownItem(owner, id);
    return (await this.repo.movements(id, 100)).map(({ createdAt, ...m }) => ({ ...m, at: createdAt.toISOString() }));
  }

  async setRecipe(owner: OwnerContext, productId: string, lines: { stockItemId: string; qty: number }[]) {
    const branchId = await this.repo.productBranch(productId);
    if (!branchId || (await this.repo.branchTenant(branchId)) !== owner.tenantId) throw StockErrors.productNotFound();
    if (new Set(lines.map((l) => l.stockItemId)).size !== lines.length) throw StockErrors.invalidRecipe('Un ingrédient est en double');
    for (const l of lines) {
      const item = await this.repo.item(l.stockItemId);
      if (!item || item.branchId !== branchId) throw StockErrors.invalidRecipe('Ingrédient inconnu');
    }
    await this.repo.setRecipe(productId, lines);
    return { productId, lines };
  }

  private async ownBranch(owner: OwnerContext, branchId: string) {
    if ((await this.repo.branchTenant(branchId)) !== owner.tenantId) throw StockErrors.branchNotFound();
  }

  private async ownItem(owner: OwnerContext, id: string) {
    const item = await this.repo.item(id);
    if (!item || (await this.repo.branchTenant(item.branchId)) !== owner.tenantId) throw StockErrors.itemNotFound();
    return item;
  }
}

// ── Routes ──────────────────────────────────────────────────────

export const stockRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook('preHandler', app.requireOwner);
  const stock = app.services.stock;

  app.get('/v1/owner/branches/:branchId/stock', { schema: { params: BranchParams, response: { 200: StockView } } }, (req) =>
    stock.list(req.owner, req.params.branchId),
  );
  app.post(
    '/v1/owner/branches/:branchId/stock/items',
    { schema: { params: BranchParams, body: CreateItemBody, response: { 200: StockItemView } } },
    (req) => stock.createItem(req.owner, req.params.branchId, req.body),
  );
  app.patch('/v1/owner/stock/items/:id', { schema: { params: IdParams, body: UpdateItemBody, response: { 200: StockItemView } } }, (req) =>
    stock.updateItem(req.owner, req.params.id, req.body),
  );
  app.post(
    '/v1/owner/stock/items/:id/movements',
    { schema: { params: IdParams, body: MoveBody, response: { 200: StockItemView } } },
    (req) => stock.move(req.owner, req.params.id, req.body),
  );
  app.get('/v1/owner/stock/items/:id/movements', { schema: { params: IdParams, response: { 200: Type.Array(MovementView) } } }, (req) =>
    stock.movements(req.owner, req.params.id),
  );
  app.put(
    '/v1/owner/products/:id/recipe',
    {
      schema: {
        params: IdParams,
        body: Type.Object({ lines: Type.Array(RecipeLine, { maxItems: 20 }) }, { additionalProperties: false }),
        response: { 200: RecipeView },
      },
    },
    (req) => stock.setRecipe(req.owner, req.params.id, req.body.lines),
  );
};

