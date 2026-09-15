import type { AuthService, LoginRateLimiter } from "../auth/auth-service";
import type { ServerConfig } from "../config";
import type { Db } from "../db/client";
import type { EventBus } from "../events";
import type { LibraryRepository } from "../library/repository";
import type { LibraryScanner } from "../library/scanner";

export type LogFn = (message: string, err?: unknown) => void;

export interface AppContext {
  config: ServerConfig;
  db: Db;
  repo: LibraryRepository;
  scanner: LibraryScanner;
  events: EventBus;
  auth: AuthService;
  loginLimiter: LoginRateLimiter;
  iconDir: string;
  log: LogFn;
}

declare module "fastify" {
  interface FastifyRequest {
    username: string | null;
  }
}
