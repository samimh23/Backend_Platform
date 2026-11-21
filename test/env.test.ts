import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const base = { DATABASE_URL: 'postgres://x', JWT_SECRET: 'x'.repeat(32) };

describe('loadEnv', () => {
  it('applies defaults and converts types', () => {
    const env = loadEnv({ ...base, PORT: '4000' });
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.ACCESS_TOKEN_TTL_MINUTES).toBe(15);
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(30);
  });

  it('refuses to start without DATABASE_URL', () => {
    expect(() => loadEnv({ JWT_SECRET: base.JWT_SECRET })).toThrow(/DATABASE_URL/);
  });

  it('refuses a missing or too short JWT_SECRET', () => {
    expect(() => loadEnv({ DATABASE_URL: base.DATABASE_URL })).toThrow(/JWT_SECRET/);
    expect(() => loadEnv({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('emails: a Brevo key needs a sender; no key is fine (emails are saved locally)', () => {
    expect(loadEnv(base).BREVO_API_KEY).toBeUndefined();
    expect(loadEnv(base).WEB_URL).toBe('http://localhost:3001');
    expect(() => loadEnv({ ...base, BREVO_API_KEY: 'xkeysib-test' })).toThrow(/MAIL_FROM/);
    expect(loadEnv({ ...base, BREVO_API_KEY: 'xkeysib-test', MAIL_FROM: 'noreply@example.com' }).MAIL_FROM_NAME).toBe('Kahwti');
  });
});
