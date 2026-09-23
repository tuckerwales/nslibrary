import { createHash, timingSafeEqual } from "node:crypto";
import {
  type AuthStatus,
  ChangePasswordRequestSchema,
  LoginRequestSchema,
  SetupRequestSchema,
} from "@nslib/shared";
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

function setupTokenMatches(expected: string, given: string | undefined): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return given !== undefined && timingSafeEqual(digest(expected), digest(given.trim()));
}

/** The socket's own address, not a forwarded one: X-Forwarded-For is trivial to fake. */
function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return v4 === "::1" || v4.startsWith("127.");
}

function signedOut(ctx: AppContext): AuthStatus {
  const setupRequired = ctx.auth.isSetupRequired();
  return {
    setupRequired,
    setupTokenRequired: setupRequired && ctx.config.setupToken !== null,
    authenticated: false,
    username: null,
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
  return { setupRequired: false, setupTokenRequired: false, authenticated: true, username };
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
    if (!session) return signedOut(ctx);
    return {
      setupRequired: false,
      setupTokenRequired: false,
      authenticated: true,
      username: session.username,
    };
  });

  api.post("/auth/setup", async (request, reply) => {
    const body = parseWith(SetupRequestSchema, request.body);
    const { setupToken } = ctx.config;
    // Without a token (the desktop app) only someone at this machine may create the account, even
    // when LAN access is on.
    if (
      setupToken === null &&
      ctx.auth.isSetupRequired() &&
      !isLoopback(request.socket.remoteAddress)
    ) {
      throw new ApiError("FORBIDDEN", "Create the admin account on the computer running NSLibrary");
    }
    if (setupToken !== null && ctx.auth.isSetupRequired()) {
      if (ctx.loginLimiter.isLimited(request.ip)) {
        throw new ApiError("RATE_LIMITED", "Too many wrong setup tokens. Try again in 15 minutes.");
      }
      if (!setupTokenMatches(setupToken, body.setupToken)) {
        ctx.loginLimiter.recordFailure(request.ip);
        throw new ApiError(
          "FORBIDDEN",
          body.setupToken ? "That setup token is wrong" : "Enter the setup token from the server",
        );
      }
    }
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

  api.post(
    "/auth/password",
    { onRequest: requireSession(ctx) },
    async (request, reply): Promise<void> => {
      const body = parseWith(ChangePasswordRequestSchema, request.body);
      if (ctx.loginLimiter.isLimited(request.ip)) {
        throw new ApiError("RATE_LIMITED", "Too many wrong passwords. Try again in 15 minutes.");
      }
      const token = request.cookies[SESSION_COOKIE] ?? "";
      if (!(await ctx.auth.changePassword(body.currentPassword, body.newPassword, token))) {
        ctx.loginLimiter.recordFailure(request.ip);
        throw new ApiError("FORBIDDEN", "Your current password is wrong");
      }
      ctx.loginLimiter.reset(request.ip);
      return reply.status(204).send();
    },
  );

  api.post("/auth/logout", async (request, reply): Promise<AuthStatus> => {
    ctx.auth.deleteSession(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return signedOut(ctx);
  });
}
