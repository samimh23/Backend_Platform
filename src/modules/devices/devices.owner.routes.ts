import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import {
  BranchParams,
  CreatePairingCodeBody,
  DeviceParams,
  DeviceView,
  PairingCodeView,
  UpdateDeviceBody,
} from './devices.schema.js';

/** Owner app: manage the POS devices of a branch. All routes need "Authorization: Bearer <accessToken>". */
export const ownerDevicesRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook('preHandler', app.requireOwner);

  app.post(
    '/v1/owner/branches/:branchId/pairing-codes',
    { schema: { params: BranchParams, body: CreatePairingCodeBody, response: { 200: PairingCodeView } } },
    (req) => app.services.devices.createPairingCode(req.owner, req.params.branchId, req.body.role),
  );

  app.get(
    '/v1/owner/branches/:branchId/pairing-codes',
    { schema: { params: BranchParams, response: { 200: Type.Array(PairingCodeView) } } },
    (req) => app.services.devices.listPairingCodes(req.owner, req.params.branchId),
  );

  app.get(
    '/v1/owner/branches/:branchId/devices',
    { schema: { params: BranchParams, response: { 200: Type.Array(DeviceView) } } },
    (req) => app.services.devices.listDevices(req.owner, req.params.branchId),
  );

  app.patch(
    '/v1/owner/devices/:deviceId',
    { schema: { params: DeviceParams, body: UpdateDeviceBody, response: { 200: DeviceView } } },
    (req) => app.services.devices.updateDevice(req.owner, req.params.deviceId, req.body),
  );
};
