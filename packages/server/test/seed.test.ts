import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatProdKeys, generateFakeKeyset } from "@nslib/fixtures";
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

  async function exists(path: string) {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  it("keeps demo keys out of prod.keys and drops them when real keys arrive", async () => {
    const keysPath = join(dir, "demo.keys");
    await writeFile(keysPath, formatProdKeys(generateFakeKeyset()));
    const dataDir = join(dir, "data");
    server = await createServer(
      testConfig(dataDir, { seed: true, seedLibraryDir: null, seedKeysPath: keysPath }),
    );
    await server.start();

    const inject = server.app.inject.bind(server.app);
    expect(await exists(join(dataDir, "keys", "prod.keys"))).toBe(false);
    expect(await exists(join(dataDir, "keys", "demo.keys"))).toBe(true);
    const setup = await inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { username: "admin", password: "correct horse" },
    });
    const cookies = { nslib_session: setup.cookies[0]?.value ?? "" };
    const status = (await inject({ method: "GET", url: "/api/v1/keys/status", cookies })).json();
    expect(status).toMatchObject({ configured: true, demo: true });
    expect((await inject({ method: "GET", url: "/api/v1/stats", cookies })).json()).toMatchObject({
      keysConfigured: false,
    });

    const real = formatProdKeys(generateFakeKeyset("console"));
    const saved = await inject({
      method: "PUT",
      url: "/api/v1/keys",
      payload: { contents: real },
      cookies,
    });
    expect(saved.json()).toMatchObject({ configured: true, demo: false });
    expect(await exists(join(dataDir, "keys", "demo.keys"))).toBe(false);
    expect(await readFile(join(dataDir, "keys", "prod.keys"), "utf8")).toBe(real);
    expect((await stat(join(dataDir, "keys", "prod.keys"))).mode & 0o777).toBe(0o600);
  });

  it("moves demo keys an older version saved as prod.keys", async () => {
    const keysPath = join(dir, "demo.keys");
    await writeFile(keysPath, formatProdKeys(generateFakeKeyset()));
    const dataDir = join(dir, "data");
    await mkdir(join(dataDir, "keys"), { recursive: true });
    await copyFile(keysPath, join(dataDir, "keys", "prod.keys"));

    server = await createServer(
      testConfig(dataDir, { seed: false, seedLibraryDir: null, seedKeysPath: keysPath }),
    );
    await server.start();
    expect(await exists(join(dataDir, "keys", "prod.keys"))).toBe(false);
    expect(await exists(join(dataDir, "keys", "demo.keys"))).toBe(true);
    // Seeding is off, so the demo keys aren't used at all.
    const setup = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { username: "admin", password: "correct horse" },
    });
    const status = await server.app.inject({
      method: "GET",
      url: "/api/v1/keys/status",
      cookies: { nslib_session: setup.cookies[0]?.value ?? "" },
    });
    expect(status.json()).toMatchObject({ configured: false, demo: false });
  });

  it("does not attach removed folders again on restart", async () => {
    const libraryDir = join(dir, "library");
    const games = join(libraryDir, "games");
    const demo = join(libraryDir, "demo");
    await mkdir(games, { recursive: true });
    await mkdir(demo, { recursive: true });
    const databaseFile = join(dir, "data", "db.sqlite");
    const config = testConfig(join(dir, "data"), {
      databaseFile,
      seed: true,
      seedLibraryDir: demo,
      libraryScanDir: libraryDir,
    });
    server = await createServer(config);
    await server.start();
    expect(
      server.repo
        .listRoots()
        .map((root) => root.path)
        .sort(),
    ).toEqual([demo, games]);

    for (const root of server.repo.listRoots()) server.repo.deleteRoot(root.id);
    await server.close();
    server = await createServer(config);
    await server.start();
    expect(server.repo.listRoots()).toEqual([]);

    // Adding one back by hand clears it from the removed list.
    server.repo.createRoot({ path: games });
    expect(server.repo.removedRootPaths()).toEqual(new Set([demo]));
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
