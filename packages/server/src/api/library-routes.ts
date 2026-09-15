import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
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
    .enum(["no-base", "duplicate", "superseded-updates", "guessed-dlc-base", "unknown-version"])
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
  api.get("/stats", async () => getStats(ctx.db, ctx.repo.catalogRev()));

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
