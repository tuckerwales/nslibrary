import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { DEVICE_API_PROTOCOL_VERSION } from "@nslib/shared";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { LogFn } from "./api/context";
import { buildApp } from "./app";
import { AuthService, LoginRateLimiter } from "./auth/auth-service";
import { DEFAULT_RESCAN_INTERVAL_MIN, type ServerConfig } from "./config";
import { type Db, openDatabase } from "./db/client";
import { DiscoveryServer, discoveryReply } from "./device/discovery";
import { localAddresses, MdnsResponder } from "./device/mdns";
import { DeviceApiService, STALE_JOB_MS } from "./device/service";
import { EventBus } from "./events";
import { KeyStore } from "./keys/store";
import { LibraryRepository } from "./library/repository";
import { LibraryScanner } from "./library/scanner";
import { VerifyService } from "./library/verify-service";
import { SaveService } from "./saves/service";
import { applyDemoSeed, attachLibraryMounts } from "./seed/bootstrap";
import { TitledbService } from "./titledb/service";

const MISSING_FILE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Interrupted jobs are kept, since they can still be resumed. */
const JOB_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STALE_JOB_SWEEP_INTERVAL_MS = 60 * 1000;
const TITLEDB_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const TITLEDB_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface NslibServer {
  app: FastifyInstance;
  db: Db;
  sqlite: Database.Database;
  repo: LibraryRepository;
  scanner: LibraryScanner;
  events: EventBus;
  auth: AuthService;
  devices: DeviceApiService;
  verify: VerifyService;
  saves: SaveService;
  discovery: DiscoveryServer | null;
  mdns: MdnsResponder | null;
  /** Starts watchers, the startup scan, USB host, and periodic maintenance. Call after listen(). */
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
  await keys.load({ allowDemo: config.seed });
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
  const verify = new VerifyService(repo, events, now);
  const devices = new DeviceApiService({
    db,
    events,
    now,
    serverName: config.serverName,
    catalogRev: () => repo.catalogRev(),
    nroPath: config.nroPath,
    tls: Boolean(config.tlsKey && config.tlsCert),
    titledbEnabled: () => titledb.enabled(),
  });
  const saves = new SaveService({
    db,
    events,
    now,
    dataDir: config.dataDir,
    keep: () => devices.saveBackupsKeep(),
    maxBytes: config.saveMaxBytes,
  });
  await saves.init();
  const discovery =
    config.discoveryPort === null
      ? null
      : new DiscoveryServer({
          port: config.discoveryPort,
          reply: () =>
            discoveryReply(devices.serverId, devices.serverName, config.port, devices.tls),
          log,
        });
  // Advertised alongside UDP discovery, and turned off with it.
  const mdns =
    config.discoveryPort === null
      ? null
      : new MdnsResponder({
          service: () => ({
            instance: devices.serverName,
            host: hostname().split(".")[0] || "nslibrary",
            port: config.port,
            txt: {
              id: devices.serverId,
              proto: String(DEVICE_API_PROTOCOL_VERSION),
              tls: devices.tls ? "1" : "0",
            },
            addresses: localAddresses(),
          }),
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
    verify,
    saves,
    iconDir,
    log,
  });
  const fastify = app;
  const iconCacheDir = iconDir;

  let maintenance: NodeJS.Timeout | null = null;
  let staleJobSweep: NodeJS.Timeout | null = null;
  let titledbCheck: NodeJS.Timeout | null = null;
  const refreshTitledb = () =>
    titledb
      .refreshIfStale(TITLEDB_MAX_AGE_MS)
      .then((refreshed) => {
        if (!refreshed) return;
        repo.bumpCatalogRev();
        events.publish({ type: "library.changed", rev: repo.catalogRev() });
      })
      .catch((err) => log("Scheduled titledb refresh failed", err));
  let rescan: NodeJS.Timeout | null = null;
  const rescanIntervalMs =
    config.rescanIntervalMs === undefined
      ? DEFAULT_RESCAN_INTERVAL_MIN * 60_000
      : config.rescanIntervalMs;
  // Paused scanning stops watchers; the timer honours it too.
  const periodicRescan = async () => {
    if (!scanner.paused) await scanner.scanAll();
  };
  let usbHost: { stop(): Promise<void> } | null = null;
  const runMaintenance = () => {
    repo.purgeMissing(MISSING_FILE_RETENTION_MS);
    auth.purgeExpiredSessions();
    devices.purgeExpiredPairingCodes();
    devices.purgeFinishedJobs(JOB_HISTORY_RETENTION_MS);
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
    verify,
    saves,
    discovery,
    mdns,
    async start() {
      runMaintenance();
      maintenance = setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);
      maintenance.unref();
      staleJobSweep = setInterval(
        () => devices.interruptStaleJobs(STALE_JOB_MS),
        STALE_JOB_SWEEP_INTERVAL_MS,
      );
      staleJobSweep.unref();
      void refreshTitledb();
      titledbCheck = setInterval(() => void refreshTitledb(), TITLEDB_CHECK_INTERVAL_MS);
      titledbCheck.unref();
      if (discovery) {
        await discovery.start().catch((err) => log("UDP discovery failed to bind", err));
      }
      if (mdns) {
        await mdns.start().catch((err) => log("mDNS advertising unavailable", err));
      }
      await applyDemoSeed({ config, repo, scanner, keys, log });
      await attachLibraryMounts({ config, repo, scanner, log });
      for (const root of repo.listRoots()) await scanner.watchRoot(root);
      scanner.scanAll().catch((err) => log("Startup scan failed", err));
      if (rescanIntervalMs) {
        rescan = setInterval(
          () => void periodicRescan().catch((err) => log("Periodic rescan failed", err)),
          rescanIntervalMs,
        );
        rescan.unref();
      }
      if (config.usb) {
        try {
          const { startUsbHost } = await import("@nslib/usb-host/host");
          const { DeviceUsbHandler } = await import("./usb/handler");
          usbHost = await startUsbHost({
            createHandler: () => new DeviceUsbHandler(devices, iconCacheDir, saves),
            log,
          });
          log("USB host listening for a Switch (057E:3000)");
        } catch (err) {
          log("USB host failed to start", err);
        }
      }
    },
    async close() {
      if (maintenance) clearInterval(maintenance);
      if (staleJobSweep) clearInterval(staleJobSweep);
      if (titledbCheck) clearInterval(titledbCheck);
      if (rescan) clearInterval(rescan);
      await usbHost?.stop();
      usbHost = null;
      await discovery?.close();
      await mdns?.close();
      devices.close();
      verify.close();
      await fastify.close();
      await scanner.close();
      sqlite.close();
    },
  };
}
