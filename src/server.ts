import { buildApp, reposFromDb } from './app.js';
import { loadEnv } from './config/env.js';
import { createDb } from './db/client.js';

const env = loadEnv();
const { db, close } = createDb(env.DATABASE_URL);
const app = await buildApp({
  repos: reposFromDb(db),
  logLevel: env.LOG_LEVEL,
  auth: {
    jwtSecret: env.JWT_SECRET,
    accessTtlMinutes: env.ACCESS_TOKEN_TTL_MINUTES,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
  },
});

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: env.HOST, port: env.PORT });
