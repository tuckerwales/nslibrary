#!/usr/bin/env node
/**
 * Starts a packaged desktop app and checks that its server and web UI come up, then stops it.
 * Usage: node scripts/smoke.mjs <path to the app's executable>
 * On Linux, run it under `xvfb-run -a` when there's no display.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executable = process.argv[2];
if (!executable) {
  console.error("Usage: node scripts/smoke.mjs <executable>");
  process.exit(2);
}

const base = "http://127.0.0.1:8465";
const profile = mkdtempSync(join(tmpdir(), "nslib-smoke-"));
const app = spawn(executable, ["--no-sandbox", `--user-data-dir=${profile}`], {
  // Its own process group on macOS and Linux, so the whole Electron tree can be stopped.
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
app.stdout.on("data", (chunk) => (output += chunk));
app.stderr.on("data", (chunk) => (output += chunk));
let exited = null;
app.on("exit", (code, signal) => (exited = signal ?? code));

function stop() {
  if (exited !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(app.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-app.pid, "SIGKILL");
    } catch {}
  }
}

function fail(message) {
  stop();
  console.error(`${message}\n--- app output ---\n${output}`);
  process.exit(1);
}

async function get(path) {
  try {
    const response = await fetch(base + path);
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

for (let second = 0; ; second++) {
  if (exited !== null) fail(`The app exited (${exited}) before its server answered`);
  if ((await get("/api/health")) !== null) {
    console.log(`Server answered after ${second} s`);
    break;
  }
  if (second >= 90) fail("The server didn't answer within 90 s");
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

const status = await get("/api/v1/auth/status");
if (!status?.includes('"setupRequired":true')) fail(`Unexpected auth status: ${status}`);
const page = await get("/");
if (!page?.includes("<title>NSLibrary")) fail("The web UI wasn't served");

console.log("Packaged app started, and served the API and web UI");
stop();
process.exit(0);
