import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SERVER_PORT } from "@nslib/shared";
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
  logLevel: string | false;
  trustProxy: boolean;
  /** Overrides the default logger for background work (scans, watchers). */
  log?: LogFn;
}

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const webDir = env.NSLIB_WEB_DIR
    ? resolve(env.NSLIB_WEB_DIR)
    : (WEB_DIR_CANDIDATES.find((dir) => existsSync(join(dir, "index.html"))) ?? null);
  return {
    dataDir: resolve(env.NSLIB_DATA_DIR ?? "data"),
    host: env.NSLIB_HOST ?? "0.0.0.0",
    port: positiveInt("NSLIB_PORT", env.NSLIB_PORT ?? env.PORT, DEFAULT_SERVER_PORT),
    webDir,
    forcePolling: flag(env.NSLIB_POLLING),
    pollIntervalMs: positiveInt("NSLIB_POLL_INTERVAL_MS", env.NSLIB_POLL_INTERVAL_MS, 2000),
    stabilityThresholdMs: positiveInt("NSLIB_STABILITY_MS", env.NSLIB_STABILITY_MS, 5000),
    logLevel: env.NSLIB_LOG_LEVEL ?? "info",
    trustProxy: flag(env.NSLIB_TRUST_PROXY),
  };
}
