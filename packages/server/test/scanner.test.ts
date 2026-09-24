import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deterministicBytes } from "@nslib/fixtures";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDatabase } from "../src/db/client";
import { files } from "../src/db/schema";
import { EventBus } from "../src/events";
import { getProblems, listApplications } from "../src/library/queries";
import { LibraryRepository } from "../src/library/repository";
import { LibraryScanner } from "../src/library/scanner";
import { fakeNsp, makeTempDir, removeDir } from "./helpers";

const BASE_ID = "0100ABCDEF012000";
const UPDATE_ID = "0100ABCDEF012800";
const BASE_FILE = `Example Game [${BASE_ID}][v0].nsp`;
const UPDATE_FILE = `Example Game [${UPDATE_ID}][v196608].nsp`;

describe("LibraryScanner", () => {
  let dir: string;
  let library: string;
  let sqlite: Database.Database;
  let db: Db;
  let repo: LibraryRepository;
  let scanner: LibraryScanner;

  beforeEach(async () => {
    dir = await makeTempDir();
    library = join(dir, "library");
    const iconDir = join(dir, "icons");
    await mkdir(library);
    await mkdir(iconDir);
    ({ db, sqlite } = openDatabase(":memory:"));
    repo = new LibraryRepository(db);
    scanner = new LibraryScanner(repo, new EventBus(), { iconDir, log: () => {} });
  });

  afterEach(async () => {
    await scanner.close();
    sqlite.close();
    await removeDir(dir);
  });

  it("adds, updates, removes, and restores files", async () => {
    await writeFile(join(library, BASE_FILE), fakeNsp({ tickets: [BASE_ID] }));
    await mkdir(join(library, "updates"));
    await writeFile(join(library, "updates", UPDATE_FILE), fakeNsp({ seed: "update" }));
    await writeFile(join(library, "notes.txt"), "not a game");
    await writeFile(join(library, ".partial.nsp"), fakeNsp());
    await mkdir(join(library, ".trash"));
    await writeFile(join(library, ".trash", "old.nsp"), fakeNsp());
    const root = repo.createRoot({ path: library });

    expect(await scanner.scanRoot(root.id)).toMatchObject({
      seen: 2,
      parsed: 2,
      added: 2,
      missing: 0,
      error: null,
    });
    expect(listApplications(db)).toMatchObject([
      {
        applicationId: BASE_ID,
        name: "Example Game",
        hasBase: true,
        updateVersions: [196608],
        fileCount: 2,
      },
    ]);

    // An unchanged folder is not re-inspected and doesn't bump the catalog revision.
    const rev = repo.catalogRev();
    expect(await scanner.scanRoot(root.id)).toMatchObject({ parsed: 0, added: 0 });
    expect(repo.catalogRev()).toBe(rev);

    // A replaced file is re-inspected.
    await writeFile(
      join(library, "updates", UPDATE_FILE),
      fakeNsp({ seed: "update", tickets: [UPDATE_ID] }),
    );
    expect(await scanner.scanRoot(root.id)).toMatchObject({ parsed: 1, added: 0 });
    const update = () =>
      repo.listRootFiles(root.id).find((f) => f.relPath === `updates/${UPDATE_FILE}`);
    expect(update()?.metadataSource).toBe("ticket");

    // Deleted files are kept as missing and drop out of the library.
    await rm(join(library, "updates"), { recursive: true });
    expect(await scanner.scanRoot(root.id)).toMatchObject({ missing: 1 });
    expect(update()?.missingSince).not.toBeNull();
    expect(listApplications(db)[0]?.updateVersions).toEqual([]);
    expect(getProblems(db).missing.map((f) => f.relPath)).toEqual([`updates/${UPDATE_FILE}`]);

    // Restoring the file revives the same row.
    const missingId = update()?.id;
    await mkdir(join(library, "updates"));
    await writeFile(
      join(library, "updates", UPDATE_FILE),
      fakeNsp({ seed: "update", tickets: [UPDATE_ID] }),
    );
    await scanner.scanRoot(root.id);
    expect(update()).toMatchObject({ id: missingId, missingSince: null, parseStatus: "ok" });
    expect(listApplications(db)[0]?.updateVersions).toEqual([196608]);
  });

  it("keeps a file's identity when it is renamed or moved", async () => {
    await writeFile(join(library, BASE_FILE), fakeNsp({ tickets: [BASE_ID] }));
    const root = repo.createRoot({ path: library });
    await scanner.scanRoot(root.id);
    const [before] = repo.listRootFiles(root.id);

    await mkdir(join(library, "games"));
    const renamed = `Renamed Game [${BASE_ID}][v0].nsp`;
    await rename(join(library, BASE_FILE), join(library, "games", renamed));

    expect(await scanner.scanRoot(root.id)).toMatchObject({ moved: 1, added: 0, missing: 0 });
    expect(repo.listRootFiles(root.id)).toMatchObject([
      {
        id: before?.id,
        relPath: `games/${renamed}`,
        parseStatus: "ok",
        missingSince: null,
        firstSeenAt: before?.firstSeenAt,
      },
    ]);
    // A moved file keeps its date, so sorting by date added does not treat it as new.
    expect(listApplications(db)[0]).toMatchObject({
      name: "Renamed Game",
      addedAt: before?.firstSeenAt,
    });
  });

  it("leaves files alone when the folder is unreachable", async () => {
    await writeFile(join(library, BASE_FILE), fakeNsp({ tickets: [BASE_ID] }));
    const root = repo.createRoot({ path: library });
    await scanner.scanRoot(root.id);

    await rm(library, { recursive: true });
    const summary = await scanner.scanRoot(root.id);
    expect(summary.error).toMatch(/Folder not found/);
    expect(repo.getRoot(root.id)?.lastScanError).toBe(summary.error);
    expect(repo.listRootFiles(root.id)[0]?.missingSince).toBeNull();

    await mkdir(library);
    await writeFile(join(library, BASE_FILE), fakeNsp({ tickets: [BASE_ID] }));
    expect((await scanner.scanRoot(root.id)).error).toBeNull();
    expect(repo.getRoot(root.id)?.lastScanError).toBeNull();
  });

  it("records unreadable and unidentified files", async () => {
    await writeFile(join(library, "broken.nsp"), deterministicBytes("broken", 0x400));
    await writeFile(join(library, "backup.nsp"), fakeNsp());
    const root = repo.createRoot({ path: library });
    await scanner.scanRoot(root.id);

    const problems = getProblems(db);
    expect(problems.unreadable).toMatchObject([
      {
        relPath: "broken.nsp",
        parseStatus: "error",
        parseError: expect.stringMatching(/isn't a valid NSP file/),
      },
    ]);
    expect(problems.unidentified).toMatchObject([
      { relPath: "backup.nsp", parseError: expect.stringMatching(/No title ID found/) },
    ]);
  });

  it("re-inspects files after a parser upgrade", async () => {
    await writeFile(join(library, BASE_FILE), fakeNsp({ tickets: [BASE_ID] }));
    const root = repo.createRoot({ path: library });
    await scanner.scanRoot(root.id);
    db.update(files).set({ parserVersion: 0 }).run();
    expect(await scanner.scanRoot(root.id)).toMatchObject({ parsed: 1 });
  });

  it("shares a running scan between callers", () => {
    const root = repo.createRoot({ path: library });
    const first = scanner.scanRoot(root.id);
    expect(scanner.scanRoot(root.id)).toBe(first);
    return first;
  });

  it("treats a folder of 00/01 parts as one NSP", async () => {
    const nsp = fakeNsp({ tickets: [BASE_ID], seed: "split" });
    const splitDir = join(library, `Split Game [${BASE_ID}][v0].nsp`);
    await mkdir(splitDir);
    await writeFile(join(splitDir, "00"), nsp.subarray(0, 64));
    await writeFile(join(splitDir, "01"), nsp.subarray(64));
    const root = repo.createRoot({ path: library });
    expect(await scanner.scanRoot(root.id)).toMatchObject({
      seen: 1,
      parsed: 1,
      added: 1,
      error: null,
    });
    const [file] = repo.listRootFiles(root.id);
    expect(file).toMatchObject({
      relPath: `Split Game [${BASE_ID}][v0].nsp`,
      format: "nsp",
      size: nsp.length,
      parseStatus: "ok",
    });
    expect(listApplications(db)[0]?.applicationId).toBe(BASE_ID);
  });
});
