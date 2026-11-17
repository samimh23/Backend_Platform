import Fastify, { type FastifyRequest } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Db } from './db/client.js';
import { DrizzleDevicesRepo, type DevicesRepo } from './modules/devices/devices.repo.js';
import { devicesRoutes } from './modules/devices/devices.routes.js';
import { DevicesService, type DeviceContext } from './modules/devices/devices.service.js';
import { DrizzleHealthRepo } from './modules/health/health.repo.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { HealthService, type HealthRepo } from './modules/health/health.service.js';
import { DrizzleSyncRepo, type SyncRepo } from './modules/sync/sync.repo.js';
import { syncRoutes } from './modules/sync/sync.routes.js';
import { SyncService } from './modules/sync/sync.service.js';
import { registerErrorHandler } from './plugins/errors.js';

/** All services, wired once here. Routes only call them. */
export interface Services {
  health: HealthService;
  devices: DevicesService;
  sync: SyncService;
}

declare module 'fastify' {
  interface FastifyInstance {
    services: Services;
    /** preHandler for device endpoints: checks "Authorization: Device <token>" and sets req.device. */
    requireDevice: (req: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    device: DeviceContext;
  }
}

/** Repos the app needs. Tests pass in-memory fakes; production builds them from the db. */
export interface Repos {
  health: HealthRepo;
  devices: DevicesRepo;
  sync: SyncRepo;
}

export function reposFromDb(db: Db): Repos {
  return {
    health: new DrizzleHealthRepo(db),
    devices: new DrizzleDevicesRepo(db),
    sync: new DrizzleSyncRepo(db),
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
    devices: new DevicesService(repos.devices),
    sync: new SyncService(repos.sync),
  };
  app.decorate('services', services);

  app.decorateRequest('device', null as unknown as DeviceContext);
  app.decorate('requireDevice', async (req: FastifyRequest) => {
    req.device = await services.devices.authenticate(req.headers.authorization);
  });

  registerErrorHandler(app);
  await app.register(healthRoutes);
  await app.register(devicesRoutes);
  await app.register(syncRoutes);

  return app;
}
