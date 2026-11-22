import { buildApp, reposFromDb } from './app.js';
import { loadEnv } from './config/env.js';
import { createDb } from './db/client.js';
import { BrevoMailer, FileMailer } from './modules/mail/mailer.js';

const env = loadEnv();
const { db, close } = createDb(env.DATABASE_URL);
const mailer = env.BREVO_API_KEY
  ? new BrevoMailer(env.BREVO_API_KEY, { email: env.MAIL_FROM!, name: env.MAIL_FROM_NAME })
  : new FileMailer(env.MAIL_DIR);
const app = await buildApp({
  repos: reposFromDb(db),
  logLevel: env.LOG_LEVEL,
  mailer,
  webUrl: env.WEB_URL.replace(/\/$/, ''),
  auth: {
    jwtSecret: env.JWT_SECRET,
    accessTtlMinutes: env.ACCESS_TOKEN_TTL_MINUTES,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
  },
});

if (!env.BREVO_API_KEY) app.log.warn(`BREVO_API_KEY not set: emails are saved in ${env.MAIL_DIR}/ instead of being sent`);

// Owners' morning summary: checked every 10 minutes, sent once a day from 07:00 (Tunis).
const runDaily = () => {
  app.services.dailySummary.run().catch((err) => app.log.error({ err }, 'daily summary run failed'));
  // Same rhythm: "your gift expires tomorrow" (once per gift).
  app.services.club.remindExpiringGifts().catch((err) => app.log.error({ err }, 'gift reminders failed'));
};
const daily = setInterval(runDaily, 10 * 60_000);
setTimeout(runDaily, 30_000).unref();

const shutdown = async () => {
  clearInterval(daily);
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: env.HOST, port: env.PORT });
