import Fastify from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Db } from './db/client.js';
import { DrizzleHealthRepo } from './modules/health/health.repo.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { HealthService, type HealthRepo } from './modules/health/health.service.js';
import { registerErrorHandler } from './plugins/errors.js';

/** All services, wired once here. Routes only call them. */
export interface Services {
  health: HealthService;
}

declare module 'fastify' {
  interface FastifyInstance {
    services: Services;
  }
}

/** Repos the app needs. Tests pass in-memory fakes; production builds them from the db. */
export interface Repos {
  health: HealthRepo;
}

export function reposFromDb(db: Db): Repos {
  return {
    health: new DrizzleHealthRepo(db),
  };
}

export interface AppOptions {
  repos: Repos;
  logLevel?: string;
}

/** Builds the app without listening — used by server.ts and by tests (app.inject). */
export async function buildApp({ repos, logLevel = 'info' }: AppOptions) {
  const app = Fastify({ logger: { level: logLevel } }).withTypeProvider<TypeBoxTypeProvider>();

  const services: Services = {
    health: new HealthService(repos.health),
  };
  app.decorate('services', services);

  registerErrorHandler(app);
  await app.register(healthRoutes);

  return app;
}
