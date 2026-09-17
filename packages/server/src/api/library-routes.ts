import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type VerifyMode, VerifyRequestSchema, type VerifyResult } from "@nslib/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { locateOnDisk, openLocatedFile } from "../library/library-fs";
import {
  getApplication,
  getProblems,
  getStats,
  listApplications,
  listHomebrew,
} from "../library/queries";
import { verifyLibraryFile } from "../library/verify";
import type { AppContext } from "./context";
import { ApiError, parseWith } from "./errors";

const AppListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  flag: z
    .enum([
      "no-base",
      "duplicate",
      "superseded-updates",
      "guessed-dlc-base",
      "unknown-version",
      "update-available",
    ])
    .optional(),
});

const AppParamsSchema = z.object({
  applicationId: z
    .string()
    .regex(/^[0-9A-Fa-f]{16}$/, "Expected a 16-digit title ID")
    .transform((id) => id.toUpperCase()),
});

const IconParamsSchema = z.object({ key: z.string().regex(/^[0-9a-f]{32}$/) });

async function verifyFile(ctx: AppContext, id: number, mode: VerifyMode): Promise<VerifyResult> {
  const file = ctx.repo.getFile(id);
  const root = file && ctx.repo.getRoot(file.rootId);
  if (!file || !root) throw new ApiError("NOT_FOUND", "That file is no longer in the library");
  if (file.missingSince !== null)
    throw new ApiError("FILE_MISSING", "This file is no longer on disk");
  const located = await locateOnDisk(root.path, file.relPath);
  if (!located) throw new ApiError("FILE_MISSING", "This file is no longer on disk");
  const reader = await openLocatedFile(located);
  try {
    return await verifyLibraryFile(ctx.repo, file, reader, mode);
  } finally {
    await reader.close();
  }
}

export async function registerLibraryRoutes(api: FastifyInstance, ctx: AppContext): Promise<void> {
  api.get("/stats", async () => getStats(ctx.db, ctx.repo.catalogRev(), ctx.keys.hasConsoleKeys()));

  api.get("/apps", async (request) =>
    listApplications(ctx.db, parseWith(AppListQuerySchema, request.query)),
  );

  api.get("/apps/:applicationId", async (request) => {
    const { applicationId } = parseWith(AppParamsSchema, request.params);
    const app = getApplication(ctx.db, applicationId);
    if (!app) throw new ApiError("NOT_FOUND", "No files for this title are in the library");
    return app;
  });

  api.get("/homebrew", async () => listHomebrew(ctx.db));

  api.get("/problems", async () => getProblems(ctx.db));

  // A full verify reads the whole file; a second request for the same file joins the first.
  const verifying = new Map<string, Promise<VerifyResult>>();

  api.post("/files/:id/verify", async (request): Promise<VerifyResult> => {
    const { id } = parseWith(z.object({ id: z.coerce.number().int().positive() }), request.params);
    const body = parseWith(VerifyRequestSchema, request.body ?? {});
    const mode = body.mode ?? "full";
    const key = `${id}:${mode}`;
    const running = verifying.get(key);
    if (running) return running;
    const verify = verifyFile(ctx, id, mode).finally(() => verifying.delete(key));
    verifying.set(key, verify);
    return verify;
  });

  api.get("/icons/:key", async (request, reply) => {
    const { key } = parseWith(IconParamsSchema, request.params);
    const path = join(ctx.iconDir, `${key}.jpg`);
    try {
      await stat(path);
    } catch {
      throw new ApiError("NOT_FOUND", "Icon not found");
    }
    // Icon keys are content hashes, so a cached copy never goes stale.
    reply.header("cache-control", "private, max-age=31536000, immutable").type("image/jpeg");
    return reply.send(createReadStream(path));
  });

  api.get("/ws", { websocket: true }, (socket) => {
    const unsubscribe = ctx.events.subscribe((event) => socket.send(JSON.stringify(event)));
    socket.on("close", unsubscribe);
  });
}
