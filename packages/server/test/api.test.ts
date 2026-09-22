import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildNro,
  buildTitleNsp,
  deterministicBytes,
  fakeJpeg,
  formatProdKeys,
  generateFakeKeyset,
} from "@nslib/fixtures";
import type {
  AppDetail,
  AppSummary,
  HomebrewItem,
  KeyStatus,
  LibraryRoot,
  LibraryStats,
  ProblemsReport,
  TitledbStatus,
  VerifyTask,
} from "@nslib/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_SESSION_CHECK_MS } from "../src/api/library-routes";
import { LoginRateLimiter, SESSION_COOKIE } from "../src/auth/auth-service";
import { createServer, type NslibServer } from "../src/server";
import { fakeNsp, makeTempDir, removeDir, testConfig } from "./helpers";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

describe("web API", () => {
  let dir: string;
  let server: NslibServer;

  beforeEach(async () => {
    dir = await makeTempDir();
    server = await createServer(testConfig(join(dir, "data")));
  });

  afterEach(async () => {
    await server.close();
    await removeDir(dir);
  });

  function call(method: Method, url: string, options: { body?: unknown; session?: string } = {}) {
    return server.app.inject({
      method,
      url: `/api/v1${url}`,
      ...(options.body === undefined ? {} : { payload: options.body as object }),
      ...(options.session ? { cookies: { [SESSION_COOKIE]: options.session } } : {}),
    });
  }

  async function waitForVerify(session: string, fileId: number): Promise<VerifyTask> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const tasks = (await call("GET", "/verify", { session })).json<VerifyTask[]>();
      const task = tasks.find((t) => t.fileId === fileId);
      if (task && task.state !== "queued" && task.state !== "running") return task;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`verify of file ${fileId} did not finish`);
  }

  async function setUp(): Promise<string> {
    const res = await call("POST", "/auth/setup", {
      body: { username: "admin", password: "correct horse" },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    if (!cookie) throw new Error("no session cookie");
    return cookie.value;
  }

  describe("authentication", () => {
    it("requires the setup token when the server sets one", async () => {
      await server.close();
      server = await createServer(testConfig(join(dir, "data"), { setupToken: "s3cret-token" }));
      expect((await call("GET", "/auth/status")).json()).toMatchObject({
        setupRequired: true,
        setupTokenRequired: true,
      });
      const body = { username: "admin", password: "correct horse" };
      const missing = await call("POST", "/auth/setup", { body });
      expect(missing.statusCode).toBe(403);
      expect(server.auth.isSetupRequired()).toBe(true);
      const wrong = await call("POST", "/auth/setup", { body: { ...body, setupToken: "nope" } });
      expect(wrong.json().error.msg).toBe("That setup token is wrong");
      const ok = await call("POST", "/auth/setup", {
        body: { ...body, setupToken: "s3cret-token" },
      });
      expect(ok.statusCode).toBe(200);
      expect((await call("GET", "/auth/status")).json()).toMatchObject({
        setupRequired: false,
        setupTokenRequired: false,
      });
    });

    it("walks through first-run setup, sign-out, and sign-in", async () => {
      expect((await call("GET", "/auth/status")).json()).toEqual({
        setupRequired: true,
        setupTokenRequired: false,
        authenticated: false,
        username: null,
      });

      const unauthorized = await call("GET", "/roots");
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.json()).toEqual({
        error: { code: "UNAUTHORIZED", msg: "Sign in to continue" },
      });

      const weak = await call("POST", "/auth/setup", {
        body: { username: "admin", password: "short" },
      });
      expect(weak.statusCode).toBe(400);
      expect(weak.json().error.msg).toBe("password: Use at least 8 characters");

      const res = await call("POST", "/auth/setup", {
        body: { username: "admin", password: "correct horse" },
      });
      const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" });
      const session = cookie?.value ?? "";

      expect((await call("GET", "/roots", { session })).json()).toEqual([]);
      expect((await call("GET", "/auth/status", { session })).json()).toEqual({
        setupRequired: false,
        setupTokenRequired: false,
        authenticated: true,
        username: "admin",
      });
      expect(
        (
          await call("POST", "/auth/setup", {
            body: { username: "other", password: "another password" },
          })
        ).statusCode,
      ).toBe(409);

      expect((await call("POST", "/auth/logout", { session })).statusCode).toBe(200);
      expect((await call("GET", "/roots", { session })).statusCode).toBe(401);

      const wrong = await call("POST", "/auth/login", {
        body: { username: "admin", password: "wrong password" },
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json().error.msg).toBe("Wrong username or password");

      const login = await call("POST", "/auth/login", {
        body: { username: "admin", password: "correct horse" },
      });
      expect(login.statusCode).toBe(200);
      const newSession = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
      expect((await call("GET", "/roots", { session: newSession })).statusCode).toBe(200);
    });

    it("changes the password and signs out other sessions", async () => {
      const session = await setUp();
      const login = (password: string) =>
        call("POST", "/auth/login", { body: { username: "admin", password } });
      const other = (await login("correct horse")).cookies.find(
        (c) => c.name === SESSION_COOKIE,
      )?.value;
      const change = (body: object, as = session) =>
        call("POST", "/auth/password", { session: as, body });

      expect(
        (
          await call("POST", "/auth/password", {
            body: { currentPassword: "correct horse", newPassword: "battery staple" },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (await change({ currentPassword: "correct horse", newPassword: "short" })).statusCode,
      ).toBe(400);
      const wrong = await change({ currentPassword: "nope", newPassword: "battery staple" });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json().error.code).toBe("FORBIDDEN");

      expect(
        (await change({ currentPassword: "correct horse", newPassword: "battery staple" }))
          .statusCode,
      ).toBe(204);
      expect((await call("GET", "/stats", { session })).statusCode).toBe(200);
      expect((await call("GET", "/stats", { session: other })).statusCode).toBe(401);
      expect((await login("correct horse")).statusCode).toBe(401);
      expect((await login("battery staple")).statusCode).toBe(200);
    });

    it("resets the password from the server and signs everyone out", async () => {
      const session = await setUp();
      expect(await server.auth.resetPassword("battery staple")).toBe("admin");
      expect((await call("GET", "/stats", { session })).statusCode).toBe(401);
      expect(
        (
          await call("POST", "/auth/login", {
            body: { username: "admin", password: "battery staple" },
          })
        ).statusCode,
      ).toBe(200);
    });

    it("only accepts tokenless setup from this machine", async () => {
      const body = { username: "admin", password: "correct horse" };
      const lan = await server.app.inject({
        method: "POST",
        url: "/api/v1/auth/setup",
        payload: body,
        remoteAddress: "192.168.1.20",
        // A forwarded address must not count: anyone can send this header.
        headers: { "x-forwarded-for": "127.0.0.1" },
      });
      expect(lan.statusCode).toBe(403);
      expect(server.auth.isSetupRequired()).toBe(true);
      expect((await call("POST", "/auth/setup", { body })).statusCode).toBe(200);
    });

    it("closes the event socket once its session ends", async () => {
      const session = await setUp();
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      try {
        const socket = await server.app.injectWS("/api/v1/ws", {
          headers: { cookie: `${SESSION_COOKIE}=${session}` },
        });
        const closed = new Promise<number>((resolve) => socket.on("close", resolve));
        vi.advanceTimersByTime(WS_SESSION_CHECK_MS);
        expect(socket.readyState).toBe(socket.OPEN);

        await call("POST", "/auth/logout", { session });
        vi.advanceTimersByTime(WS_SESSION_CHECK_MS);
        expect(await closed).toBe(4001);
      } finally {
        vi.useRealTimers();
      }
    });

    it("limits repeated failed sign-ins", async () => {
      await setUp();
      for (let i = 0; i < 10; i++) {
        expect(
          (await call("POST", "/auth/login", { body: { username: "admin", password: "nope" } }))
            .statusCode,
        ).toBe(401);
      }
      const limited = await call("POST", "/auth/login", {
        body: { username: "admin", password: "correct horse" },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe("RATE_LIMITED");
    });
  });

  it("forgets addresses whose failures have aged out", () => {
    let now = 0;
    const limiter = new LoginRateLimiter(10, 1000, () => now);
    for (let i = 0; i < 1000; i++) limiter.recordFailure(`10.0.${i >> 8}.${i & 255}`);
    expect(limiter.size).toBe(1000);
    now = 5000;
    limiter.recordFailure("10.9.9.9");
    expect(limiter.size).toBe(1);
  });

  describe("library folders", () => {
    it("validates folder paths", async () => {
      const session = await setUp();
      const library = join(dir, "library");
      await mkdir(join(library, "nested"), { recursive: true });
      await writeFile(join(dir, "file.nsp"), "x");

      const create = (path: string) => call("POST", "/roots", { session, body: { path } });
      expect((await create("library")).json().error.msg).toBe(
        "Enter the full folder path, like /library/games",
      );
      expect((await create(join(dir, "nope"))).json().error.msg).toMatch(/^Folder not found/);
      expect((await create(join(dir, "file.nsp"))).json().error.msg).toMatch(/is a file/);

      const created = await create(library);
      expect(created.statusCode).toBe(201);
      const root = created.json<LibraryRoot>();
      expect(root).toMatchObject({ path: library, enabled: true, fileCount: 0 });

      expect((await create(library)).statusCode).toBe(409);
      expect((await create(join(library, "nested"))).statusCode).toBe(409);
      expect((await create(dir)).statusCode).toBe(409);

      expect(
        (await call("PATCH", "/roots/999", { session, body: { label: "x" } })).statusCode,
      ).toBe(404);
      expect(
        (await call("PATCH", `/roots/${root.id}`, { session, body: { label: "Games" } })).json(),
      ).toMatchObject({
        label: "Games",
      });
      expect((await call("DELETE", `/roots/${root.id}`, { session })).statusCode).toBe(204);
      expect((await call("GET", "/roots", { session })).json()).toEqual([]);
    });
  });

  describe("library views", () => {
    const BASE = "0100ABCDEF012000";
    const icon = fakeJpeg("tool", 0x400);

    async function populate(library: string) {
      const write = async (relPath: string, data: Buffer) => {
        await mkdir(join(library, relPath, ".."), { recursive: true });
        await writeFile(join(library, relPath), data);
      };
      await write(`Example Game [${BASE}][v0].nsp`, fakeNsp({ seed: "base", tickets: [BASE] }));
      await write(`backups/Example Game [${BASE}][v0].nsz`, fakeNsp({ seed: "base-copy" }));
      await write("Example Game [0100ABCDEF012800][v131072].nsp", fakeNsp({ seed: "u1" }));
      await write(
        "Example Game [0100ABCDEF012800][v196608].nsp",
        fakeNsp({ seed: "u2", tickets: ["0100ABCDEF012800"] }),
      );
      await write(
        "dlc/Example Game - Bonus [0100ABCDEF013001][v0].nsp",
        fakeNsp({ seed: "dlc", tickets: ["0100ABCDEF013001"] }),
      );
      await write("Other Game Update [0100000000AB0800][v65536].nsp", fakeNsp({ seed: "other" }));
      await write(
        "homebrew/tool.nro",
        buildNro({ name: "Tool", publisher: "Someone", displayVersion: "1.0", icon }),
      );
      await write("broken.xci", deterministicBytes("broken", 0x2000));
      await write("backup.nsp", fakeNsp({ seed: "unknown" }));
    }

    it("groups content by game and reports problems", async () => {
      const session = await setUp();
      const library = join(dir, "library");
      await populate(library);
      const root = (
        await call("POST", "/roots", { session, body: { path: library } })
      ).json<LibraryRoot>();
      await server.scanner.scanRoot(root.id);

      const apps = (await call("GET", "/apps", { session })).json<AppSummary[]>();
      expect(apps.map((a) => a.name)).toEqual(["Example Game", "Other Game Update"]);
      expect(apps[0]).toMatchObject({
        applicationId: BASE,
        hasBase: true,
        baseFormats: ["nsp", "nsz"],
        updateVersions: [196608, 131072],
        addonCount: 1,
        fileCount: 5,
      });
      expect(apps[0]?.flags.sort()).toEqual([
        "duplicate",
        "guessed-dlc-base",
        "superseded-updates",
      ]);
      expect(apps[1]).toMatchObject({
        applicationId: "0100000000AB0000",
        hasBase: false,
        flags: ["no-base"],
      });

      expect(
        (await call("GET", "/apps?q=other", { session })).json<AppSummary[]>().map((a) => a.name),
      ).toEqual(["Other Game Update"]);
      expect(
        (await call("GET", "/apps?q=0100abcdef013001", { session })).json<AppSummary[]>(),
      ).toHaveLength(1);
      expect(
        (await call("GET", "/apps?flag=no-base", { session })).json<AppSummary[]>(),
      ).toHaveLength(1);
      expect((await call("GET", "/apps?flag=bogus", { session })).statusCode).toBe(400);

      const detail = (
        await call("GET", `/apps/${BASE.toLowerCase()}`, { session })
      ).json<AppDetail>();
      expect(detail.contents.map((c) => [c.type, c.version, c.files.length])).toEqual([
        ["application", 0, 2],
        ["patch", 196608, 1],
        ["patch", 131072, 1],
        ["addon", 0, 1],
      ]);
      expect((await call("GET", "/apps/0100000000000000", { session })).statusCode).toBe(404);

      // The base game's install target follows the "prefer NSZ" setting.
      const baseFormat = async () => {
        const app = (await call("GET", `/apps/${BASE}`, { session })).json<AppDetail>();
        const metaId = app.contents[0]?.contentMetaId;
        return (
          server.sqlite
            .prepare(
              "select f.format from content_metas m join files f on f.id = m.file_id where m.id = ?",
            )
            .get(metaId) as { format: string }
        ).format;
      };
      expect(await baseFormat()).toBe("nsz");
      await call("PUT", "/settings", { session, body: { preferNsz: false } });
      expect(await baseFormat()).toBe("nsp");

      const homebrew = (await call("GET", "/homebrew", { session })).json<HomebrewItem[]>();
      expect(homebrew).toMatchObject([
        { name: "Tool", publisher: "Someone", version: "1.0", relPath: "homebrew/tool.nro" },
      ]);
      const iconRes = await server.app.inject({
        method: "GET",
        url: homebrew[0]?.iconUrl ?? "",
        cookies: { [SESSION_COOKIE]: session },
      });
      expect(iconRes.statusCode).toBe(200);
      expect(iconRes.headers["content-type"]).toBe("image/jpeg");
      expect(iconRes.rawPayload.equals(icon)).toBe(true);

      const problems = (await call("GET", "/problems", { session })).json<ProblemsReport>();
      expect(problems.unreadable.map((f) => f.relPath)).toEqual(["broken.xci"]);
      expect(problems.unidentified.map((f) => f.relPath)).toEqual(["backup.nsp"]);
      expect(problems.duplicates).toMatchObject([{ titleId: BASE, version: 0 }]);

      expect((await call("GET", "/stats", { session })).json<LibraryStats>()).toMatchObject({
        applications: 2,
        files: 9,
        homebrew: 1,
        problems: 3,
        keysConfigured: false,
      });

      const roots = (await call("GET", "/roots", { session })).json<LibraryRoot[]>();
      expect(roots).toMatchObject([{ fileCount: 9, missingCount: 0, scan: { state: "idle" } }]);

      // Turning a folder off hides its content without forgetting it.
      await call("PATCH", `/roots/${root.id}`, { session, body: { enabled: false } });
      expect((await call("GET", "/apps", { session })).json()).toEqual([]);
      await call("PATCH", `/roots/${root.id}`, { session, body: { enabled: true } });
      expect((await call("GET", "/apps", { session })).json()).toHaveLength(2);
    });

    it("returns JSON errors for unknown API routes", async () => {
      const session = await setUp();
      const res = await call("GET", "/nothing-here", { session });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: { code: "NOT_FOUND", msg: "No route for GET /api/v1/nothing-here" },
      });
    });
  });

  describe("keys, titledb, and verify", () => {
    const keys = generateFakeKeyset();
    const BASE = "0100ABCDEF012000";

    it("stores prod.keys without returning material, then reads CNMT names", async () => {
      const session = await setUp();
      expect((await call("GET", "/keys/status", { session })).json<KeyStatus>()).toMatchObject({
        configured: false,
        headerKey: false,
      });

      const saved = await call("PUT", "/keys", {
        session,
        body: { contents: formatProdKeys(keys) },
      });
      expect(saved.statusCode).toBe(200);
      const status = saved.json<KeyStatus>();
      expect(status.configured).toBe(true);
      expect(status.headerKey).toBe(true);
      expect(status.names).toContain("header_key");
      expect(JSON.stringify(status)).not.toMatch(/[0-9a-f]{32}/i);

      const library = join(dir, "keyed");
      const pkg = buildTitleNsp({
        titleId: BASE,
        keys,
        name: "Keyed Game",
        publisher: "Fixture Co",
        requiredSystemVersion: 0x0c0000,
      });
      await mkdir(library, { recursive: true });
      await writeFile(join(library, "game.nsp"), pkg.nsp);
      const root = (
        await call("POST", "/roots", { session, body: { path: library } })
      ).json<LibraryRoot>();
      await server.scanner.scanRoot(root.id);

      const apps = (await call("GET", "/apps", { session })).json<AppSummary[]>();
      expect(apps).toMatchObject([{ name: "Keyed Game", publisher: "Fixture Co" }]);
      const detail = (await call("GET", `/apps/${BASE}`, { session })).json<AppDetail>();
      expect(detail.contents[0]).toMatchObject({
        type: "application",
        version: 0,
        requiredSystemVersion: 0x0c0000,
      });
      expect(detail.iconUrl).toMatch(/\/icons\//);

      const fileId = detail.contents[0]?.files[0]?.id;
      expect(fileId).toBeTypeOf("number");
      const updates: VerifyTask[] = [];
      const unsubscribe = server.events.subscribe((event) => {
        if (event.type === "verify.updated") updates.push(event.task);
      });
      const started = await call("POST", `/files/${fileId}/verify`, {
        session,
        body: { mode: "full" },
      });
      expect(started.statusCode).toBe(202);
      expect(["queued", "running"]).toContain(started.json<VerifyTask>().state);
      const finished = await waitForVerify(session, fileId as number);
      unsubscribe();
      expect(finished.state).toBe("done");
      expect(finished.result?.status).toBe("ok");
      expect(finished.result?.items.every((i) => i.ok)).toBe(true);
      expect(finished.bytesDone).toBe(finished.bytesTotal);
      expect(finished.bytesTotal).toBeGreaterThan(0);
      expect(updates.map((u) => u.state)).toEqual(
        expect.arrayContaining(["queued", "running", "done"]),
      );
      const file = (await call("GET", `/apps/${BASE}`, { session })).json<AppDetail>().contents[0]
        ?.files[0];
      expect(file?.verifyStatus).toBe("ok");

      // Cancelling a finished task leaves it alone; an unknown file is a 404.
      expect(
        (await call("POST", `/files/${fileId}/verify/cancel`, { session })).json<VerifyTask>()
          .state,
      ).toBe("done");
      expect((await call("POST", "/files/999999/verify", { session })).statusCode).toBe(404);
    });

    it("cancels a queued verify", async () => {
      const session = await setUp();
      const library = join(dir, "cancel");
      await mkdir(library, { recursive: true });
      await writeFile(join(library, `A [${BASE}][v0].nsp`), fakeNsp({ seed: "a" }));
      await writeFile(join(library, "B [0100ABCDEF014000][v0].nsp"), fakeNsp({ seed: "b" }));
      const root = (
        await call("POST", "/roots", { session, body: { path: library } })
      ).json<LibraryRoot>();
      await server.scanner.scanRoot(root.id);
      const [first, second] = server.repo.listRootFiles(root.id);
      // Only one verify runs at a time, so the second waits in the queue.
      server.verify.start(first!.id, "full");
      expect(server.verify.start(second!.id, "full").state).toBe("queued");
      const cancelled = await call("POST", `/files/${second!.id}/verify/cancel`, { session });
      expect(cancelled.json<VerifyTask>().state).toBe("cancelled");
      await waitForVerify(session, first!.id);
      const tasks = (await call("GET", "/verify", { session })).json<VerifyTask[]>();
      expect(tasks.find((t) => t.fileId === second!.id)?.state).toBe("cancelled");
    });

    it("imports titledb names for titles without NACP", async () => {
      const session = await setUp();
      const library = join(dir, "tdb");
      await mkdir(library, { recursive: true });
      await writeFile(join(library, `Mystery [${BASE}][v0].nsp`), fakeNsp({ tickets: [BASE] }));
      const root = (
        await call("POST", "/roots", { session, body: { path: library } })
      ).json<LibraryRoot>();
      await server.scanner.scanRoot(root.id);
      expect((await call("GET", "/apps", { session })).json<AppSummary[]>()[0]?.name).toBe(
        "Mystery",
      );

      const titledbPath = join(dir, "titledb.json");
      await writeFile(
        titledbPath,
        JSON.stringify({
          [BASE]: { name: "From Titledb", publisher: "Someone", version: 196608 },
        }),
      );
      expect(
        (await call("PUT", "/titledb", { session, body: { source: titledbPath } })).statusCode,
      ).toBe(200);
      const refreshed = (await call("POST", "/titledb/refresh", { session })).json<TitledbStatus>();
      expect(refreshed.titleCount).toBe(1);
      expect(refreshed.lastError).toBeNull();
      const apps = (await call("GET", "/apps", { session })).json<AppSummary[]>();
      expect(apps[0]).toMatchObject({
        name: "From Titledb",
        flags: expect.arrayContaining(["update-available"]),
      });
    });

    it("maps DLC to its base game and names it from titledb, and can be turned off", async () => {
      const session = await setUp();
      const library = join(dir, "tdb-dlc");
      const DLC = "0100ABCDEF013001";
      const REAL_BASE = "0100AAAABBBB0000";
      await mkdir(library, { recursive: true });
      await writeFile(join(library, `bonus [${DLC}][v0].nsp`), fakeNsp({ tickets: [DLC] }));
      const root = (
        await call("POST", "/roots", { session, body: { path: library } })
      ).json<LibraryRoot>();
      await server.scanner.scanRoot(root.id);
      // Without titledb the base game is guessed from the DLC's title ID.
      expect((await call("GET", "/apps", { session })).json<AppSummary[]>()).toMatchObject([
        { applicationId: BASE, flags: expect.arrayContaining(["guessed-dlc-base"]) },
      ]);

      // Keyed by eShop ID with the title ID in `id`, like blawar's region files.
      const titledbPath = join(dir, "titles.US.en.json");
      await writeFile(
        titledbPath,
        JSON.stringify({
          "70010000000001": { id: REAL_BASE, name: "Real Base Game", version: 65536 },
          "70050000000002": { id: DLC, name: "Bonus Pack", baseId: REAL_BASE },
          "70010000000003": { id: "not a title id", name: "Ignored" },
        }),
      );
      await call("PUT", "/titledb", { session, body: { source: titledbPath } });
      const revBefore = server.repo.catalogRev();
      const refreshed = (await call("POST", "/titledb/refresh", { session })).json<TitledbStatus>();
      expect(refreshed).toMatchObject({ titleCount: 2, lastError: null, enabled: true });
      expect(server.repo.catalogRev()).toBeGreaterThan(revBefore);

      const mapped = (await call("GET", "/apps", { session })).json<AppSummary[]>();
      expect(mapped).toMatchObject([{ applicationId: REAL_BASE, name: "Real Base Game" }]);
      expect(mapped[0]?.flags).not.toContain("guessed-dlc-base");
      const detail = (await call("GET", `/apps/${REAL_BASE}`, { session })).json<AppDetail>();
      expect(detail.contents).toMatchObject([
        { titleId: DLC, name: "Bonus Pack", applicationIdSource: "titledb" },
      ]);
      const catalog = server.devices.getCatalog({});
      expect(catalog.apps).toMatchObject([
        {
          i: REAL_BASE,
          n: "Real Base Game",
          d: [[DLC, 0, "Bonus Pack", expect.any(Number), expect.any(Number)]],
        },
      ]);

      const off = await call("PUT", "/titledb", { session, body: { enabled: false } });
      expect(off.json<TitledbStatus>()).toMatchObject({ enabled: false, titleCount: 2 });
      expect((await call("GET", "/apps", { session })).json<AppSummary[]>()).toMatchObject([
        { applicationId: BASE, name: "bonus" },
      ]);
      expect((await call("GET", `/apps/${REAL_BASE}`, { session })).statusCode).toBe(404);
    });
  });
});
