import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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
import { LoginRateLimiter } from "../auth/auth-service";
import { etagFor, etagsMatch, parseRangeHeader } from "../device/range";
import { openLocatedFile } from "../library/library-fs";
import { rangeReadable } from "../library/range-stream";
import type { AppContext } from "./context";
import { ApiError, parseWith } from "./errors";
import { registerSaveDeviceRoutes } from "./save-routes";

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

/** Wrong pairing codes allowed per address in 15 minutes, across however many codes are issued. */
const PAIR_FAILURES_PER_ADDRESS = 10;

export async function registerDeviceRoutes(api: FastifyInstance, ctx: AppContext): Promise<void> {
  const pairLimiter = new LoginRateLimiter(PAIR_FAILURES_PER_ADDRESS);

  api.post("/pair", async (request): Promise<PairResponse> => {
    const body = parseWith(PairRequestSchema, request.body);
    // Checked first, so a guessing address can't use up the code's attempts for everyone else.
    if (pairLimiter.isLimited(request.ip)) {
      throw new ApiError(
        "PAIR_RATE_LIMITED",
        "Too many wrong pairing codes. Try again in 15 minutes.",
      );
    }
    try {
      const paired = ctx.devices.pair(body, "http");
      pairLimiter.reset(request.ip);
      return paired;
    } catch (err) {
      if (err instanceof ApiError && err.code !== "PAIR_CODE_EXPIRED") {
        pairLimiter.recordFailure(request.ip);
      }
      throw err;
    }
  });

  await api.register(async (secured) => {
    secured.addHook("onRequest", requireDevice(ctx));

    secured.get("/hello", async (request) => ctx.devices.hello(request.device?.id));

    secured.get("/update", async (_request, reply) => {
      const nroPath = ctx.devices.nroPath();
      if (!nroPath)
        throw new ApiError("NOT_FOUND", "No Switch app update is available on this server");
      try {
        const info = await stat(nroPath);
        reply
          .header("content-type", "application/octet-stream")
          .header("content-length", String(info.size))
          .header("content-disposition", 'attachment; filename="nslibrary.nro"');
        return reply.send(createReadStream(nroPath));
      } catch {
        throw new ApiError("NOT_FOUND", "No Switch app update is available on this server");
      }
    });

    for (const kind of ["manifest", "signature"] as const) {
      secured.get(`/update/${kind}`, async (_request, reply) => {
        const path = ctx.devices.updateFilePath(kind);
        const missing = () =>
          new ApiError(
            "NOT_FOUND",
            "The Switch app on this server has no update.json signature. Copy update.json and update.json.sig from the GitHub release next to the .nro.",
          );
        if (!path) throw missing();
        try {
          const payload = await readFile(path);
          // Exact bytes: the Switch verifies the signature over them.
          return reply.header("content-type", "application/octet-stream").send(payload);
        } catch {
          throw missing();
        }
      });
    }

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

    await registerSaveDeviceRoutes(secured, ctx);
  });
}

async function sendLibraryFile(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  fileId: number,
): Promise<void> {
  const located = await ctx.devices.locateLibraryFile(fileId);
  const disk = { size: located.size, mtimeMs: located.mtimeMs };

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

  const source = await openLocatedFile(located);
  const stream = rangeReadable(source, range.start, range.end);
  const close = () => {
    stream.destroy();
    void source.close();
  };
  request.raw.on("close", close);
  stream.on("end", () => {
    request.raw.off("close", close);
    void source.close();
  });
  stream.on("error", () => {
    request.raw.off("close", close);
    void source.close();
  });
  return reply.send(stream);
}
