import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const EnvSchema = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('test'), Type.Literal('production')],
    { default: 'development' },
  ),
  HOST: Type.String({ default: '0.0.0.0' }),
  PORT: Type.Integer({ default: 3000 }),
  LOG_LEVEL: Type.String({ default: 'info' }),
  DATABASE_URL: Type.String({ minLength: 1 }),
  /** Secret used to sign owner login tokens. Long and random; never commit the real one. */
  JWT_SECRET: Type.String({ minLength: 32 }),
  ACCESS_TOKEN_TTL_MINUTES: Type.Integer({ default: 15, minimum: 1 }),
  REFRESH_TOKEN_TTL_DAYS: Type.Integer({ default: 30, minimum: 1 }),
  /** Where the website is (links in emails). */
  WEB_URL: Type.String({ default: 'http://localhost:3001' }),
  /** Brevo transactional email key. Empty = emails are saved in MAIL_DIR instead of sent. Never commit it. */
  BREVO_API_KEY: Type.Optional(Type.String()),
  /** Sender address, verified in Brevo (Senders & IP). Required with BREVO_API_KEY. */
  MAIL_FROM: Type.Optional(Type.String()),
  MAIL_FROM_NAME: Type.String({ default: 'Kahwti' }),
  MAIL_DIR: Type.String({ default: '.mail-outbox' }),
});

export type Env = Static<typeof EnvSchema>;

/** Reads and validates env variables. The server refuses to start if one is missing. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const picked = Object.fromEntries(
    Object.keys(EnvSchema.properties)
      .map((k) => [k, source[k]])
      .filter(([, v]) => v !== undefined),
  );
  const value = Value.Convert(EnvSchema, Value.Default(EnvSchema, picked));
  if (!Value.Check(EnvSchema, value)) {
    const errors = [...Value.Errors(EnvSchema, value)].map((e) => `  ${e.path}: ${e.message}`);
    throw new Error(`Invalid environment variables:\n${errors.join('\n')}`);
  }
  if (value.BREVO_API_KEY && !value.MAIL_FROM) {
    throw new Error('Invalid environment variables:\n  /MAIL_FROM: required when BREVO_API_KEY is set (a sender verified in Brevo)');
  }
  return value;
}
