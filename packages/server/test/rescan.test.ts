import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { createServer, type NslibServer } from "../src/server";
import { fakeNsp, makeTempDir, removeDir, testConfig } from "./helpers";

const BASE_ID = "0100ABCDEF012000";

describe("periodic rescan", () => {
  let dir: string;
  let server: NslibServer;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await server?.close();
    await removeDir(dir);
  });

  it("reads NSLIB_RESCAN_INTERVAL_MIN, with 0 turning it off", () => {
    const base = { NSLIB_DATA_DIR: join(dir, "data") };
    expect(loadConfig(base).rescanIntervalMs).toBe(6 * 60 * 60_000);
    expect(loadConfig({ ...base, NSLIB_RESCAN_INTERVAL_MIN: "15" }).rescanIntervalMs).toBe(
      15 * 60_000,
    );
    expect(loadConfig({ ...base, NSLIB_RESCAN_INTERVAL_MIN: "0" }).rescanIntervalMs).toBeNull();
    expect(() => loadConfig({ ...base, NSLIB_RESCAN_INTERVAL_MIN: "soon" })).toThrow(
      /NSLIB_RESCAN_INTERVAL_MIN/,
    );
  });

  it("rescans on a timer", async () => {
    const library = join(dir, "library");
    await mkdir(library);
    server = await createServer(testConfig(join(dir, "data"), { rescanIntervalMs: 200 }));
    const root = server.repo.createRoot({ path: library });
    await server.start();
    // Without a watcher, only the timer can find this file.
    await server.scanner.unwatchRoot(root.id);
    await writeFile(join(library, `Game [${BASE_ID}][v0].nsp`), fakeNsp());
    await vi.waitFor(() => expect(server.repo.listRootFiles(root.id)).toHaveLength(1), {
      timeout: 5000,
      interval: 50,
    });
  });
});
