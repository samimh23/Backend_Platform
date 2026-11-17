import { and, asc, count, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { branches, categories, products } from '../../db/schema.js';
import type { CategoryView, ModifierGroupView, ProductView } from './catalog.schema.js';

export interface CategoryRecord extends CategoryView {
  branchId: string;
}

export interface ProductRecord extends ProductView {
  branchId: string;
}

/** Validated by the API schema before reaching the repo. */
type Station = 'bar' | 'kitchen' | 'none';

export interface CatalogRepo {
  branchTenant(branchId: string): Promise<string | null>;
  listCategories(branchId: string): Promise<CategoryRecord[]>;
  listProducts(branchId: string): Promise<ProductRecord[]>;
  /** Not deleted. */
  findCategory(id: string): Promise<CategoryRecord | null>;
  /** Not deleted. */
  findProduct(id: string): Promise<ProductRecord | null>;
  insertCategory(c: CategoryRecord, now: Date): Promise<void>;
  updateCategory(id: string, changes: Partial<CategoryView>, now: Date): Promise<CategoryRecord | null>;
  softDeleteCategory(id: string, now: Date): Promise<void>;
  countProducts(categoryId: string): Promise<number>;
  insertProduct(p: ProductRecord, now: Date): Promise<void>;
  updateProduct(id: string, changes: Partial<Omit<ProductView, 'id'>>, now: Date): Promise<ProductRecord | null>;
  softDeleteProduct(id: string, now: Date): Promise<void>;
}

const categoryColumns = {
  id: categories.id,
  branchId: categories.branchId,
  name: categories.name,
  color: categories.color,
  sortOrder: categories.sortOrder,
};

const productColumns = {
  id: products.id,
  branchId: products.branchId,
  categoryId: products.categoryId,
  name: products.name,
  price: products.price,
  vatRateBp: products.vatRateBp,
  station: products.station,
  modifierGroups: products.modifierGroups,
  available: products.available,
  sortOrder: products.sortOrder,
};

const asProduct = (row: Omit<ProductRecord, 'modifierGroups'> & { modifierGroups: unknown }): ProductRecord => ({
  ...row,
  modifierGroups: (row.modifierGroups ?? []) as ModifierGroupView[],
});

export class DrizzleCatalogRepo implements CatalogRepo {
  constructor(private readonly db: Db) {}

  async branchTenant(branchId: string) {
    const [b] = await this.db.select({ tenantId: branches.tenantId }).from(branches).where(eq(branches.id, branchId));
    return b?.tenantId ?? null;
  }

  listCategories(branchId: string) {
    return this.db
      .select(categoryColumns)
      .from(categories)
      .where(and(eq(categories.branchId, branchId), isNull(categories.deletedAt)))
      .orderBy(asc(categories.sortOrder), asc(categories.name));
  }

  async listProducts(branchId: string) {
    const rows = await this.db
      .select(productColumns)
      .from(products)
      .where(and(eq(products.branchId, branchId), isNull(products.deletedAt)))
      .orderBy(asc(products.sortOrder), asc(products.name));
    return rows.map(asProduct);
  }

  async findCategory(id: string) {
    const [c] = await this.db
      .select(categoryColumns)
      .from(categories)
      .where(and(eq(categories.id, id), isNull(categories.deletedAt)));
    return c ?? null;
  }

  async findProduct(id: string) {
    const [p] = await this.db
      .select(productColumns)
      .from(products)
      .where(and(eq(products.id, id), isNull(products.deletedAt)));
    return p ? asProduct(p) : null;
  }

  async insertCategory(c: CategoryRecord, now: Date) {
    await this.db.insert(categories).values({ ...c, updatedAt: now });
  }

  async updateCategory(id: string, changes: Partial<CategoryView>, now: Date) {
    const [c] = await this.db
      .update(categories)
      .set({ ...changes, updatedAt: now })
      .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
      .returning(categoryColumns);
    return c ?? null;
  }

  async softDeleteCategory(id: string, now: Date) {
    await this.db.update(categories).set({ deletedAt: now, updatedAt: now }).where(eq(categories.id, id));
  }

  async countProducts(categoryId: string) {
    const [r] = await this.db
      .select({ n: count() })
      .from(products)
      .where(and(eq(products.categoryId, categoryId), isNull(products.deletedAt)));
    return r?.n ?? 0;
  }

  async insertProduct(p: ProductRecord, now: Date) {
    await this.db.insert(products).values({ ...p, station: p.station as Station, updatedAt: now });
  }

  async updateProduct(id: string, changes: Partial<Omit<ProductView, 'id'>>, now: Date) {
    const [p] = await this.db
      .update(products)
      .set({ ...changes, station: changes.station as Station | undefined, updatedAt: now })
      .where(and(eq(products.id, id), isNull(products.deletedAt)))
      .returning(productColumns);
    return p ? asProduct(p) : null;
  }

  async softDeleteProduct(id: string, now: Date) {
    await this.db.update(products).set({ deletedAt: now, updatedAt: now }).where(eq(products.id, id));
  }
}
