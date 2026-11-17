import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { MeResult, PairBody, PairResult } from './devices.schema.js';

export const devicesRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/v1/devices/pair',
    { schema: { body: PairBody, response: { 200: PairResult } } },
    (req) => app.services.devices.pair(req.body),
  );

  /** Lets a device check its token is still valid (and not disabled). */
  app.get(
    '/v1/devices/me',
    { schema: { response: { 200: MeResult } }, preHandler: app.requireDevice },
    (req) => ({ deviceId: req.device.deviceId, tenantId: req.device.tenantId, branchId: req.device.branchId }),
  );
};
