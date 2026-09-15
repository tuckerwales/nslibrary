import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { WEB_API_BASE_PATH } from "@nslib/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes, requireSession } from "./api/auth-routes";
import type { AppContext } from "./api/context";
import { registerErrorHandling } from "./api/errors";
import { registerLibraryRoutes } from "./api/library-routes";
import { registerRootRoutes } from "./api/root-routes";

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: ctx.config.logLevel === false ? false : { level: ctx.config.logLevel },
    trustProxy: ctx.config.trustProxy,
  });
  app.decorateRequest("username", null);
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
      });
    },
    { prefix: WEB_API_BASE_PATH },
  );

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
