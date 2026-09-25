import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SERVER_PORT, DISCOVERY_PORT } from "@nslib/shared";
import type { LogFn } from "./api/context";

export interface ServerConfig {
  dataDir: string;
  /** Defaults to `<dataDir>/db.sqlite`. */
  databaseFile?: string;
  host: string;
  port: number;
  /** Directory containing the built web UI, or null to serve only the API. */
  webDir: string | null;
  /** Poll every library folder instead of relying on filesystem events. */
  forcePolling: boolean;
  pollIntervalMs: number;
  stabilityThresholdMs: number;
  /**
   * Every enabled folder is rescanned this often, catching changes a watcher missed (network
   * mounts, a share that was offline). Null or 0 turns it off. Defaults to 6 hours.
   */
  rescanIntervalMs?: number | null;
  logLevel: string | false;
  trustProxy: boolean;
  /** Overrides the default logger for background work (scans, watchers). */
  log?: LogFn;
  /** Attach the demo library and keys on first start when no folders exist yet. */
  seed: boolean;
  seedLibraryDir: string | null;
  seedKeysPath: string | null;
  /**
   * When set, first-run setup must supply this token, so a server reachable from the internet
   * can't be claimed by whoever opens it first. `loadConfig` always sets one; embedders that own
   * the machine anyway (Electron) pass null, and setup is then only accepted from loopback.
   */
  setupToken: string | null;
  /** True when `setupToken` was generated because NSLIB_SETUP_TOKEN was unset. Logged on first run. */
  setupTokenGenerated?: boolean;
  /** Advertised in hello and UDP discovery. */
  serverName: string;
  /** UDP port for `NSLIB?1`. Null disables discovery. 0 binds an ephemeral port. */
  discoveryPort: number | null;
  /** Attach to a USB-connected Switch (node-usb). */
  usb: boolean;
  /**
   * Immediate subfolders of this directory are attached as library roots (Docker
   * `/library/games`, `/library/updates`, …). Null disables the scan.
   */
  libraryScanDir: string | null;
  /** PEM private key for optional HTTPS. Both tlsKey and tlsCert must be set. */
  tlsKey: string | null;
  tlsCert: string | null;
  /** Switch `.nro` the device API serves at GET /update. */
  nroPath: string | null;
  /** Compiled forwarder `main` (exefs). Null uses a stub so the NSP still packs. */
  forwarderMainPath: string | null;
  /** Largest save archive a console may upload. Defaults to 1 GiB. */
  saveMaxBytes?: number;
}

export const DEFAULT_RESCAN_INTERVAL_MIN = 6 * 60;

const WEB_DIR_CANDIDATES = [
  fileURLToPath(new URL("../public", import.meta.url)),
  fileURLToPath(new URL("../../web/dist", import.meta.url)),
];

function flag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  return n;
}

/** `NSLIB_RESCAN_INTERVAL_MIN`: minutes between full rescans, `0` for none. */
function rescanIntervalMs(value: string | undefined): number | null {
  if (value === "0") return null;
  return positiveInt("NSLIB_RESCAN_INTERVAL_MIN", value, DEFAULT_RESCAN_INTERVAL_MIN) * 60_000;
}

function discoveryPort(env: NodeJS.ProcessEnv): number | null {
  if (env.NSLIB_DISCOVERY === "0" || env.NSLIB_DISCOVERY?.toLowerCase() === "false") return null;
  const value = env.NSLIB_DISCOVERY_PORT;
  if (value === "0") return 0;
  return positiveInt("NSLIB_DISCOVERY_PORT", value, DISCOVERY_PORT);
}

/**
 * Groups make the token easy to read off a log and type into the browser. The alphabet is exactly
 * 32 characters (no I, O, 0 or 1), so `% 32` over a random byte is unbiased and 20 of them carry
 * 100 bits. The setup route also rate limits wrong guesses per address.
 */
function generateSetupToken(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(20);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join("")).join("-");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const webDir = env.NSLIB_WEB_DIR
    ? resolve(env.NSLIB_WEB_DIR)
    : (WEB_DIR_CANDIDATES.find((dir) => existsSync(join(dir, "index.html"))) ?? null);
  const dataDir = resolve(env.NSLIB_DATA_DIR ?? "data");
  const defaultNro = join(dataDir, "update", "nslibrary.nro");
  const defaultForwarder = join(dataDir, "forwarder", "main");
  const configuredSetupToken = env.NSLIB_SETUP_TOKEN?.trim() || null;
  return {
    dataDir,
    host: env.NSLIB_HOST ?? "0.0.0.0",
    port: positiveInt("NSLIB_PORT", env.NSLIB_PORT ?? env.PORT, DEFAULT_SERVER_PORT),
    webDir,
    forcePolling: flag(env.NSLIB_POLLING),
    pollIntervalMs: positiveInt("NSLIB_POLL_INTERVAL_MS", env.NSLIB_POLL_INTERVAL_MS, 2000),
    stabilityThresholdMs: positiveInt("NSLIB_STABILITY_MS", env.NSLIB_STABILITY_MS, 5000),
    rescanIntervalMs: rescanIntervalMs(env.NSLIB_RESCAN_INTERVAL_MIN),
    logLevel: env.NSLIB_LOG_LEVEL ?? "info",
    trustProxy: flag(env.NSLIB_TRUST_PROXY),
    seed: flag(env.NSLIB_SEED),
    seedLibraryDir: env.NSLIB_SEED_DIR ? resolve(env.NSLIB_SEED_DIR) : null,
    seedKeysPath: env.NSLIB_SEED_KEYS ? resolve(env.NSLIB_SEED_KEYS) : null,
    setupToken: configuredSetupToken ?? generateSetupToken(),
    setupTokenGenerated: configuredSetupToken === null,
    serverName: env.NSLIB_SERVER_NAME?.trim() || "NSLibrary",
    discoveryPort: discoveryPort(env),
    usb: flag(env.NSLIB_USB),
    libraryScanDir: env.NSLIB_LIBRARY_DIR
      ? resolve(env.NSLIB_LIBRARY_DIR)
      : existsSync("/library")
        ? "/library"
        : null,
    tlsKey: env.NSLIB_TLS_KEY ? resolve(env.NSLIB_TLS_KEY) : null,
    tlsCert: env.NSLIB_TLS_CERT ? resolve(env.NSLIB_TLS_CERT) : null,
    nroPath: env.NSLIB_NRO_PATH
      ? resolve(env.NSLIB_NRO_PATH)
      : existsSync(defaultNro)
        ? defaultNro
        : null,
    saveMaxBytes: positiveInt("NSLIB_SAVE_MAX_MB", env.NSLIB_SAVE_MAX_MB, 1024) * 1024 * 1024,
    forwarderMainPath: env.NSLIB_FORWARDER_MAIN
      ? resolve(env.NSLIB_FORWARDER_MAIN)
      : existsSync(defaultForwarder)
        ? defaultForwarder
        : null,
  };
}
