/**
 * Dev seed: one café with a small menu and two pairing codes (Hub + POS).
 * Run: pnpm db:seed   (safe to run several times — creates a new café each time)
 */
import { loadEnv } from '../config/env.js';
import { newPairingCode } from '../shared/crypto.js';
import { newId } from '../shared/ids.js';
import { createDb } from './client.js';
import { branches, categories, pairingCodes, products, tenants } from './schema.js';

const env = loadEnv();
const { db, close } = createDb(env.DATABASE_URL);

const tenantId = newId();
const branchId = newId();
await db.insert(tenants).values({ id: tenantId, name: 'Café Le Jasmin', taxId: '1234567/A/M/000' });
await db.insert(branches).values({ id: branchId, tenantId, name: 'Le Jasmin — Centre', type: 'cafe' });

const hot = newId();
const cold = newId();
const food = newId();
await db.insert(categories).values([
  { id: hot, branchId, name: 'Boissons chaudes', sortOrder: 1, color: '#8B5E3C' },
  { id: cold, branchId, name: 'Boissons fraîches', sortOrder: 2, color: '#2E86AB' },
  { id: food, branchId, name: 'Viennoiseries', sortOrder: 3, color: '#E0A458' },
]);

const extras = {
  id: newId(),
  name: 'Extras',
  minSelect: 0,
  maxSelect: 3,
  modifiers: [
    { id: newId(), name: 'Extra shot', extraPrice: 500 },
    { id: newId(), name: 'Sans sucre', extraPrice: 0 },
  ],
};
const size = {
  id: newId(),
  name: 'Taille',
  minSelect: 1,
  maxSelect: 1,
  modifiers: [
    { id: newId(), name: 'Normal', extraPrice: 0 },
    { id: newId(), name: 'Grand', extraPrice: 500 },
  ],
};

// Prices are TTC in millimes (1200 = 1.200 DT). Viennoiseries at 7 % VAT for the example.
await db.insert(products).values([
  { id: newId(), branchId, categoryId: hot, name: 'Express', price: 1200, station: 'bar', modifierGroups: [extras] },
  { id: newId(), branchId, categoryId: hot, name: 'Capucin', price: 1500, station: 'bar', modifierGroups: [extras] },
  { id: newId(), branchId, categoryId: hot, name: 'Cappuccino', price: 3500, station: 'bar', modifierGroups: [size, extras] },
  { id: newId(), branchId, categoryId: hot, name: 'Thé à la menthe', price: 1800, station: 'bar' },
  { id: newId(), branchId, categoryId: cold, name: 'Citronnade', price: 3000, station: 'bar' },
  { id: newId(), branchId, categoryId: cold, name: 'Eau minérale 0.5L', price: 1000 },
  { id: newId(), branchId, categoryId: food, name: 'Croissant', price: 1500, vatRateBp: 700 },
  { id: newId(), branchId, categoryId: food, name: 'Pain au chocolat', price: 1800, vatRateBp: 700 },
]);

const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
const hubCode = newPairingCode();
const posCode = newPairingCode();
await db.insert(pairingCodes).values([
  { code: hubCode, branchId, role: 'hub', expiresAt },
  { code: posCode, branchId, role: 'pos', expiresAt },
]);

await close();
console.log(`✅ Seeded "Café Le Jasmin"
   branchId          ${branchId}
   Hub pairing code  ${hubCode}
   POS pairing code  ${posCode}
   (codes valid 7 days, single use)`);
