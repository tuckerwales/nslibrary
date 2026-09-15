import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { VerifyRequestSchema, type VerifyTask } from "@nslib/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getApplication,
  getProblems,
  getStats,
  listApplications,
  listHomebrew,
} from "../library/queries";
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

export async function registerLibraryRoutes(api: FastifyInstance, ctx: AppContext): Promise<void> {
  api.get("/stats", async () =>
    getStats(ctx.db, ctx.repo.catalogRev(), {
      keysConfigured: ctx.keys.hasConsoleKeys(),
      titledb: ctx.titledb.enabled(),
    }),
  );

  api.get("/apps", async (request) =>
    listApplications(ctx.db, {
      ...parseWith(AppListQuerySchema, request.query),
      titledb: ctx.titledb.enabled(),
    }),
  );

  api.get("/apps/:applicationId", async (request) => {
    const { applicationId } = parseWith(AppParamsSchema, request.params);
    const app = getApplication(ctx.db, applicationId, {
      preferCompressed: ctx.devices.preferNsz(),
      titledb: ctx.titledb.enabled(),
    });
    if (!app) throw new ApiError("NOT_FOUND", "No files for this title are in the library");
    return app;
  });

  api.get("/homebrew", async () => listHomebrew(ctx.db));

  api.get("/problems", async () => getProblems(ctx.db, ctx.titledb.enabled()));

  const FileIdParams = z.object({ id: z.coerce.number().int().positive() });

  api.get("/verify", async (): Promise<VerifyTask[]> => ctx.verify.list());

  api.post("/files/:id/verify", async (request, reply): Promise<VerifyTask> => {
    const { id } = parseWith(FileIdParams, request.params);
    const body = parseWith(VerifyRequestSchema, request.body ?? {});
    reply.status(202);
    return ctx.verify.start(id, body.mode ?? "full");
  });

  api.post("/files/:id/verify/cancel", async (request): Promise<VerifyTask> => {
    const { id } = parseWith(FileIdParams, request.params);
    return ctx.verify.cancel(id);
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
