import {
  CreateJobsRequestSchema,
  type DeviceDetail,
  type DeviceSummary,
  type PairingCode,
  RenameDeviceRequestSchema,
  ReorderJobsRequestSchema,
  type SpaceCheck,
  SpaceCheckRequestSchema,
  type WebJob,
} from "@nslib/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "./context";
import { parseWith } from "./errors";

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const JobsQuery = z.object({
  deviceId: z.coerce.number().int().positive().optional(),
  /** Most recently finished jobs to include; active jobs are always listed. */
  limit: z.coerce.number().int().min(0).max(1000).optional(),
});

export async function registerDeviceWebRoutes(
  api: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  api.post(
    "/devices/pairing-code",
    async (): Promise<PairingCode> => ctx.devices.createPairingCode(),
  );

  api.get("/devices", async (): Promise<DeviceSummary[]> => ctx.devices.listDevices());

  api.get("/devices/:id", async (request): Promise<DeviceDetail> => {
    const { id } = parseWith(IdParams, request.params);
    return ctx.devices.getDevice(id);
  });

  api.patch("/devices/:id", async (request): Promise<DeviceDetail> => {
    const { id } = parseWith(IdParams, request.params);
    const body = parseWith(RenameDeviceRequestSchema, request.body);
    return ctx.devices.renameDevice(id, body.name);
  });

  api.post("/devices/:id/revoke", async (request): Promise<DeviceDetail> => {
    const { id } = parseWith(IdParams, request.params);
    return ctx.devices.revokeDevice(id);
  });

  api.post("/devices/:id/space-check", async (request): Promise<SpaceCheck> => {
    const { id } = parseWith(IdParams, request.params);
    const body = parseWith(SpaceCheckRequestSchema, request.body);
    return ctx.devices.checkSpace(id, body.items, body.target ?? "auto");
  });

  api.get("/jobs", async (request): Promise<WebJob[]> => {
    const query = parseWith(JobsQuery, request.query);
    return ctx.devices.listJobs(query.deviceId, query.limit);
  });

  api.post("/jobs", async (request, reply): Promise<WebJob[]> => {
    const body = parseWith(CreateJobsRequestSchema, request.body);
    const jobs = ctx.devices.createJobs(body.deviceId, body.items, body.target ?? "auto");
    reply.status(201);
    return jobs;
  });

  api.post("/jobs/:id/cancel", async (request): Promise<WebJob> => {
    const { id } = parseWith(IdParams, request.params);
    return ctx.devices.cancelJob(id);
  });

  api.post("/jobs/:id/resume", async (request): Promise<WebJob> => {
    const { id } = parseWith(IdParams, request.params);
    return ctx.devices.resumeJob(id);
  });

  api.put("/jobs/order", async (request): Promise<WebJob[]> => {
    const body = parseWith(ReorderJobsRequestSchema, request.body);
    return ctx.devices.reorderJobs(body.deviceId, body.ids);
  });
}
