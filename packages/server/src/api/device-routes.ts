import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  CatalogQuerySchema,
  ClaimJobResponseSchema,
  CreateJobRequestSchema,
  DEVICE_API_PROTOCOL_VERSION,
  DeviceStateSchema,
  EventsQuerySchema,
  JobCompleteRequestSchema,
  JobProgressRequestSchema,
  PairRequestSchema,
  type PairResponse,
} from "@nslib/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { etagFor, etagsMatch, parseRangeHeader } from "../device/range";
import type { AppContext } from "./context";
import { ApiError, parseWith } from "./errors";

const STREAM_CHUNK = 1024 * 1024;
const TitleIdParams = z.object({
  appId: z
    .string()
    .regex(/^[0-9A-Fa-f]{16}$/, "Expected a 16-digit title ID")
    .transform((id) => id.toUpperCase()),
});
const FileIdParams = z.object({ fileId: z.coerce.number().int().positive() });
const JobIdParams = z.object({ id: z.coerce.number().int().positive() });

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function requireDevice(ctx: AppContext) {
  return async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const device = ctx.devices.requireActive(ctx.devices.resolveToken(token));
    request.device = device;
    ctx.devices.touch(device.id, "http");
  };
}

export async function registerDeviceRoutes(api: FastifyInstance, ctx: AppContext): Promise<void> {
  api.post("/pair", async (request): Promise<PairResponse> => {
    const body = parseWith(PairRequestSchema, request.body);
    return ctx.devices.pair(body, "http");
  });

  await api.register(async (secured) => {
    secured.addHook("onRequest", requireDevice(ctx));

    secured.get("/hello", async () => ctx.devices.hello());

    secured.put("/state", async (request, reply) => {
      const device = request.device;
      if (!device) throw new ApiError("UNAUTHORIZED", "Pair this Switch before continuing");
      ctx.devices.updateState(device.id, parseWith(DeviceStateSchema, request.body));
      return reply.status(204).send();
    });

    secured.get("/catalog", async (request) =>
      ctx.devices.getCatalog(parseWith(CatalogQuerySchema, request.query)),
    );

    secured.get("/icons/:appId", async (request, reply) => {
      const { appId } = parseWith(TitleIdParams, request.params);
      const key = ctx.devices.iconKey(appId);
      if (!key) throw new ApiError("NOT_FOUND", "No icon for this title");
      const path = `${ctx.iconDir}/${key}.jpg`;
      try {
        await stat(path);
      } catch {
        throw new ApiError("NOT_FOUND", "No icon for this title");
      }
      reply.header("cache-control", "public, max-age=31536000, immutable").type("image/jpeg");
      return reply.send(createReadStream(path));
    });

    secured.get("/files/:fileId", async (request, reply) => {
      const { fileId } = parseWith(FileIdParams, request.params);
      return sendLibraryFile(ctx, request, reply, fileId);
    });

    secured.get("/events", async (request) => {
      const device = request.device;
      if (!device) throw new ApiError("UNAUTHORIZED", "Pair this Switch before continuing");
      const query = parseWith(EventsQuerySchema, request.query);
      const abort = new AbortController();
      let finished = false;
      const onClose = () => {
        if (!finished) abort.abort();
      };
      request.raw.on("close", onClose);
      try {
        return await ctx.devices.pollEvents(device, query, abort.signal);
      } finally {
        finished = true;
        request.raw.off("close", onClose);
      }
    });

    secured.post("/jobs", async (request, reply) => {
      const device = request.device;
      if (!device) throw new ApiError("UNAUTHORIZED", "Pair this Switch before continuing");
      const body = parseWith(CreateJobRequestSchema, request.body);
      const job = ctx.devices.createJobFromDevice(
        device.id,
        body.contentMetaId,
        body.target ?? "sd",
      );
      reply.status(201);
      return job;
    });

    secured.post("/jobs/:id/claim", async (request) => {
      const device = request.device;
      if (!device) throw new ApiError("UNAUTHORIZED", "Pair this Switch before continuing");
      const { id } = parseWith(JobIdParams, request.params);
      return ClaimJobResponseSchema.parse({ job: ctx.devices.claimJob(device.id, id) });
    });

    secured.post("/jobs/:id/progress", async (request, reply) => {
      const device = request.device;
      if (!device) throw new ApiError("UNAUTHORIZED", "Pair this Switch before continuing");
      const { id } = parseWith(JobIdParams, request.params);
      ctx.devices.progress(device.id, id, parseWith(JobProgressRequestSchema, request.body));
      return reply.status(204).send();
    });

    secured.post("/jobs/:id/complete", async (request, reply) => {
      const device = request.device;
      if (!device) throw new ApiError("UNAUTHORIZED", "Pair this Switch before continuing");
      const { id } = parseWith(JobIdParams, request.params);
      ctx.devices.complete(device.id, id, parseWith(JobCompleteRequestSchema, request.body));
      return reply.status(204).send();
    });
  });
}

async function sendLibraryFile(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  fileId: number,
): Promise<void> {
  const located = ctx.devices.locateLibraryFile(fileId);
  let disk: { size: number; mtimeMs: number };
  try {
    const info = await stat(located.absolutePath);
    disk = { size: info.size, mtimeMs: Math.floor(info.mtimeMs) };
  } catch {
    throw new ApiError("FILE_MISSING", "This file is no longer on disk");
  }

  const etag = etagFor(disk.size, disk.mtimeMs);
  const ifMatch = headerString(request.headers["if-match"]);
  if (ifMatch && ifMatch !== "*" && !etagsMatch(ifMatch, etag)) {
    throw new ApiError("FILE_CHANGED", "The file changed since it was listed");
  }

  const ifRange = headerString(request.headers["if-range"]);
  const rangeHeader = headerString(request.headers.range);
  const useRange = !ifRange || etagsMatch(ifRange, etag);
  const parsed = useRange ? parseRangeHeader(rangeHeader, disk.size) : "all";

  reply
    .header("accept-ranges", "bytes")
    .header("etag", etag)
    .header("last-modified", new Date(disk.mtimeMs).toUTCString())
    .header("x-nslib-proto", String(DEVICE_API_PROTOCOL_VERSION))
    .type("application/octet-stream");

  if (parsed === "unsatisfiable") {
    reply.header("content-range", `bytes */${disk.size}`);
    throw new ApiError("RANGE_NOT_SATISFIABLE", "Requested range is outside the file");
  }

  const range = parsed === "all" ? { start: 0, end: Math.max(0, disk.size - 1) } : parsed;
  const length = disk.size === 0 ? 0 : range.end - range.start + 1;
  if (parsed !== "all") {
    reply
      .status(206)
      .header("content-range", `bytes ${range.start}-${range.end}/${disk.size}`)
      .header("content-length", String(length));
  } else {
    reply.header("content-length", String(disk.size));
  }

  if (disk.size === 0) {
    return reply.send(Buffer.alloc(0));
  }

  const stream = createReadStream(located.absolutePath, {
    start: range.start,
    end: range.end,
    highWaterMark: STREAM_CHUNK,
  });
  request.raw.on("close", () => stream.destroy());
  return reply.send(stream);
}
