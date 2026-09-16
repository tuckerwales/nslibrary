/**
 * Loads and saves `prod.keys`. Key material never leaves this module except as a Keyset
 * handed to parsers; APIs only see key *names*.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Keyset, type KeysetStatus, keysetStatus, parseKeyset } from "@nslib/formats";

export class KeyStore {
  readonly path: string;
  #keys: Keyset | null = null;

  constructor(dataDir: string) {
    this.path = join(dataDir, "keys", "prod.keys");
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, "utf8");
      this.#keys = parseKeyset(text).keys;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.#keys = null;
    }
  }

  get(): Keyset | null {
    return this.#keys && this.#keys.size > 0 ? this.#keys : null;
  }

  status(): KeysetStatus {
    return keysetStatus(this.get());
  }

  async save(contents: string): Promise<KeysetStatus> {
    const parsed = parseKeyset(contents);
    if (parsed.keys.size === 0) {
      throw new EmptyKeysetError();
    }
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, contents, { encoding: "utf8", mode: 0o600 });
    await chmod(this.path, 0o600);
    this.#keys = parsed.keys;
    return this.status();
  }
}

export class EmptyKeysetError extends Error {
  constructor() {
    super("No keys found in that file. Check that it looks like prod.keys from Lockpick.");
    this.name = "EmptyKeysetError";
  }
}
