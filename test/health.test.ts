import { afterEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import type { HealthRepo } from '../src/modules/health/health.service.js';
import { buildTestApp, fakeRepos } from './fakes.js';

const dbUp: HealthRepo = { ping: async () => {} };
const dbDown: HealthRepo = {
  ping: async () => {
    throw new Error('connection refused');
  },
};

describe('health', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  afterEach(() => app.close());

  it('GET /health → ok', async () => {
    app = await buildTestApp({ ...fakeRepos().repos, health: dbUp });
    const res = await app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/ready → ready when the database answers', async () => {
    app = await buildTestApp({ ...fakeRepos().repos, health: dbUp });
    const res = await app.inject({ url: '/health/ready' });
    expect(res.json()).toEqual({ status: 'ready', database: 'up' });
  });

  it('GET /health/ready → 503 DATABASE_DOWN when the database is down', async () => {
    app = await buildTestApp({ ...fakeRepos().repos, health: dbDown });
    const res = await app.inject({ url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: { code: 'DATABASE_DOWN', message: 'Database is not reachable' } });
  });

  it('unknown route → 404 in the standard error format', async () => {
    app = await buildTestApp({ ...fakeRepos().repos, health: dbUp });
    const res = await app.inject({ url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
