import { type AuthStatus, LoginRequestSchema, SetupRequestSchema } from "@nslib/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE } from "../auth/auth-service";
import type { AppContext } from "./context";
import { ApiError, parseWith } from "./errors";

function cookieOptions(request: FastifyRequest, expiresAt: number) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "strict" as const,
    secure: request.protocol === "https",
    expires: new Date(expiresAt),
  };
}

function startSession(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  username: string,
): AuthStatus {
  const { token, expiresAt } = ctx.auth.createSession(request.headers["user-agent"]);
  reply.setCookie(SESSION_COOKIE, token, cookieOptions(request, expiresAt));
  return { setupRequired: false, authenticated: true, username };
}

/** onRequest hook for routes that need a signed-in admin. */
export function requireSession(ctx: AppContext) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE];
    const session = ctx.auth.resolveSession(token, { renew: true });
    if (!session || !token) throw new ApiError("UNAUTHORIZED", "Sign in to continue");
    request.username = session.username;
    if (session.renewed)
      reply.setCookie(SESSION_COOKIE, token, cookieOptions(request, session.expiresAt));
  };
}

export async function registerAuthRoutes(api: FastifyInstance, ctx: AppContext): Promise<void> {
  api.get("/auth/status", async (request): Promise<AuthStatus> => {
    const session = ctx.auth.resolveSession(request.cookies[SESSION_COOKIE]);
    return {
      setupRequired: ctx.auth.isSetupRequired(),
      authenticated: session !== null,
      username: session?.username ?? null,
    };
  });

  api.post("/auth/setup", async (request, reply) => {
    const body = parseWith(SetupRequestSchema, request.body);
    if (!(await ctx.auth.createAdmin(body.username, body.password))) {
      throw new ApiError("CONFLICT", "An admin account already exists. Sign in instead.");
    }
    return startSession(ctx, request, reply, body.username);
  });

  api.post("/auth/login", async (request, reply) => {
    const body = parseWith(LoginRequestSchema, request.body);
    if (ctx.loginLimiter.isLimited(request.ip)) {
      throw new ApiError("RATE_LIMITED", "Too many failed sign-ins. Try again in 15 minutes.");
    }
    if (!(await ctx.auth.verifyLogin(body.username, body.password))) {
      ctx.loginLimiter.recordFailure(request.ip);
      throw new ApiError("UNAUTHORIZED", "Wrong username or password");
    }
    ctx.loginLimiter.reset(request.ip);
    return startSession(ctx, request, reply, body.username);
  });

  api.post("/auth/logout", async (request, reply): Promise<AuthStatus> => {
    ctx.auth.deleteSession(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { setupRequired: ctx.auth.isSetupRequired(), authenticated: false, username: null };
  });
}
