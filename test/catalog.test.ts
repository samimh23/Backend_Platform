import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { TokenService } from '../src/shared/tokens.js';
import { buildTestApp, fakeRepos, publicKey, testAuthConfig, type FakeAuthRepo, type FakeDevicesRepo } from './fakes.js';

type App = Awaited<ReturnType<typeof buildApp>>;

describe('owner: menu', () => {
  let app: App;
  let auth: FakeAuthRepo;
  let devices: FakeDevicesRepo;
  let token: string;
  let branchId: string;

  beforeEach(async () => {
    const f = fakeRepos();
    auth = f.auth;
    devices = f.devices;
    app = await buildTestApp(f.repos);
    const s = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'owner@example.com', password: 'correct horse battery', name: 'Owner', businessName: 'Café' },
      })
    ).json();
    token = s.accessToken;
    branchId = s.branches[0].id;
  });
  afterEach(() => app.close());

  const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, t = token) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, ...(payload && { payload }) });

  const createCategory = (name: string, extra: object = {}) =>
    req('POST', `/v1/owner/branches/${branchId}/categories`, { name, ...extra });

  const createProduct = (body: object) => req('POST', `/v1/owner/branches/${branchId}/products`, body);

  it('builds a menu: categories in order, products with defaults', async () => {
    const hot = (await createCategory('Boissons chaudes', { color: '#8B5E3C' })).json();
    const cold = (await createCategory('Boissons fraîches')).json();
    expect(hot).toMatchObject({ name: 'Boissons chaudes', color: '#8B5E3C', sortOrder: 0 });
    expect(cold.sortOrder).toBe(1); // appended at the end

    const express = (await createProduct({ categoryId: hot.id, name: ' Express ', price: 1200, station: 'bar' })).json();
    expect(express).toMatchObject({
      name: 'Express',
      price: 1200,
      vatRateBp: 1900, // default 19 %
      station: 'bar',
      available: true,
      modifierGroups: [],
    });

    const menu = (await req('GET', `/v1/owner/branches/${branchId}/menu`)).json();
    expect(menu.categories.map((c: { name: string }) => c.name)).toEqual(['Boissons chaudes', 'Boissons fraîches']);
    expect(menu.products.map((p: { name: string }) => p.name)).toEqual(['Express']);
  });

  it('modifier groups: server creates ids, keeps them on edit, checks min/max', async () => {
    const cat = (await createCategory('Café')).json();
    const p = (
      await createProduct({
        categoryId: cat.id,
        name: 'Cappuccino',
        price: 3500,
        modifierGroups: [
          {
            name: 'Taille',
            minSelect: 1,
            maxSelect: 1,
            modifiers: [{ name: 'Normal' }, { name: 'Grand', extraPrice: 500 }],
          },
        ],
      })
    ).json();
    const group = p.modifierGroups[0];
    expect(group.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(group.modifiers.map((m: { name: string; extraPrice: number }) => [m.name, m.extraPrice])).toEqual([
      ['Normal', 0],
      ['Grand', 500],
    ]);

    // Edit: rename an option, keep ids
    const edited = (
      await req('PATCH', `/v1/owner/products/${p.id}`, {
        modifierGroups: [{ ...group, modifiers: [group.modifiers[0], { ...group.modifiers[1], name: 'XL' }] }],
      })
    ).json();
    expect(edited.modifierGroups[0].id).toBe(group.id);
    expect(edited.modifierGroups[0].modifiers[1]).toEqual({ ...group.modifiers[1], name: 'XL' });

    const bad = await req('PATCH', `/v1/owner/products/${p.id}`, {
      modifierGroups: [{ name: 'Taille', minSelect: 2, maxSelect: 1, modifiers: [{ name: 'A' }, { name: 'B' }] }],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_MODIFIERS');
  });

  it('price and VAT are validated (millimes, Tunisian rates only)', async () => {
    const cat = (await createCategory('Café')).json();
    expect((await createProduct({ categoryId: cat.id, name: 'X', price: -1 })).json().error.code).toBe('VALIDATION_ERROR');
    expect((await createProduct({ categoryId: cat.id, name: 'X', price: 1.5 })).json().error.code).toBe('VALIDATION_ERROR');
    expect((await createProduct({ categoryId: cat.id, name: 'X', price: 1000, vatRateBp: 1800 })).json().error.code).toBe(
      'VALIDATION_ERROR',
    );
    expect((await createProduct({ categoryId: cat.id, name: 'Croissant', price: 1500, vatRateBp: 700 })).statusCode).toBe(200);
  });

  it('update a price, mark out of stock, move to another category', async () => {
    const a = (await createCategory('A')).json();
    const b = (await createCategory('B')).json();
    const p = (await createProduct({ categoryId: a.id, name: 'Thé', price: 1800 })).json();

    const res = (await req('PATCH', `/v1/owner/products/${p.id}`, { price: 2000, available: false, categoryId: b.id })).json();
    expect(res).toMatchObject({ price: 2000, available: false, categoryId: b.id, name: 'Thé' });
  });

  it("a category can't be deleted while it has products", async () => {
    const cat = (await createCategory('Café')).json();
    const p = (await createProduct({ categoryId: cat.id, name: 'Express', price: 1200 })).json();

    const refused = await req('DELETE', `/v1/owner/categories/${cat.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('CATEGORY_NOT_EMPTY');

    expect((await req('DELETE', `/v1/owner/products/${p.id}`)).json()).toEqual({ ok: true });
    expect((await req('DELETE', `/v1/owner/categories/${cat.id}`)).json()).toEqual({ ok: true });

    const menu = (await req('GET', `/v1/owner/branches/${branchId}/menu`)).json();
    expect(menu).toEqual({ categories: [], products: [] });
    // Deleted things look like they don't exist anymore
    expect((await req('PATCH', `/v1/owner/products/${p.id}`, { price: 1 })).json().error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it("another owner can't read or change my menu", async () => {
    const cat = (await createCategory('Café')).json();
    const p = (await createProduct({ categoryId: cat.id, name: 'Express', price: 1200 })).json();
    const other = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: { email: 'other@example.com', password: 'correct horse battery', name: 'Other', businessName: 'Other café' },
      })
    ).json();

    expect((await req('GET', `/v1/owner/branches/${branchId}/menu`, undefined, other.accessToken)).statusCode).toBe(404);
    expect((await req('PATCH', `/v1/owner/products/${p.id}`, { price: 1 }, other.accessToken)).json().error.code).toBe(
      'PRODUCT_NOT_FOUND',
    );
    expect((await req('DELETE', `/v1/owner/categories/${cat.id}`, undefined, other.accessToken)).statusCode).toBe(404);
    // And can't put a product in my category from their own branch
    const res = await req(
      'POST',
      `/v1/owner/branches/${other.branches[0].id}/products`,
      { categoryId: cat.id, name: 'Hack', price: 1 },
      other.accessToken,
    );
    expect(res.json().error.code).toBe('CATEGORY_NOT_FOUND');
  });

  it('a manager can edit the menu', async () => {
    const owner = auth.users[0]!;
    auth.users.push({ ...owner, id: 'manager-1', email: 'm@example.com', role: 'manager' });
    const managerToken = new TokenService(testAuthConfig.jwtSecret, 900).signAccess({
      sub: 'manager-1',
      tenantId: owner.tenantId,
      role: 'manager',
    });
    const res = await req('POST', `/v1/owner/branches/${branchId}/categories`, { name: 'Desserts' }, managerToken);
    expect(res.statusCode).toBe(200);
  });

  it('POS sees owner changes on its next pull — including deletions', async () => {
    // Pair a POS on this branch
    const { code } = (await req('POST', `/v1/owner/branches/${branchId}/pairing-codes`, { role: 'hub' })).json();
    const pos = (await app.inject({ method: 'POST', url: '/v1/devices/pair', payload: { code, name: 'Caisse', publicKey } })).json();
    const pull = async (cursor?: string) =>
      (
        await app.inject({
          url: `/v1/sync/pull${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
          headers: { authorization: `Device ${pos.token}` },
        })
      ).json();

    const cat = (await createCategory('Café')).json();
    const express = (await createProduct({ categoryId: cat.id, name: 'Express', price: 1200 })).json();
    const tea = (await createProduct({ categoryId: cat.id, name: 'Thé', price: 1800 })).json();

    const first = await pull();
    expect(first.products.map((p: { name: string }) => p.name).sort()).toEqual(['Express', 'Thé']);
    expect(first.products.every((p: { deleted: boolean }) => !p.deleted)).toBe(true);

    await new Promise((r) => setTimeout(r, 5)); // make sure "now" moves past the cursor
    await req('PATCH', `/v1/owner/products/${express.id}`, { price: 1300 });
    await req('DELETE', `/v1/owner/products/${tea.id}`);

    const next = await pull(first.cursor);
    expect(next.categories).toEqual([]); // unchanged
    expect(next.products.map((p: { name: string; price: number; deleted: boolean }) => [p.name, p.price, p.deleted]).sort()).toEqual([
      ['Express', 1300, false],
      ['Thé', 1800, true],
    ]);
    expect(devices.devices).toHaveLength(1);
  });
});
