/**
 * On first start, optionally load demo keys and attach the demo library folder so the UI
 * isn't empty. Never overwrites an existing prod.keys or an existing folder list.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import type { LogFn } from "../api/context";
import type { ServerConfig } from "../config";
import type { KeyStore } from "../keys/store";
import type { LibraryRepository } from "../library/repository";
import type { LibraryScanner } from "../library/scanner";

export async function applyDemoSeed(options: {
  config: ServerConfig;
  repo: LibraryRepository;
  scanner: LibraryScanner;
  keys: KeyStore;
  log: LogFn;
}): Promise<void> {
  const { config, repo, scanner, keys, log } = options;
  if (!config.seed) return;

  if (!keys.get() && config.seedKeysPath && existsSync(config.seedKeysPath)) {
    try {
      await keys.save(await readFile(config.seedKeysPath, "utf8"));
      log("Loaded demo prod.keys (synthetic; not from a console)");
    } catch (err) {
      log("Couldn't load demo keys", err);
    }
  }

  if (repo.listRoots().length > 0) return;
  if (!config.seedLibraryDir) return;
  try {
    const resolved = await realpath(config.seedLibraryDir);
    if (!(await stat(resolved)).isDirectory()) {
      log(`NSLIB_SEED is on but ${config.seedLibraryDir} is not a folder`);
      return;
    }
    const root = repo.createRoot({
      path: resolved,
      label: "Demo library",
      usePolling: true,
    });
    await scanner.watchRoot(root);
    log(`Attached demo library at ${resolved}`);
  } catch (err) {
    log(`NSLIB_SEED is on but couldn't open ${config.seedLibraryDir}`, err);
  }
}

/** Attach each immediate subdirectory of `libraryScanDir` that is not already a root. */
export async function attachLibraryMounts(options: {
  config: ServerConfig;
  repo: LibraryRepository;
  scanner: LibraryScanner;
  log: LogFn;
}): Promise<void> {
  const { config, repo, scanner, log } = options;
  if (!config.libraryScanDir) return;
  let entries: string[];
  try {
    entries = await readdir(config.libraryScanDir);
  } catch (err) {
    log(`Couldn't list library mounts in ${config.libraryScanDir}`, err);
    return;
  }
  const existing = new Set(repo.listRoots().map((root) => root.path));
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (name === "demo" && !config.seed) continue;
    const candidate = `${config.libraryScanDir.replace(/\/$/, "")}/${name}`;
    try {
      const resolved = await realpath(candidate);
      if (!(await stat(resolved)).isDirectory()) continue;
      if (existing.has(resolved)) continue;
      const root = repo.createRoot({
        path: resolved,
        label: name === "demo" ? "Demo library" : name,
        usePolling: config.forcePolling,
      });
      existing.add(resolved);
      await scanner.watchRoot(root);
      log(`Attached library folder ${resolved}`);
    } catch (err) {
      log(`Couldn't attach ${candidate}`, err);
    }
  }
}
