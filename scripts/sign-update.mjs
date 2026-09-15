#!/usr/bin/env node
import { createHash } from "node:crypto";
/**
 * Sign a Switch .nro for GitHub Releases.
 *
 *   NSLIB_UPDATE_SK=<64 hex chars> node scripts/sign-update.mjs switch/build/nslibrary.nro --out dist
 *
 * Writes nslibrary.nro (copy), update.json, and update.json.sig into --out.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { canonicalUpdateJson, parseHexKey, signBytes } from "./update-keys.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const nroPath = process.argv[2];
if (!nroPath || nroPath.startsWith("-")) {
  console.error(
    "usage: node scripts/sign-update.mjs <nslibrary.nro> --out <dir> [--version 0.1.0]",
  );
  process.exit(1);
}

const outDir = arg("--out", "dist");
const version = arg("--version", process.env.NSLIB_APP_VERSION ?? "0.1.0");
const skHex = process.env.NSLIB_UPDATE_SK;
if (!skHex) {
  console.error("NSLIB_UPDATE_SK is not set (32-byte Ed25519 seed as hex)");
  process.exit(1);
}

const seed = parseHexKey(skHex, 32);
const nro = await readFile(nroPath);
const sha256 = createHash("sha256").update(nro).digest("hex");
const json = canonicalUpdateJson(version, sha256, nro.byteLength);
const sig = signBytes(seed, Buffer.from(json, "utf8"));

await mkdir(outDir, { recursive: true });
const nroOut = join(outDir, "nslibrary.nro");
if (basename(nroPath) !== "nslibrary.nro" || nroPath !== nroOut) {
  await copyFile(nroPath, nroOut);
}
await writeFile(join(outDir, "update.json"), json);
await writeFile(join(outDir, "update.json.sig"), sig);
process.stdout.write(`signed ${nro.byteLength} byte nro  sha256=${sha256}  version=${version}\n`);
