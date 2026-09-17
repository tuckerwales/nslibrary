import type { AuthService, LoginRateLimiter } from "../auth/auth-service";
import type { ServerConfig } from "../config";
import type { Db } from "../db/client";
import type { DeviceRow } from "../db/schema";
import type { DeviceApiService } from "../device/service";
import type { EventBus } from "../events";
import type { KeyStore } from "../keys/store";
import type { LibraryRepository } from "../library/repository";
import type { LibraryScanner } from "../library/scanner";
import type { VerifyService } from "../library/verify-service";
import type { TitledbService } from "../titledb/service";

export type LogFn = (message: string, err?: unknown) => void;

export interface AppContext {
  config: ServerConfig;
  db: Db;
  repo: LibraryRepository;
  scanner: LibraryScanner;
  events: EventBus;
  auth: AuthService;
  loginLimiter: LoginRateLimiter;
  keys: KeyStore;
  titledb: TitledbService;
  devices: DeviceApiService;
  verify: VerifyService;
  iconDir: string;
  log: LogFn;
}

declare module "fastify" {
  interface FastifyRequest {
    username: string | null;
    device: DeviceRow | null;
  }
}
