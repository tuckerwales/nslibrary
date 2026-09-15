#!/usr/bin/env node
/** Download Electron's platform binary if pnpm skipped install.js (no path.txt). */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
let pkgDir;
try {
  pkgDir = dirname(require.resolve("electron/package.json"));
} catch {
  console.error("The electron package is not installed. From the repo root run: pnpm install");
  process.exit(1);
}

function installed() {
  try {
    const rel = readFileSync(join(pkgDir, "path.txt"), "utf8").trim();
    return existsSync(join(pkgDir, "dist", rel));
  } catch {
    return false;
  }
}

if (installed()) process.exit(0);

console.log("Downloading the Electron binary (first run only)…");
const env = { ...process.env };
delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
const result = spawnSync(process.execPath, [join(pkgDir, "install.js")], {
  cwd: pkgDir,
  stdio: "inherit",
  env,
});
if (result.status !== 0 || !installed()) {
  console.error(
    "Electron failed to download. Check the network, then from the repo root run:\n  pnpm rebuild electron",
  );
  process.exit(result.status || 1);
}
