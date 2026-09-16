import {
  CreateForwarderRequestSchema,
  type ForwarderStatus,
  type KeyStatus,
  PutKeysRequestSchema,
  type ServerSettings,
  ServerSettingsSchema,
  TitledbConfigSchema,
  type TitledbStatus,
} from "@nslib/shared";
import type { FastifyInstance } from "fastify";
import { forwarderStatus, packForwarder } from "../forwarder";
import { EmptyKeysetError } from "../keys/store";
import type { AppContext } from "./context";
import { ApiError, parseWith } from "./errors";

export async function registerKeysRoutes(api: FastifyInstance, ctx: AppContext): Promise<void> {
  api.get("/keys/status", async (): Promise<KeyStatus> => ctx.keys.status());

  api.put("/keys", async (request): Promise<KeyStatus> => {
    const { contents } = parseWith(PutKeysRequestSchema, request.body);
    try {
      const status = await ctx.keys.save(contents);
      ctx.scanner.reparseAll().catch((err) => ctx.log("Rescan after keys upload failed", err));
      ctx.events.publish({ type: "library.changed", rev: ctx.repo.catalogRev() });
      return status;
    } catch (err) {
      if (err instanceof EmptyKeysetError) throw new ApiError("BAD_REQUEST", err.message);
      throw err;
    }
  });

  api.get("/titledb", async (): Promise<TitledbStatus> => ctx.titledb.status());

  api.put("/titledb", async (request): Promise<TitledbStatus> => {
    const body = parseWith(TitledbConfigSchema, request.body);
    return ctx.titledb.configure(body);
  });

  api.post("/titledb/refresh", async (): Promise<TitledbStatus> => {
    const status = await ctx.titledb.refresh();
    ctx.events.publish({ type: "library.changed", rev: ctx.repo.catalogRev() });
    return status;
  });

  api.get("/settings", async (): Promise<ServerSettings> => ctx.devices.getSettings());

  api.put("/settings", async (request): Promise<ServerSettings> => {
    const body = parseWith(ServerSettingsSchema, request.body);
    return ctx.devices.updateSettings(body);
  });

  api.get("/forwarder", async (): Promise<ForwarderStatus> => {
    return forwarderStatus(ctx.config, ctx.keys.get());
  });

  api.post("/forwarder", async (request, reply) => {
    const body = parseWith(CreateForwarderRequestSchema, request.body ?? {});
    const { nsp, loader } = packForwarder(ctx.config, ctx.keys.get(), body);
    const name = (body.name ?? "NSLibrary").replace(/[^\w.-]+/g, "_");
    reply
      .header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename="${name}.nsp"`)
      .header("x-nslib-forwarder-loader", loader);
    return reply.send(nsp);
  });
}
