import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Db } from './db/client.js';
import { DrizzleAuthRepo, type AuthRepo } from './modules/auth/auth.repo.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { AuthService, type OwnerContext } from './modules/auth/auth.service.js';
import { BusinessService, businessRoutes, DrizzleBusinessRepo, type BusinessRepo } from './modules/business/business.js';
import { DrizzleCashRepo, type CashRepo } from './modules/cash/cash.repo.js';
import { cashRoutes } from './modules/cash/cash.routes.js';
import { CashService } from './modules/cash/cash.service.js';
import { CustomersService, customerAuthRoutes, DrizzleCustomersRepo, type CustomerContext, type CustomersRepo } from './modules/customers/customers.js';
import { DrizzleCatalogRepo, type CatalogRepo } from './modules/catalog/catalog.repo.js';
import { catalogRoutes } from './modules/catalog/catalog.routes.js';
import { CatalogService } from './modules/catalog/catalog.service.js';
import { DrizzleDevicesRepo, type DevicesRepo } from './modules/devices/devices.repo.js';
import { ownerDevicesRoutes } from './modules/devices/devices.owner.routes.js';
import { devicesRoutes } from './modules/devices/devices.routes.js';
import { DevicesService, type DeviceContext } from './modules/devices/devices.service.js';
import { DrizzleHealthRepo } from './modules/health/health.repo.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { HealthService, type HealthRepo } from './modules/health/health.service.js';
import { DrizzleFloorRepo, type FloorRepo } from './modules/floor/floor.repo.js';
import { floorRoutes } from './modules/floor/floor.routes.js';
import { FloorService } from './modules/floor/floor.service.js';
import { DrizzleLoyaltyRepo, LoyaltyService, loyaltyRoutes, type LoyaltyRepo } from './modules/loyalty/loyalty.js';
import { DrizzleSalesRepo, type SalesRepo } from './modules/sales/sales.repo.js';
import { salesRoutes } from './modules/sales/sales.routes.js';
import { SalesService } from './modules/sales/sales.service.js';
import { DrizzleStaffRepo, type StaffRepo } from './modules/staff/staff.repo.js';
import { staffRoutes } from './modules/staff/staff.routes.js';
import { StaffService } from './modules/staff/staff.service.js';
import { DrizzleSyncRepo, type SyncRepo } from './modules/sync/sync.repo.js';
import { syncRoutes } from './modules/sync/sync.routes.js';
import { SyncService } from './modules/sync/sync.service.js';
import { registerErrorHandler } from './plugins/errors.js';
import { Argon2Hasher, type PasswordHasher } from './shared/passwords.js';
import { CustomerTokenService, TokenService } from './shared/tokens.js';

/** All services, wired once here. Routes only call them. */
export interface Services {
  health: HealthService;
  auth: AuthService;
  business: BusinessService;
  cash: CashService;
  catalog: CatalogService;
  customers: CustomersService;
  devices: DevicesService;
  floor: FloorService;
  loyalty: LoyaltyService;
  sales: SalesService;
  staff: StaffService;
  sync: SyncService;
}

declare module 'fastify' {
  interface FastifyInstance {
    services: Services;
    /** preHandler for device endpoints: checks "Authorization: Device <token>" and sets req.device. */
    requireDevice: (req: FastifyRequest) => Promise<void>;
    /** preHandler for owner endpoints: checks "Authorization: Bearer <accessToken>" and sets req.owner. */
    requireOwner: (req: FastifyRequest) => Promise<void>;
    /** preHandler for the customer (loyalty) app: a customer access token, never an owner one. */
    requireCustomer: (req: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    device: DeviceContext;
    owner: OwnerContext;
    customer: CustomerContext;
  }
}

/** Repos the app needs. Tests pass in-memory fakes; production builds them from the db. */
export interface Repos {
  health: HealthRepo;
  auth: AuthRepo;
  business: BusinessRepo;
  cash: CashRepo;
  catalog: CatalogRepo;
  customers: CustomersRepo;
  devices: DevicesRepo;
  floor: FloorRepo;
  loyalty: LoyaltyRepo;
  sales: SalesRepo;
  staff: StaffRepo;
  sync: SyncRepo;
}

export function reposFromDb(db: Db): Repos {
  return {
    health: new DrizzleHealthRepo(db),
    auth: new DrizzleAuthRepo(db),
    business: new DrizzleBusinessRepo(db),
    cash: new DrizzleCashRepo(db),
    catalog: new DrizzleCatalogRepo(db),
    customers: new DrizzleCustomersRepo(db),
    devices: new DrizzleDevicesRepo(db),
    floor: new DrizzleFloorRepo(db),
    loyalty: new DrizzleLoyaltyRepo(db),
    sales: new DrizzleSalesRepo(db),
    staff: new DrizzleStaffRepo(db),
    sync: new DrizzleSyncRepo(db),
  };
}

export interface AuthConfig {
  jwtSecret: string;
  accessTtlMinutes: number;
  refreshTtlDays: number;
}

export interface AppOptions {
  repos: Repos;
  auth: AuthConfig;
  logLevel?: string;
  /** Tests can use a faster hasher. */
  passwordHasher?: PasswordHasher;
}

/** Builds the app without listening — used by server.ts and by tests (app.inject). */
export async function buildApp({ repos, auth, logLevel = 'info', passwordHasher }: AppOptions) {
  const app = Fastify({ logger: { level: logLevel } }).withTypeProvider<TypeBoxTypeProvider>();

  const tokens = new TokenService(auth.jwtSecret, auth.accessTtlMinutes * 60);
  const passwords = passwordHasher ?? new Argon2Hasher();
  const services: Services = {
    health: new HealthService(repos.health),
    auth: new AuthService(repos.auth, passwords, tokens, auth.refreshTtlDays),
    business: new BusinessService(repos.business),
    cash: new CashService(repos.cash),
    catalog: new CatalogService(repos.catalog),
    customers: new CustomersService(
      repos.customers,
      passwords,
      new CustomerTokenService(auth.jwtSecret, auth.accessTtlMinutes * 60),
      auth.refreshTtlDays,
    ),
    devices: new DevicesService(repos.devices),
    floor: new FloorService(repos.floor),
    loyalty: new LoyaltyService(repos.loyalty),
    sales: new SalesService(repos.sales),
    staff: new StaffService(repos.staff),
    sync: new SyncService(repos.sync),
  };
  app.decorate('services', services);

  app.decorateRequest('device', null as unknown as DeviceContext);
  app.decorate('requireDevice', async (req: FastifyRequest) => {
    req.device = await services.devices.authenticate(req.headers.authorization);
  });

  app.decorateRequest('owner', null as unknown as OwnerContext);
  app.decorate('requireOwner', async (req: FastifyRequest) => {
    req.owner = services.auth.authenticate(req.headers.authorization);
  });

  app.decorateRequest('customer', null as unknown as CustomerContext);
  app.decorate('requireCustomer', async (req: FastifyRequest) => {
    req.customer = services.customers.authenticate(req.headers.authorization);
  });

  registerErrorHandler(app);
  // Rate limits only where a route asks for it (config.rateLimit), e.g. login.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      code: 'TOO_MANY_REQUESTS',
      message: `Too many attempts, try again in ${Math.ceil(ctx.ttl / 1000)}s`,
    }),
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(devicesRoutes);
  await app.register(ownerDevicesRoutes);
  await app.register(catalogRoutes);
  await app.register(floorRoutes);
  await app.register(salesRoutes);
  await app.register(cashRoutes);
  await app.register(businessRoutes);
  await app.register(staffRoutes);
  await app.register(syncRoutes);
  await app.register(customerAuthRoutes);
  await app.register(loyaltyRoutes);

  return app;
}
