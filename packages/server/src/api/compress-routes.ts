import {
  type CompressCandidate,
  type CompressFolderOption,
  CompressRequestSchema,
  type CompressSettings,
  CompressSettingsSchema,
  type CompressStartResponse,
  type CompressTask,
} from "@nslib/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "./context";
import { ApiError, parseWith } from "./errors";

const FileIdParams = z.object({ id: z.coerce.number().int().positive() });

export async function registerCompressRoutes(api: FastifyInstance, ctx: AppContext): Promise<void> {
  api.get("/compress", async (): Promise<CompressTask[]> => ctx.compress.list());

  api.get("/compress/settings", async (): Promise<CompressSettings> => ctx.compress.settings());

  api.put("/compress/settings", async (request): Promise<CompressSettings> => {
    const body = parseWith(CompressSettingsSchema, request.body);
    return ctx.compress.updateSettings(body);
  });

  api.get(
    "/compress/folders",
    async (): Promise<CompressFolderOption[]> => ctx.compress.folderOptions(),
  );

  api.post("/compress/clear", async (): Promise<CompressTask[]> => ctx.compress.clearFinished());

  api.get(
    "/compress/candidates",
    async (): Promise<CompressCandidate[]> => ctx.compress.candidates(),
  );

  /** Queues several files; ones that can't be compressed are listed rather than failing all. */
  api.post("/compress", async (request, reply): Promise<CompressStartResponse> => {
    const { fileIds } = parseWith(CompressRequestSchema, request.body);
    const response: CompressStartResponse = { tasks: [], skipped: [] };
    for (const fileId of new Set(fileIds)) {
      try {
        response.tasks.push(await ctx.compress.start(fileId));
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        response.skipped.push({ fileId, reason: err.message });
      }
    }
    reply.status(202);
    return response;
  });

  api.post("/files/:id/compress", async (request, reply): Promise<CompressTask> => {
    const { id } = parseWith(FileIdParams, request.params);
    reply.status(202);
    return ctx.compress.start(id);
  });

  api.post("/files/:id/compress/remove-original", async (request): Promise<CompressTask> => {
    const { id } = parseWith(FileIdParams, request.params);
    return ctx.compress.removeOriginal(id);
  });

  api.post("/files/:id/compress/cancel", async (request): Promise<CompressTask> => {
    const { id } = parseWith(FileIdParams, request.params);
    return ctx.compress.cancel(id);
  });
}
