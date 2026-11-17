import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { AuthResult, LoginBody, MeResult, OkResult, RefreshBody, SignupBody } from './auth.schema.js';

/** Brute-force protection on the public auth endpoints (per IP). */
const strict = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export const authRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/v1/auth/signup',
    { config: strict, schema: { body: SignupBody, response: { 200: AuthResult } } },
    (req) => app.services.auth.signup(req.body),
  );

  app.post(
    '/v1/auth/login',
    { config: strict, schema: { body: LoginBody, response: { 200: AuthResult } } },
    (req) => app.services.auth.login(req.body),
  );

  app.post(
    '/v1/auth/refresh',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { body: RefreshBody, response: { 200: AuthResult } } },
    (req) => app.services.auth.refresh(req.body.refreshToken),
  );

  app.post('/v1/auth/logout', { schema: { body: RefreshBody, response: { 200: OkResult } } }, async (req) => {
    await app.services.auth.logout(req.body.refreshToken);
    return { ok: true as const };
  });

  app.get('/v1/auth/me', { schema: { response: { 200: MeResult } }, preHandler: app.requireOwner }, (req) =>
    app.services.auth.me(req.owner),
  );
};
