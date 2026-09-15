import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildNro, deterministicBytes, fakeJpeg } from "@nslib/fixtures";
import type {
  AppDetail,
  AppSummary,
  HomebrewItem,
  LibraryRoot,
  LibraryStats,
  ProblemsReport,
} from "@nslib/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/auth/auth-service";
import { createServer, type NslibServer } from "../src/server";
import { fakeNsp, makeTempDir, removeDir, testConfig } from "./helpers";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

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
    it("walks through first-run setup, sign-out, and sign-in", async () => {
      expect((await call("GET", "/auth/status")).json()).toEqual({
        setupRequired: true,
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
});
