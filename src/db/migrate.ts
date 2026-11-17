import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadEnv } from '../config/env.js';
import { createDb } from './client.js';

const env = loadEnv();
const { db, close } = createDb(env.DATABASE_URL);
await migrate(db, { migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)) });
await close();
console.log('✅ Migrations applied');
