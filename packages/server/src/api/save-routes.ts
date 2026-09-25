import {
  DEVICE_API_PROTOCOL_VERSION,
  type SaveBackup,
  SaveBackupQuerySchema,
  SaveListQuerySchema,
  type SaveListResponse,
  SaveUploadQuerySchema,
  type SaveUploadResponse,
  UpdateSaveBackupRequestSchema,
} from "@nslib/shared";
import { inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client";
import { titledbTitles } from "../db/schema";
import { etagsMatch, parseRangeHeader } from "../device/range";
import { FileHandleReader } from "../library/file-reader";
import { listApplications } from "../library/queries";
import { rangeReadable } from "../library/range-stream";
import type { AppNames } from "../saves/service";
import type { AppContext } from "./context";
import { ApiError, parseWith } from "./errors";

const IdParams = z.object({ id: z.coerce.number().int().positive() });

/** Content types a save archive may be uploaded as. The body is streamed to disk, not parsed. */
const ARCHIVE_TYPES = ["application/x-tar", "application/octet-stream"];

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Sends an inclusive byte range of a file. Read through `rangeReadable` like library files rather
 * than an fs.ReadStream: with a Content-Length over 64 KB, Fastify leaves the keep-alive socket
 * of an fs.ReadStream reply marked busy, and the server then can't shut down until it times out.
 */
async function sendFileRange(
  request: FastifyRequest,
  reply: FastifyReply,
  path: string,
  start: number,
  end: number,
): Promise<void> {
  const source = await FileHandleReader.open(path);
  const stream = rangeReadable(source, start, end);
  const close = () => {
    request.raw.off("close", close);
    stream.destroy();
    void source.close();
  };
  request.raw.on("close", close);
  stream.on("end", close);
  stream.on("error", close);
  return reply.send(stream);
}

/** Library names first, then titledb (when on) for games that are not in the library. */
export function saveAppNames(db: Db, titledb: boolean): AppNames {
  return (ids) => {
    const wanted = new Set(ids);
    const names = new Map<string, { name: string; iconUrl: string | null }>();
    if (wanted.size === 0) return names;
    for (const app of listApplications(db, { titledb })) {
      if (wanted.has(app.applicationId)) {
        names.set(app.applicationId, { name: app.name, iconUrl: app.iconUrl });
      }
    }
    const missing = ids.filter((id) => !names.has(id));
    if (titledb && missing.length > 0) {
      const rows = db
        .select({ titleId: titledbTitles.titleId, name: titledbTitles.name })
        .from(titledbTitles)
        .where(inArray(titledbTitles.titleId, missing))
        .all();
      for (const row of rows) {
        if (row.name) names.set(row.titleId, { name: row.name, iconUrl: null });
      }
    }
    return names;
  };
}

/** `Rick's Save - Player - 2026-09-25.tar`, keeping only characters every filesystem accepts. */
export function archiveFileName(backup: SaveBackup): string {
  const date = new Date(backup.createdAt)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ")
    .replaceAll(":", "-");
  const who = backup.type === "device" ? "device" : (backup.userName ?? backup.userId ?? "user");
  const name = `${backup.name} - ${who} - ${date}.tar`;
  // Control characters and the ones Windows forbids in file names.
  const safe = [...name].map((c) => (c.charCodeAt(0) < 0x20 ? "_" : c)).join("");
  return safe.replace(/[\\/:*?"<>|]+/g, "_");
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Web UI: list, download, pin, annotate and delete save backups. */
export async function registerSaveWebRoutes(api: FastifyInstance, ctx: AppContext): Promise<void> {
  const names = () => saveAppNames(ctx.db, ctx.titledb.enabled());

  api.get("/saves", async (request): Promise<SaveBackup[]> => {
    const query = parseWith(SaveBackupQuerySchema, request.query);
    return ctx.saves.toWeb(ctx.saves.list({ applicationId: query.app }), names());
  });

  api.get("/saves/:id/download", async (request, reply) => {
    const { id } = parseWith(IdParams, request.params);
    const located = await ctx.saves.locate(id);
    const [backup] = ctx.saves.toWeb([located.row], names());
    if (!backup) throw new ApiError("NOT_FOUND", "That save backup no longer exists");
    reply
      .header("content-type", "application/x-tar")
      .header("content-length", String(located.size))
      .header("content-disposition", contentDisposition(archiveFileName(backup)));
    return sendFileRange(request, reply, located.path, 0, located.size - 1);
  });

  api.patch("/saves/:id", async (request): Promise<SaveBackup> => {
    const { id } = parseWith(IdParams, request.params);
    const body = parseWith(UpdateSaveBackupRequestSchema, request.body);
    const [backup] = ctx.saves.toWeb([ctx.saves.update(id, body)], names());
    if (!backup) throw new ApiError("NOT_FOUND", "That save backup no longer exists");
    return backup;
  });

  api.delete("/saves/:id", async (request, reply) => {
    const { id } = parseWith(IdParams, request.params);
    await ctx.saves.delete(id);
    return reply.status(204).send();
  });
}

/** Device API: a paired console lists, uploads and downloads save archives. */
export async function registerSaveDeviceRoutes(
  api: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  // Passed through as a stream; SaveService enforces the size limit while writing it to disk.
  api.addContentTypeParser(ARCHIVE_TYPES, (_request, payload, done) => done(null, payload));

  api.get("/saves", async (request): Promise<SaveListResponse> => {
    const device = request.device;
    if (!device) throw new ApiError("UNAUTHORIZED", "Pair this Switch before continuing");
    const query = parseWith(SaveListQuerySchema, request.query);
    const rows = ctx.saves.list({ applicationId: query.app, latest: query.latest === "1" });
    return { backups: ctx.saves.toDevice(rows, device.id) };
  });

  api.post("/saves", async (request, reply): Promise<SaveUploadResponse> => {
    const device = request.device;
    if (!device) throw new ApiError("UNAUTHORIZED", "Pair this Switch before continuing");
    const query = parseWith(SaveUploadQuerySchema, request.query);
    const type = headerString(request.headers["content-type"])?.split(";")[0]?.trim();
    if (!type || !ARCHIVE_TYPES.includes(type.toLowerCase())) {
      throw new ApiError("BAD_REQUEST", "Upload the save archive as application/x-tar");
    }
    const length = Number(headerString(request.headers["content-length"]));
    const body = request.body as NodeJS.ReadableStream | undefined;
    if (!body) throw new ApiError("BAD_REQUEST", "The request has no save archive");
    const stored = await ctx.saves.store(
      body as AsyncIterable<Uint8Array>,
      query,
      device,
      Number.isFinite(length) ? length : undefined,
    );
    const [backup] = ctx.saves.toDevice([stored.row], device.id);
    if (!backup) throw new ApiError("INTERNAL", "The backup was stored but could not be read back");
    reply.status(stored.dup ? 200 : 201);
    return { backup, dup: stored.dup };
  });

  api.get("/saves/:id/data", async (request, reply) => {
    const { id } = parseWith(IdParams, request.params);
    return sendArchive(ctx, request, reply, id);
  });
}

/** The archive with Range support, so the console can resume a restore download. */
async function sendArchive(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  id: number,
): Promise<void> {
  const located = await ctx.saves.locate(id);
  const size = located.size;
  // The archive never changes once stored, so its hash is a strong validator.
  const etag = `"${located.row.sha256}"`;
  const ifRange = headerString(request.headers["if-range"]);
  const useRange = !ifRange || etagsMatch(ifRange, etag);
  const parsed = useRange ? parseRangeHeader(headerString(request.headers.range), size) : "all";

  reply
    .header("accept-ranges", "bytes")
    .header("etag", etag)
    .header("x-nslib-proto", String(DEVICE_API_PROTOCOL_VERSION))
    .type("application/x-tar");
  if (parsed === "unsatisfiable") {
    reply.header("content-range", `bytes */${size}`);
    throw new ApiError("RANGE_NOT_SATISFIABLE", "Requested range is outside the archive");
  }
  if (parsed === "all") {
    reply.header("content-length", String(size));
    return sendFileRange(request, reply, located.path, 0, size - 1);
  }
  reply
    .status(206)
    .header("content-range", `bytes ${parsed.start}-${parsed.end}/${size}`)
    .header("content-length", String(parsed.end - parsed.start + 1));
  return sendFileRange(request, reply, located.path, parsed.start, parsed.end);
}
