/**
 * Loads and saves `prod.keys`. Key material never leaves this module except as a Keyset
 * handed to parsers; APIs only see key *names*.
 *
 * Synthetic demo keys live in their own file (`demo.keys`) so they never pose as console keys:
 * they are only used while no real `prod.keys` exists and demo seeding is on, and uploading real
 * keys removes them.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Keyset, type KeysetStatus, keysetStatus, parseKeyset } from "@nslib/formats";

export interface KeyStoreStatus extends KeysetStatus {
  /** True when the loaded keys are the synthetic demo set, not keys from a console. */
  demo: boolean;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Writes with 0600 from the start and swaps the file in, so it is never partial or readable. */
async function writePrivate(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, contents, { encoding: "utf8", mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

export class KeyStore {
  readonly path: string;
  readonly demoPath: string;
  #keys: Keyset | null = null;
  #demo = false;

  constructor(dataDir: string) {
    this.path = join(dataDir, "keys", "prod.keys");
    this.demoPath = join(dataDir, "keys", "demo.keys");
  }

  /** Loads `prod.keys`, or the demo keys when `allowDemo` is set and no real keys exist. */
  async load(options: { allowDemo?: boolean } = {}): Promise<void> {
    this.#keys = null;
    this.#demo = false;
    const real = await readIfExists(this.path);
    if (real !== null) {
      this.#keys = parseKeyset(real).keys;
      return;
    }
    if (!options.allowDemo) return;
    const demo = await readIfExists(this.demoPath);
    if (demo !== null) {
      this.#keys = parseKeyset(demo).keys;
      this.#demo = true;
    }
  }

  get(): Keyset | null {
    return this.#keys && this.#keys.size > 0 ? this.#keys : null;
  }

  /** True when real console keys are loaded (demo keys don't count). */
  hasConsoleKeys(): boolean {
    return this.get() !== null && !this.#demo;
  }

  status(): KeyStoreStatus {
    return { ...keysetStatus(this.get()), demo: this.get() !== null && this.#demo };
  }

  /** Saves keys uploaded from a console, replacing any demo keys. */
  async save(contents: string): Promise<KeyStoreStatus> {
    const parsed = parseKeyset(contents);
    if (parsed.keys.size === 0) {
      throw new EmptyKeysetError();
    }
    await writePrivate(this.path, contents);
    await rm(this.demoPath, { force: true });
    this.#keys = parsed.keys;
    this.#demo = false;
    return this.status();
  }

  /** Stores and loads synthetic demo keys. Ignored when real keys are present. */
  async saveDemo(contents: string): Promise<void> {
    if (this.hasConsoleKeys()) return;
    const parsed = parseKeyset(contents);
    if (parsed.keys.size === 0) throw new EmptyKeysetError();
    await writePrivate(this.demoPath, contents);
    this.#keys = parsed.keys;
    this.#demo = true;
  }

  /**
   * Earlier versions saved the demo keys as `prod.keys`. If `prod.keys` is byte-for-byte the demo
   * set, move it to `demo.keys` so it stops posing as console keys, then reload. Returns true if
   * it moved.
   */
  async demoteIfDemo(
    demoContents: string,
    options: { allowDemo?: boolean } = {},
  ): Promise<boolean> {
    const real = await readIfExists(this.path);
    if (real === null || real.trim() !== demoContents.trim()) return false;
    await writePrivate(this.demoPath, real);
    await rm(this.path, { force: true });
    await this.load(options);
    return true;
  }
}

export class EmptyKeysetError extends Error {
  constructor() {
    super("No keys found in that file. Check that it looks like prod.keys from Lockpick.");
    this.name = "EmptyKeysetError";
  }
}
