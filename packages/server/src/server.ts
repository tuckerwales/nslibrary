import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { LogFn } from "./api/context";
import { buildApp } from "./app";
import { AuthService, LoginRateLimiter } from "./auth/auth-service";
import type { ServerConfig } from "./config";
import { type Db, openDatabase } from "./db/client";
import { DiscoveryServer, discoveryReply } from "./device/discovery";
import { DeviceApiService } from "./device/service";
import { EventBus } from "./events";
import { KeyStore } from "./keys/store";
import { LibraryRepository } from "./library/repository";
import { LibraryScanner } from "./library/scanner";
import { applyDemoSeed } from "./seed/bootstrap";
import { TitledbService } from "./titledb/service";

const MISSING_FILE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface NslibServer {
  app: FastifyInstance;
  db: Db;
  sqlite: Database.Database;
  repo: LibraryRepository;
  scanner: LibraryScanner;
  events: EventBus;
  auth: AuthService;
  devices: DeviceApiService;
  discovery: DiscoveryServer | null;
  /** Starts watchers, the startup scan, and periodic maintenance. Call after listen(). */
  start(): Promise<void>;
  close(): Promise<void>;
}

export async function createServer(
  config: ServerConfig,
  options: { now?: () => number } = {},
): Promise<NslibServer> {
  const now = options.now ?? Date.now;
  const iconDir = join(config.dataDir, "cache", "icons");
  await mkdir(iconDir, { recursive: true });

  const { db, sqlite } = openDatabase(config.databaseFile ?? join(config.dataDir, "db.sqlite"));
  let app: FastifyInstance | undefined;
  const log: LogFn = config.log ?? ((message, err) => app?.log.warn({ err }, message));

  const repo = new LibraryRepository(db, now);
  const events = new EventBus();
  const keys = new KeyStore(config.dataDir);
  await keys.load();
  const titledb = new TitledbService(db, now);
  const scanner = new LibraryScanner(repo, events, {
    iconDir,
    forcePolling: config.forcePolling,
    pollIntervalMs: config.pollIntervalMs,
    stabilityThresholdMs: config.stabilityThresholdMs,
    keys: () => keys.get(),
    log,
  });
  const auth = new AuthService(db, now);
  const devices = new DeviceApiService({
    db,
    events,
    now,
    serverName: config.serverName,
    catalogRev: () => repo.catalogRev(),
  });
  const discovery =
    config.discoveryPort === null
      ? null
      : new DiscoveryServer({
          port: config.discoveryPort,
          reply: () => discoveryReply(devices.serverId, devices.serverName, config.port),
          log,
        });
  app = await buildApp({
    config,
    db,
    repo,
    scanner,
    events,
    auth,
    loginLimiter: new LoginRateLimiter(),
    keys,
    titledb,
    devices,
    iconDir,
    log,
  });
  const fastify = app;

  let maintenance: NodeJS.Timeout | null = null;
  const runMaintenance = () => {
    repo.purgeMissing(MISSING_FILE_RETENTION_MS);
    auth.purgeExpiredSessions();
    devices.purgeExpiredPairingCodes();
  };

  return {
    app: fastify,
    db,
    sqlite,
    repo,
    scanner,
    events,
    auth,
    devices,
    discovery,
    async start() {
      runMaintenance();
      maintenance = setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);
      maintenance.unref();
      if (discovery) {
        await discovery.start().catch((err) => log("UDP discovery failed to bind", err));
      }
      await applyDemoSeed({ config, repo, scanner, keys, log });
      for (const root of repo.listRoots()) await scanner.watchRoot(root);
      scanner.scanAll().catch((err) => log("Startup scan failed", err));
    },
    async close() {
      if (maintenance) clearInterval(maintenance);
      await discovery?.close();
      devices.close();
      await fastify.close();
      await scanner.close();
      sqlite.close();
    },
  };
}
