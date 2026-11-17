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
  return value;
}
