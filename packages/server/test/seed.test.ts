import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { guessApplicationIdForAddon } from "@nslib/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProblems, listApplications, listHomebrew } from "../src/library/queries";
import { DEMO_TITLES, generateDemoLibrary } from "../src/seed/generate";
import { createServer, type NslibServer } from "../src/server";
import { fakeNsp, makeTempDir, removeDir, testConfig } from "./helpers";

describe("demo library", () => {
  let dir: string;
  let server: NslibServer;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await server?.close();
    await removeDir(dir);
  });

  it("fills the library, homebrew, and problems views", async () => {
    const libraryDir = join(dir, "demo");
    const keysPath = join(dir, "demo.keys");
    const generated = await generateDemoLibrary({ libraryDir, keysPath });
    expect(generated.files.length).toBeGreaterThan(8);

    const databaseFile = join(dir, "data", "db.sqlite");
    server = await createServer(
      testConfig(join(dir, "data"), {
        databaseFile,
        seed: true,
        seedLibraryDir: libraryDir,
        seedKeysPath: keysPath,
      }),
    );
    await server.start();
    await server.scanner.scanAll();

    expect(server.repo.listRoots()).toMatchObject([{ label: "Demo library" }]);
    const apps = listApplications(server.db);
    expect(apps.map((app) => app.applicationId).sort()).toEqual(
      [
        DEMO_TITLES.harborWatch,
        DEMO_TITLES.redwood,
        DEMO_TITLES.nightCircuit,
        guessApplicationIdForAddon(DEMO_TITLES.driftwoodDlc),
      ].sort(),
    );
    const harbor = apps.find((app) => app.applicationId === DEMO_TITLES.harborWatch);
    expect(harbor).toMatchObject({
      name: "Harbor Watch",
      hasBase: true,
      flags: expect.arrayContaining(["duplicate", "superseded-updates"]),
    });
    expect(apps.find((app) => app.applicationId === DEMO_TITLES.nightCircuit)?.flags).toContain(
      "no-base",
    );
    expect(listHomebrew(server.db).some((item) => item.name === "Scanline")).toBe(true);
    const problems = getProblems(server.db);
    expect(problems.unidentified.some((f) => f.relPath.endsWith("backup.nsp"))).toBe(true);
    expect(problems.unreadable.some((f) => f.relPath.endsWith("broken.xci"))).toBe(true);

    await server.close();
    server = await createServer(
      testConfig(join(dir, "data"), {
        databaseFile,
        seed: true,
        seedLibraryDir: libraryDir,
        seedKeysPath: keysPath,
      }),
    );
    await server.start();
    expect(server.repo.listRoots()).toHaveLength(1);
  });

  it("attaches subfolders of libraryScanDir as roots", async () => {
    const libraryDir = join(dir, "library");
    const games = join(libraryDir, "games");
    await mkdir(games, { recursive: true });
    await writeFile(join(games, "Example [0100ABCDEF012000][v0].nsp"), fakeNsp());
    server = await createServer(
      testConfig(join(dir, "data"), { seed: false, libraryScanDir: libraryDir }),
    );
    await server.start();
    expect(server.repo.listRoots()).toMatchObject([{ label: "games", path: games }]);
  });
});
