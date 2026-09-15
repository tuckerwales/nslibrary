import { ERROR_HTTP_STATUS, type ErrorCode } from "@nslib/shared";
import type { FastifyError, FastifyInstance } from "fastify";
import type { z } from "zod";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = ERROR_HTTP_STATUS[code];
  }
}

export function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.join(".");
  throw new ApiError(
    "BAD_REQUEST",
    issue ? (field ? `${field}: ${issue.message}` : issue.message) : "Invalid request",
  );
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | ApiError, request, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send({ error: { code: err.code, msg: err.message } });
    }
    const status = err.statusCode ?? 500;
    if (status < 500) {
      const code: ErrorCode =
        status === 404 ? "NOT_FOUND" : status === 401 ? "UNAUTHORIZED" : "BAD_REQUEST";
      return reply.status(status).send({ error: { code, msg: err.message } });
    }
    request.log.error(err);
    return reply
      .status(500)
      .send({ error: { code: "INTERNAL", msg: "Something went wrong on the server" } });
  });
}
