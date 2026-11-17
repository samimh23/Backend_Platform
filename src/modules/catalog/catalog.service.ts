import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import type { OwnerContext } from '../auth/auth.service.js';
import type { CatalogRepo, CategoryRecord, ProductRecord } from './catalog.repo.js';
import type {
  CategoryView,
  CreateCategoryBody,
  CreateProductBody,
  MenuView,
  ModifierGroupInput,
  ModifierGroupView,
  ProductView,
  UpdateCategoryBody,
  UpdateProductBody,
} from './catalog.schema.js';

export const CatalogErrors = {
  branchNotFound: () => new AppError('BRANCH_NOT_FOUND', 'Branch not found', 404),
  categoryNotFound: () => new AppError('CATEGORY_NOT_FOUND', 'Category not found', 404),
  productNotFound: () => new AppError('PRODUCT_NOT_FOUND', 'Product not found', 404),
  categoryNotEmpty: (n: number) =>
    new AppError('CATEGORY_NOT_EMPTY', `This category still has ${n} product(s). Move or delete them first.`, 409),
  invalidModifiers: (message: string) => new AppError('INVALID_MODIFIERS', message, 400),
};

/**
 * Menu management for the owner app (owner and manager roles).
 * Every change sets updated_at = now so POS devices pick it up on their next pull.
 */
export class CatalogService {
  constructor(
    private readonly repo: CatalogRepo,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getMenu(owner: OwnerContext, branchId: string): Promise<MenuView> {
    await this.assertBranch(owner, branchId);
    const [cats, prods] = await Promise.all([this.repo.listCategories(branchId), this.repo.listProducts(branchId)]);
    return { categories: cats.map(categoryView), products: prods.map(productView) };
  }

  // ── Categories ──────────────────────────────────────────

  async createCategory(owner: OwnerContext, branchId: string, body: CreateCategoryBody): Promise<CategoryView> {
    await this.assertBranch(owner, branchId);
    const record: CategoryRecord = {
      id: newId(),
      branchId,
      name: body.name.trim(),
      color: body.color ?? null,
      sortOrder: body.sortOrder ?? (await this.repo.listCategories(branchId)).length,
    };
    await this.repo.insertCategory(record, this.now());
    return categoryView(record);
  }

  async updateCategory(owner: OwnerContext, id: string, body: UpdateCategoryBody): Promise<CategoryView> {
    await this.ownedCategory(owner, id);
    const updated = await this.repo.updateCategory(id, { ...body, ...(body.name && { name: body.name.trim() }) }, this.now());
    if (!updated) throw CatalogErrors.categoryNotFound();
    return categoryView(updated);
  }

  /** Refused while products remain, so nothing disappears from the POS by accident. */
  async deleteCategory(owner: OwnerContext, id: string): Promise<void> {
    await this.ownedCategory(owner, id);
    const n = await this.repo.countProducts(id);
    if (n > 0) throw CatalogErrors.categoryNotEmpty(n);
    await this.repo.softDeleteCategory(id, this.now());
  }

  // ── Products ────────────────────────────────────────────

  async createProduct(owner: OwnerContext, branchId: string, body: CreateProductBody): Promise<ProductView> {
    await this.assertBranch(owner, branchId);
    await this.categoryInBranch(owner, body.categoryId, branchId);
    const record: ProductRecord = {
      id: newId(),
      branchId,
      categoryId: body.categoryId,
      name: body.name.trim(),
      price: body.price,
      vatRateBp: body.vatRateBp ?? 1900,
      station: body.station ?? 'none',
      modifierGroups: normalizeModifierGroups(body.modifierGroups ?? []),
      available: body.available ?? true,
      sortOrder: body.sortOrder ?? 0,
    };
    await this.repo.insertProduct(record, this.now());
    return productView(record);
  }

  async updateProduct(owner: OwnerContext, id: string, body: UpdateProductBody): Promise<ProductView> {
    const product = await this.ownedProduct(owner, id);
    if (body.categoryId) await this.categoryInBranch(owner, body.categoryId, product.branchId);

    const { modifierGroups, name, ...rest } = body;
    const updated = await this.repo.updateProduct(
      id,
      {
        ...rest,
        ...(name !== undefined && { name: name.trim() }),
        ...(modifierGroups !== undefined && { modifierGroups: normalizeModifierGroups(modifierGroups) }),
      },
      this.now(),
    );
    if (!updated) throw CatalogErrors.productNotFound();
    return productView(updated);
  }

  async deleteProduct(owner: OwnerContext, id: string): Promise<void> {
    await this.ownedProduct(owner, id);
    await this.repo.softDeleteProduct(id, this.now());
  }

  // ── Access checks (another business's data looks "not found") ──

  private async assertBranch(owner: OwnerContext, branchId: string) {
    if ((await this.repo.branchTenant(branchId)) !== owner.tenantId) throw CatalogErrors.branchNotFound();
  }

  private async ownedCategory(owner: OwnerContext, id: string) {
    const c = await this.repo.findCategory(id);
    if (!c || (await this.repo.branchTenant(c.branchId)) !== owner.tenantId) throw CatalogErrors.categoryNotFound();
    return c;
  }

  private async categoryInBranch(owner: OwnerContext, categoryId: string, branchId: string) {
    const c = await this.ownedCategory(owner, categoryId);
    if (c.branchId !== branchId) throw CatalogErrors.categoryNotFound();
  }

  private async ownedProduct(owner: OwnerContext, id: string) {
    const p = await this.repo.findProduct(id);
    if (!p || (await this.repo.branchTenant(p.branchId)) !== owner.tenantId) throw CatalogErrors.productNotFound();
    return p;
  }
}

/** Gives ids to new groups/options (keeps existing ids) and checks min/max make sense. */
export function normalizeModifierGroups(groups: ModifierGroupInput[]): ModifierGroupView[] {
  return groups.map((g) => {
    if (g.minSelect > g.maxSelect) {
      throw CatalogErrors.invalidModifiers(`${g.name}: minimum (${g.minSelect}) is greater than maximum (${g.maxSelect})`);
    }
    if (g.minSelect > g.modifiers.length) {
      throw CatalogErrors.invalidModifiers(`${g.name}: minimum (${g.minSelect}) is greater than the number of options`);
    }
    return {
      id: g.id ?? newId(),
      name: g.name.trim(),
      minSelect: g.minSelect,
      maxSelect: Math.min(g.maxSelect, g.modifiers.length),
      modifiers: g.modifiers.map((m) => ({ id: m.id ?? newId(), name: m.name.trim(), extraPrice: m.extraPrice ?? 0 })),
    };
  });
}

const categoryView = ({ id, name, color, sortOrder }: CategoryRecord): CategoryView => ({ id, name, color, sortOrder });
const productView = ({ branchId: _b, ...p }: ProductRecord): ProductView => p;
