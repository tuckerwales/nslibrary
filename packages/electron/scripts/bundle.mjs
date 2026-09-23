#!/usr/bin/env node
/**
 * Stages the desktop app in `build/` for electron-builder: the main process bundled to plain
 * JavaScript (no tsx at runtime), the preload script, the database migrations, the built web UI,
 * and the forwarder icon. Only the native modules (better-sqlite3, usb) stay in node_modules.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const repo = join(pkg, "../..");
const out = join(pkg, "build");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [join(pkg, "src/main.ts")],
  outfile: join(out, "main.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["electron", "better-sqlite3", "usb", "fsevents"],
  // Bundled CommonJS dependencies still call require().
  banner: {
    js: "import{createRequire as __nslibCreateRequire}from'node:module';const require=__nslibCreateRequire(import.meta.url);",
  },
  logLevel: "warning",
});

const webDist = join(repo, "packages/web/dist");
await cp(join(pkg, "src/preload.cjs"), join(out, "preload.cjs"));
await cp(join(repo, "packages/server/drizzle"), join(out, "drizzle"), { recursive: true });
await cp(webDist, join(out, "web"), { recursive: true }).catch(() => {
  throw new Error(`No web UI at ${webDist}. Run pnpm --filter @nslib/web build first.`);
});
await mkdir(join(out, "assets"));
await cp(join(repo, "switch/resources/img/icon.jpg"), join(out, "assets/icon.jpg"));

console.log(`Bundled the desktop app into ${out}`);
