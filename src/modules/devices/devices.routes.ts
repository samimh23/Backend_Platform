import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { LanInfo, LanReportBody, MeResult, PairBody, PairResult } from './devices.schema.js';

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

  /** The Hub reports where the other POS can reach it on the café network. */
  app.post(
    '/v1/devices/me/lan',
    {
      schema: { body: LanReportBody, response: { 200: Type.Object({ ok: Type.Literal(true) }) } },
      preHandler: app.requireDevice,
    },
    async (req) => {
      await app.services.devices.reportLan(req.device, req.body);
      return { ok: true as const };
    },
  );

  /** Everything a POS needs to work with the Hub: its address, the LAN key, the devices and their rights. */
  app.get('/v1/devices/lan', { schema: { response: { 200: LanInfo } }, preHandler: app.requireDevice }, (req) =>
    app.services.devices.lanInfo(req.device),
  );
};
