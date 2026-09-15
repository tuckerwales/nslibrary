import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, openDatabase } from "../src/db/client";
import { EventBus } from "../src/events";
import { listApplications } from "../src/library/queries";
import { LibraryRepository } from "../src/library/repository";
import { LibraryScanner } from "../src/library/scanner";
import { fakeNsp, makeTempDir, removeDir } from "./helpers";

const BASE_ID = "0100ABCDEF012000";
const BASE_FILE = `Example Game [${BASE_ID}][v0].nsp`;
const MOVED_FILE = `Moved Game [${BASE_ID}][v0].nsp`;

describe("LibraryScanner watching", () => {
  let dir: string;
  let library: string;
  let sqlite: Database.Database;
  let db: Db;
  let repo: LibraryRepository;
  let scanner: LibraryScanner;

  beforeEach(async () => {
    dir = await makeTempDir();
    library = join(dir, "library");
    await mkdir(library);
    await mkdir(join(dir, "icons"));
    ({ db, sqlite } = openDatabase(":memory:"));
    repo = new LibraryRepository(db);
    scanner = new LibraryScanner(repo, new EventBus(), {
      iconDir: join(dir, "icons"),
      forcePolling: true,
      pollIntervalMs: 50,
      stabilityThresholdMs: 100,
      watchBatchMs: 100,
      log: () => {},
    });
  });

  afterEach(async () => {
    await scanner.close();
    sqlite.close();
    await removeDir(dir);
  });

  async function eventually(assertion: () => void) {
    await vi.waitFor(
      async () => {
        await scanner.idle();
        assertion();
      },
      { timeout: 8000, interval: 100 },
    );
  }

  it("picks up added, renamed, and removed files", async () => {
    const root = repo.createRoot({ path: library });
    await scanner.scanRoot(root.id);
    await scanner.watchRoot(root);

    await writeFile(join(library, BASE_FILE), fakeNsp({ tickets: [BASE_ID] }));
    await eventually(() => expect(listApplications(db)).toMatchObject([{ name: "Example Game" }]));
    const id = repo.listRootFiles(root.id)[0]?.id;

    await rename(join(library, BASE_FILE), join(library, MOVED_FILE));
    await eventually(() => {
      expect(repo.listRootFiles(root.id)).toMatchObject([
        { id, relPath: MOVED_FILE, missingSince: null },
      ]);
      expect(listApplications(db)).toMatchObject([{ name: "Moved Game" }]);
    });

    await rm(join(library, MOVED_FILE));
    await eventually(() => expect(listApplications(db)).toEqual([]));
  });

  it("stops reacting after the folder is unwatched", async () => {
    const root = repo.createRoot({ path: library });
    await scanner.watchRoot(root);
    await scanner.unwatchRoot(root.id);
    await writeFile(join(library, BASE_FILE), fakeNsp({ tickets: [BASE_ID] }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    await scanner.idle();
    expect(repo.listRootFiles(root.id)).toEqual([]);
  });
});
