import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { APP_SORTS, VerifyRequestSchema, type VerifyTask } from "@nslib/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SESSION_COOKIE } from "../auth/auth-service";
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
  sort: z.enum(APP_SORTS).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

const AppParamsSchema = z.object({
  applicationId: z
    .string()
    .regex(/^[0-9A-Fa-f]{16}$/, "Expected a 16-digit title ID")
    .transform((id) => id.toUpperCase()),
});

/** How often an open event socket re-checks its session. */
export const WS_SESSION_CHECK_MS = 30_000;
/** Close code for a socket whose session ended (4000-4999 is for applications). */
const WS_SESSION_ENDED = 4001;

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

  api.get("/ws", { websocket: true }, (socket, request) => {
    const token = request.cookies[SESSION_COOKIE];
    const unsubscribe = ctx.events.subscribe((event) => socket.send(JSON.stringify(event)));
    // The session is checked once when the socket opens; sign-out, a password change, or expiry
    // closes it here, and the page then finds it is signed out.
    const recheck = setInterval(() => {
      if (!ctx.auth.resolveSession(token)) socket.close(WS_SESSION_ENDED, "Signed out");
    }, WS_SESSION_CHECK_MS);
    recheck.unref();
    socket.on("close", () => {
      clearInterval(recheck);
      unsubscribe();
    });
  });
}
