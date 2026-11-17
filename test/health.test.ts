import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

it('GET /health', async () => {
  const res = await buildApp().inject({ url: '/health' });
  expect(res.json()).toEqual({ status: 'ok' });
});
