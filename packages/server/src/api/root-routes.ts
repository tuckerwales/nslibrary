import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { CreateRootRequestSchema, type LibraryRoot, UpdateRootRequestSchema } from "@nslib/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RootRow } from "../db/schema";
import type { AppContext } from "./context";
import { ApiError, parseWith } from "./errors";

const IdParamsSchema = z.object({ id: z.coerce.number().int().positive() });

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function toView(ctx: AppContext, root: RootRow): LibraryRoot {
  const stats = ctx.repo.rootStats().find((s) => s.rootId === root.id);
  return {
    id: root.id,
    path: root.path,
    label: root.label,
    enabled: root.enabled,
    usePolling: root.usePolling,
    lastScanAt: root.lastScanAt,
    lastScanError: root.lastScanError,
    fileCount: stats?.fileCount ?? 0,
    totalSize: stats?.totalSize ?? 0,
    missingCount: stats?.missingCount ?? 0,
    scan: ctx.scanner.progress(root.id),
  };
}

async function resolveFolder(input: string): Promise<string> {
  if (!isAbsolute(input)) {
    throw new ApiError("BAD_REQUEST", "Enter the full folder path, like /library/games");
  }
  try {
    const resolved = await realpath(input);
    if (!(await stat(resolved)).isDirectory()) {
      throw new ApiError(
        "BAD_REQUEST",
        `${input} is a file. Enter the folder that contains your games.`,
      );
    }
    return resolved;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new ApiError("BAD_REQUEST", `The server doesn't have permission to read ${input}`);
    }
    throw new ApiError("BAD_REQUEST", `Folder not found: ${input}`);
  }
}

function getRootOr404(ctx: AppContext, params: unknown): RootRow {
  const { id } = parseWith(IdParamsSchema, params);
  const root = ctx.repo.getRoot(id);
  if (!root) throw new ApiError("NOT_FOUND", "That library folder no longer exists");
  return root;
}

function startScan(ctx: AppContext, rootId: number): void {
  ctx.scanner
    .scanRoot(rootId)
    .catch((err) => ctx.log(`Scan of library folder ${rootId} failed`, err));
}

export async function registerRootRoutes(api: FastifyInstance, ctx: AppContext): Promise<void> {
  api.get(
    "/roots",
    async (): Promise<LibraryRoot[]> => ctx.repo.listRoots().map((root) => toView(ctx, root)),
  );

  api.post("/roots", async (request, reply): Promise<LibraryRoot> => {
    const body = parseWith(CreateRootRequestSchema, request.body);
    const path = await resolveFolder(body.path);
    for (const existing of ctx.repo.listRoots()) {
      if (contains(existing.path, path)) {
        throw new ApiError(
          "CONFLICT",
          `This folder is already in the library as part of ${existing.path}`,
        );
      }
      if (contains(path, existing.path)) {
        throw new ApiError(
          "CONFLICT",
          `This folder contains ${existing.path}, which is already in the library. Remove that folder first.`,
        );
      }
    }
    const root = ctx.repo.createRoot({
      path,
      label: body.label ?? null,
      usePolling: body.usePolling ?? false,
    });
    await ctx.scanner.watchRoot(root);
    startScan(ctx, root.id);
    ctx.events.publish({ type: "roots.changed" });
    reply.status(201);
    return toView(ctx, root);
  });

  api.patch("/roots/:id", async (request): Promise<LibraryRoot> => {
    const root = getRootOr404(ctx, request.params);
    const body = parseWith(UpdateRootRequestSchema, request.body);
    const updated = ctx.repo.updateRoot(root.id, body) ?? root;
    if (body.enabled !== undefined || body.usePolling !== undefined) {
      await ctx.scanner.watchRoot(updated);
      if (updated.enabled && !root.enabled) startScan(ctx, updated.id);
    }
    ctx.events.publish({ type: "roots.changed" });
    if (body.enabled !== undefined)
      ctx.events.publish({ type: "library.changed", rev: ctx.repo.catalogRev() });
    return toView(ctx, updated);
  });

  api.delete("/roots/:id", async (request, reply) => {
    const root = getRootOr404(ctx, request.params);
    await ctx.scanner.unwatchRoot(root.id);
    ctx.repo.deleteRoot(root.id);
    ctx.events.publish({ type: "roots.changed" });
    ctx.events.publish({ type: "library.changed", rev: ctx.repo.catalogRev() });
    return reply.status(204).send();
  });

  api.post("/roots/:id/scan", async (request, reply): Promise<LibraryRoot> => {
    const root = getRootOr404(ctx, request.params);
    if (!root.enabled) throw new ApiError("CONFLICT", "Turn this folder on before scanning it");
    startScan(ctx, root.id);
    reply.status(202);
    return toView(ctx, root);
  });
}
