import { readFileSync } from "node:fs";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { DEVICE_API_BASE_PATH, WEB_API_BASE_PATH } from "@nslib/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes, requireSession } from "./api/auth-routes";
import { registerCompressRoutes } from "./api/compress-routes";
import type { AppContext } from "./api/context";
import { registerDeviceRoutes } from "./api/device-routes";
import { registerDeviceWebRoutes } from "./api/device-web-routes";
import { registerErrorHandling } from "./api/errors";
import { registerKeysRoutes } from "./api/keys-routes";
import { registerLibraryRoutes } from "./api/library-routes";
import { registerRootRoutes } from "./api/root-routes";

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const logger = ctx.config.logLevel === false ? false : { level: ctx.config.logLevel };
  const app = (
    ctx.config.tlsKey && ctx.config.tlsCert
      ? Fastify({
          logger,
          trustProxy: ctx.config.trustProxy,
          https: {
            key: readFileSync(ctx.config.tlsKey),
            cert: readFileSync(ctx.config.tlsCert),
          },
        })
      : Fastify({ logger, trustProxy: ctx.config.trustProxy })
  ) as FastifyInstance;
  app.decorateRequest("username", null);
  app.decorateRequest("device", null);
  registerErrorHandling(app);
  await app.register(cookie);
  await app.register(websocket);

  app.get("/api/health", async () => ({ ok: true }));

  await app.register(
    async (api) => {
      await registerAuthRoutes(api, ctx);
      await api.register(async (secured) => {
        secured.addHook("onRequest", requireSession(ctx));
        await registerRootRoutes(secured, ctx);
        await registerLibraryRoutes(secured, ctx);
        await registerCompressRoutes(secured, ctx);
        await registerKeysRoutes(secured, ctx);
        await registerDeviceWebRoutes(secured, ctx);
      });
    },
    { prefix: WEB_API_BASE_PATH },
  );

  await app.register(async (api) => registerDeviceRoutes(api, ctx), {
    prefix: DEVICE_API_BASE_PATH,
  });

  const { webDir } = ctx.config;
  if (webDir) await app.register(fastifyStatic, { root: webDir, wildcard: false });

  app.setNotFoundHandler((request, reply) => {
    // Client-side routes (e.g. /apps/0100…) load the single-page app.
    if (webDir && request.method === "GET" && !request.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    const path = request.url.split("?")[0];
    return reply
      .status(404)
      .send({ error: { code: "NOT_FOUND", msg: `No route for ${request.method} ${path}` } });
  });

  return app;
}
