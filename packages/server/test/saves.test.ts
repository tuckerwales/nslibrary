import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buildSaveArchive } from "@nslib/formats";
import {
  HelloResponseSchema,
  type PairingCode,
  type SaveBackup,
  SaveListResponseSchema,
  SaveUploadResponseSchema,
  type ServerEvent,
  type ServerSettings,
} from "@nslib/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveFileName } from "../src/api/save-routes";
import { SESSION_COOKIE } from "../src/auth/auth-service";
import { createServer, type NslibServer } from "../src/server";
import { fakeNsp, makeTempDir, removeDir, testConfig } from "./helpers";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const APP = "0100ABCDEF010000";
const OTHER_APP = "0100000000AB0000";
const USER = "0123456789ABCDEF0FEDCBA987654321";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function archive(seed: string): Buffer {
  return buildSaveArchive([
    { path: "save.dat", data: Buffer.from(`progress ${seed}`) },
    { path: "slots/1.bin", data: Buffer.alloc(700, seed.length) },
    { path: "empty" },
  ]);
}

describe("save backups", () => {
  let dir: string;
  let server: NslibServer;
  let now: number;
  let session: string;

  async function start(overrides: Parameters<typeof testConfig>[1] = {}) {
    server = await createServer(testConfig(join(dir, "data"), overrides), { now: () => now });
    const res = await web("POST", "/auth/setup", {
      body: { username: "admin", password: "correct horse" },
    });
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    if (!cookie) throw new Error("no session cookie");
    session = cookie.value;
  }

  beforeEach(async () => {
    dir = await makeTempDir();
    now = 1_790_000_000_000;
  });

  afterEach(async () => {
    await server?.close();
    await removeDir(dir);
  });

  function web(method: Method, url: string, options: { body?: unknown } = {}) {
    return server.app.inject({
      method,
      url: `/api/v1${url}`,
      ...(options.body === undefined ? {} : { payload: options.body as object }),
      ...(session ? { cookies: { [SESSION_COOKIE]: session } } : {}),
    });
  }

  async function pair(uuid: string, name: string): Promise<string> {
    const { code } = (await web("POST", "/devices/pairing-code")).json<PairingCode>();
    const res = await server.app.inject({
      method: "POST",
      url: "/api/device/v1/pair",
      payload: {
        code,
        deviceUuid: uuid,
        name,
        fw: "19.0.1",
        amsVersion: "1.8.0",
        appVersion: "0.5.0",
      },
    });
    return res.json<{ token: string }>().token;
  }

  function upload(
    token: string,
    body: Buffer,
    query: Record<string, string> = {},
    headers: Record<string, string> = {},
  ) {
    const params = new URLSearchParams({
      app: APP,
      type: "account",
      user: USER,
      userName: "Player",
      sha256: sha(body),
      ...query,
    });
    for (const [key, value] of Object.entries(query)) if (value === "") params.delete(key);
    return server.app.inject({
      method: "POST",
      url: `/api/device/v1/saves?${params}`,
      payload: body,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-tar",
        ...headers,
      },
    });
  }

  function deviceGet(token: string, url: string, headers: Record<string, string> = {}) {
    return server.app.inject({
      method: "GET",
      url: `/api/device/v1${url}`,
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
  }

  it("advertises the saves capability", async () => {
    await start();
    const token = await pair("3f2b8c1e-9a4d-4e7b-8c21-5d6f0a1b2c3d", "Living room");
    const hello = HelloResponseSchema.parse((await deviceGet(token, "/hello")).json());
    expect(hello.caps).toContain("saves");
  });

  it("stores an upload, recognises the same bytes again, and serves it back", async () => {
    await start();
    const token = await pair("3f2b8c1e-9a4d-4e7b-8c21-5d6f0a1b2c3d", "Living room");
    const events: ServerEvent[] = [];
    server.events.subscribe((event) => events.push(event));
    const body = archive("one");

    const first = await upload(token, body, { name: "Harbor Watch" });
    expect(first.statusCode).toBe(201);
    const stored = SaveUploadResponseSchema.parse(first.json());
    expect(stored.dup).toBe(false);
    expect(stored.backup).toMatchObject({
      app: APP,
      type: "account",
      user: USER,
      userName: "Player",
      device: "Living room",
      mine: true,
      size: body.length,
      dataSize: "progress one".length + 700,
      files: 2,
      sha256: sha(body),
      at: now / 1000,
      origin: "manual",
      pinned: false,
      note: null,
    });
    expect(events).toContainEqual({ type: "saves.changed" });
    expect(existsSync(join(dir, "data", "saves", APP, `${stored.backup.id}.tar`))).toBe(true);

    now += 60_000;
    const again = await upload(token, body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ dup: true, backup: { id: stored.backup.id } });
    expect(server.saves.list()).toHaveLength(1);

    const full = await deviceGet(token, `/saves/${stored.backup.id}/data`);
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.equals(body)).toBe(true);
    expect(full.headers.etag).toBe(`"${sha(body)}"`);

    const part = await deviceGet(token, `/saves/${stored.backup.id}/data`, {
      range: "bytes=512-1023",
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 512-1023/${body.length}`);
    expect(part.rawPayload.equals(body.subarray(512, 1024))).toBe(true);

    const stale = await deviceGet(token, `/saves/${stored.backup.id}/data`, {
      range: "bytes=0-9",
      "if-range": '"0000"',
    });
    expect(stale.statusCode).toBe(200);

    const outside = await deviceGet(token, `/saves/${stored.backup.id}/data`, {
      range: `bytes=${body.length}-`,
    });
    expect(outside.statusCode).toBe(416);

    expect((await deviceGet(token, "/saves/999/data")).json().error.code).toBe("NOT_FOUND");
  });

  it("keeps a new backup when the save changed, and device saves apart from account saves", async () => {
    await start();
    const token = await pair("3f2b8c1e-9a4d-4e7b-8c21-5d6f0a1b2c3d", "Living room");
    expect((await upload(token, archive("one"))).statusCode).toBe(201);
    now += 1000;
    expect((await upload(token, archive("two"))).statusCode).toBe(201);
    now += 1000;
    const device = archive("one");
    const res = await upload(token, device, { type: "device", user: "", userName: "" });
    expect(res.statusCode).toBe(201);
    expect(res.json().backup).toMatchObject({ type: "device", user: null, userName: null });
    expect(server.saves.list()).toHaveLength(3);
  });

  it("rejects damaged, invalid, oversized and badly described uploads", async () => {
    await start({ saveMaxBytes: 8 * 1024 });
    const token = await pair("3f2b8c1e-9a4d-4e7b-8c21-5d6f0a1b2c3d", "Living room");
    const body = archive("one");

    const damaged = await upload(token, body, { sha256: "0".repeat(64) });
    expect(damaged.statusCode).toBe(422);
    expect(damaged.json().error.code).toBe("SAVE_INVALID");

    const notTar = Buffer.alloc(2048, 7);
    const invalid = await upload(token, notTar);
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.msg).toMatch(/Not a usable save archive/);

    const big = buildSaveArchive([{ path: "big.bin", data: Buffer.alloc(9 * 1024) }]);
    const tooLarge = await upload(token, big);
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error).toEqual({
      code: "PAYLOAD_TOO_LARGE",
      msg: "Save archives larger than 8 KB are not accepted (NSLIB_SAVE_MAX_MB)",
    });

    // Without a Content-Length the limit is enforced while the body streams in.
    const streamed = await server.app.inject({
      method: "POST",
      url: `/api/device/v1/saves?app=${APP}&type=device&sha256=${sha(big)}`,
      payload: Readable.from([big]),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-tar",
        "transfer-encoding": "chunked",
      },
    });
    expect(streamed.json().error.code).toBe("PAYLOAD_TOO_LARGE");

    const noUser = await upload(token, body, { user: "" });
    expect(noUser.statusCode).toBe(400);

    const json = await upload(token, body, {}, { "content-type": "application/json" });
    expect(json.statusCode).toBe(400);

    const anonymous = await server.app.inject({
      method: "POST",
      url: `/api/device/v1/saves?app=${APP}&type=device&sha256=${sha(body)}`,
      payload: body,
      headers: { "content-type": "application/x-tar" },
    });
    expect(anonymous.statusCode).toBe(401);

    expect(server.saves.list()).toHaveLength(0);
    // Nothing half-written is left behind.
    expect(await readdir(join(dir, "data", "saves", ".incoming"))).toEqual([]);
  });

  it("lists backups for a game, newest per save, and marks the console's own", async () => {
    await start();
    const living = await pair("3f2b8c1e-9a4d-4e7b-8c21-5d6f0a1b2c3d", "Living room");
    const travel = await pair("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "Travel");
    await upload(living, archive("one"));
    now += 1000;
    await upload(living, archive("two"));
    now += 1000;
    await upload(travel, archive("three"));
    now += 1000;
    await upload(travel, archive("four"), { app: OTHER_APP });

    const all = SaveListResponseSchema.parse((await deviceGet(living, "/saves")).json());
    expect(all.backups.map((b) => b.at)).toEqual(
      [...all.backups.map((b) => b.at)].sort((a, b) => b - a),
    );
    expect(all.backups).toHaveLength(4);

    const game = SaveListResponseSchema.parse(
      (await deviceGet(living, `/saves?app=${APP.toLowerCase()}`)).json(),
    );
    expect(game.backups).toHaveLength(3);
    expect(game.backups.map((b) => [b.device, b.mine])).toEqual([
      ["Travel", false],
      ["Living room", true],
      ["Living room", true],
    ]);

    const latest = SaveListResponseSchema.parse(
      (await deviceGet(living, `/saves?app=${APP}&latest=1`)).json(),
    );
    expect(latest.backups.map((b) => b.device)).toEqual(["Travel", "Living room"]);

    expect((await deviceGet(living, "/saves?app=nope")).statusCode).toBe(400);
  });

  it("keeps the configured number of backups per save, plus pinned ones", async () => {
    await start();
    const token = await pair("3f2b8c1e-9a4d-4e7b-8c21-5d6f0a1b2c3d", "Living room");
    const settings = await web("PUT", "/settings", { body: { saveBackupsKeep: 2 } });
    expect(settings.json<ServerSettings>().saveBackupsKeep).toBe(2);

    const ids: number[] = [];
    for (const seed of ["a", "b"]) {
      now += 1000;
      ids.push((await upload(token, archive(seed))).json().backup.id);
    }
    const pinned = await web("PATCH", `/saves/${ids[0]}`, { body: { pinned: true } });
    expect(pinned.json<SaveBackup>().pinned).toBe(true);
    for (const seed of ["c", "d", "e"]) {
      now += 1000;
      ids.push((await upload(token, archive(seed))).json().backup.id);
    }
    // The pinned first backup plus the two newest.
    const kept = server.saves.list().map((row) => row.id);
    expect(kept).toEqual([ids[4], ids[3], ids[0]]);
    for (const id of [ids[1], ids[2]]) {
      expect(existsSync(join(dir, "data", "saves", APP, `${id}.tar`))).toBe(false);
    }

    // Lowering the limit applies at once.
    await web("PUT", "/settings", { body: { saveBackupsKeep: 1 } });
    expect(server.saves.list().map((row) => row.id)).toEqual([ids[4], ids[0]]);

    // 0 keeps everything.
    await web("PUT", "/settings", { body: { saveBackupsKeep: 0 } });
    for (const seed of ["f", "g", "h"]) {
      now += 1000;
      await upload(token, archive(seed));
    }
    expect(server.saves.list()).toHaveLength(5);
    expect((await web("GET", "/settings")).json<ServerSettings>().saveBackupsKeep).toBe(0);
    expect((await web("PUT", "/settings", { body: { saveBackupsKeep: -1 } })).statusCode).toBe(400);
  });

  it("never deletes a backup while restoring one, and counts pre-restore backups apart", async () => {
    await start();
    const token = await pair("3f2b8c1e-9a4d-4e7b-8c21-5d6f0a1b2c3d", "Living room");
    await web("PUT", "/settings", { body: { saveBackupsKeep: 2 } });
    const ids: number[] = [];
    for (const seed of ["a", "b"]) {
      now += 1000;
      ids.push((await upload(token, archive(seed))).json().backup.id);
    }

    // Restoring the oldest kept backup first uploads the save it replaces.
    for (const seed of ["c", "d", "e"]) {
      now += 1000;
      const res = await upload(token, archive(seed), { origin: "pre-restore" });
      expect(res.statusCode).toBe(201);
      ids.push(res.json().backup.id);
    }
    expect((await deviceGet(token, `/saves/${ids[0]}/data`)).statusCode).toBe(200);
    expect(server.saves.list()).toHaveLength(5);

    // The next manual backup prunes each kind to the setting on its own.
    now += 1000;
    ids.push((await upload(token, archive("f"))).json().backup.id);
    expect(server.saves.list().map((row) => row.id)).toEqual([ids[5], ids[4], ids[3], ids[1]]);
  });

  it("counts a manual backup that matches a pre-restore one as manual", async () => {
    await start();
    const token = await pair("3f2b8c1e-9a4d-4e7b-8c21-5d6f0a1b2c3d", "Living room");
    await web("PUT", "/settings", { body: { saveBackupsKeep: 1 } });
    now += 1000;
    const older = (await upload(token, archive("a"))).json().backup.id as number;

    // A restore that stopped before writing leaves the save as its pre-restore backup has it.
    now += 1000;
    const before = (await upload(token, archive("b"), { origin: "pre-restore" })).json().backup;
    expect(before.origin).toBe("pre-restore");

    now += 1000;
    const manual = await upload(token, archive("b"));
    expect(manual.statusCode).toBe(200);
    expect(manual.json()).toMatchObject({ dup: true, backup: { id: before.id, origin: "manual" } });
    // Now the newest manual backup, it pushes the older one out under a limit of 1.
    expect(server.saves.list().map((row) => [row.id, row.origin])).toEqual([[before.id, "manual"]]);
    expect(server.saves.list().some((row) => row.id === older)).toBe(false);

    // A pre-restore upload of the same bytes leaves a manual backup as it is.
    now += 1000;
    const again = await upload(token, archive("b"), { origin: "pre-restore" });
    expect(again.json()).toMatchObject({ dup: true, backup: { id: before.id, origin: "manual" } });
  });

  it("puts back a missing archive when the same bytes are uploaded again", async () => {
    await start();
    const token = await pair("3f2b8c1e-9a4d-4e7b-8c21-5d6f0a1b2c3d", "Living room");
    const body = archive("one");
    const first = (await upload(token, body)).json().backup;
    const path = join(dir, "data", "saves", APP, `${first.id}.tar`);
    await rm(path);
    expect((await deviceGet(token, `/saves/${first.id}/data`)).statusCode).toBe(410);

    now += 1000;
    const again = await upload(token, body);
    expect(again.statusCode).toBe(200);
    expect(again.json().dup).toBe(true);
    const data = await deviceGet(token, `/saves/${first.id}/data`);
    expect(data.statusCode).toBe(200);
    expect(data.rawPayload.equals(body)).toBe(true);
  });

  it("lists, downloads, annotates and deletes backups in the web API", async () => {
    await start();
    const token = await pair("3f2b8c1e-9a4d-4e7b-8c21-5d6f0a1b2c3d", "Living room");
    const body = archive("one");
    const id = (await upload(token, body, { name: "Harbor Watch" })).json().backup.id as number;
    now += 1000;
    await upload(token, archive("x"), { app: OTHER_APP, type: "device", user: "", userName: "" });

    const list = (await web("GET", "/saves")).json<SaveBackup[]>();
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({
      id,
      applicationId: APP,
      name: "Harbor Watch",
      iconUrl: null,
      inLibrary: false,
      userId: USER,
      userName: "Player",
      deviceName: "Living room",
      fileCount: 2,
      createdAt: 1_790_000_000_000,
    });
    // Neither in the library nor named by the console: the title ID stands in.
    expect(list[0]?.name).toBe(OTHER_APP);
    expect((await web("GET", `/saves?app=${APP}`)).json<SaveBackup[]>()).toHaveLength(1);

    // A renamed console shows its new name.
    const deviceId = list[1]?.deviceId;
    await web("PATCH", `/devices/${deviceId}`, { body: { name: "Den" } });
    expect((await web("GET", `/saves?app=${APP}`)).json<SaveBackup[]>()[0]?.deviceName).toBe("Den");

    const download = await web("GET", `/saves/${id}/download`);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(body)).toBe(true);
    expect(download.headers["content-type"]).toBe("application/x-tar");
    expect(download.headers["content-disposition"]).toBe(
      "attachment; filename=\"Harbor Watch - Player - 2026-09-21 14-13-20.tar\"; filename*=UTF-8''Harbor%20Watch%20-%20Player%20-%202026-09-21%2014-13-20.tar",
    );

    const noted = await web("PATCH", `/saves/${id}`, { body: { note: "  Before the boss  " } });
    expect(noted.json<SaveBackup>().note).toBe("Before the boss");
    const cleared = await web("PATCH", `/saves/${id}`, { body: { note: "" } });
    expect(cleared.json<SaveBackup>().note).toBeNull();
    expect((await web("PATCH", "/saves/999", { body: { pinned: true } })).statusCode).toBe(404);

    expect((await web("DELETE", `/saves/${id}`)).statusCode).toBe(204);
    expect(existsSync(join(dir, "data", "saves", APP, `${id}.tar`))).toBe(false);
    expect((await web("GET", `/saves/${id}/download`)).statusCode).toBe(404);
    expect((await web("DELETE", `/saves/${id}`)).statusCode).toBe(404);
  });

  it("names a game from the library over the name the console sent", async () => {
    await start();
    const library = join(dir, "library");
    await mkdir(library, { recursive: true });
    await writeFile(
      join(library, `Lighthouse Keeper [${APP}][v0].nsp`),
      fakeNsp({ tickets: [APP] }),
    );
    const root = server.repo.createRoot({ path: library, label: "games" });
    await server.scanner.scanRoot(root.id);
    const token = await pair("3f2b8c1e-9a4d-4e7b-8c21-5d6f0a1b2c3d", "Living room");
    await upload(token, archive("one"), { name: "Console name" });
    const [backup] = (await web("GET", "/saves")).json<SaveBackup[]>();
    expect(backup).toMatchObject({ name: "Lighthouse Keeper", inLibrary: true });
  });

  it("needs a signed-in session for the web API", async () => {
    await start();
    session = "";
    expect((await web("GET", "/saves")).statusCode).toBe(401);
  });

  it("reports an archive removed from the data folder", async () => {
    await start();
    const token = await pair("3f2b8c1e-9a4d-4e7b-8c21-5d6f0a1b2c3d", "Living room");
    const id = (await upload(token, archive("one"))).json().backup.id as number;
    const { rm } = await import("node:fs/promises");
    await rm(join(dir, "data", "saves", APP, `${id}.tar`));
    expect((await deviceGet(token, `/saves/${id}/data`)).json().error.code).toBe("FILE_MISSING");
  });

  it("clears half-written uploads on start", async () => {
    await mkdir(join(dir, "data", "saves", ".incoming"), { recursive: true });
    await writeFile(join(dir, "data", "saves", ".incoming", "leftover.tar"), "partial");
    await start();
    expect(await readdir(join(dir, "data", "saves", ".incoming"))).toEqual([]);
  });

  it("names downloads safely", () => {
    const backup = {
      name: 'A: "Tale" / of <Two>',
      type: "account",
      userName: "Zoë",
      userId: USER,
      createdAt: Date.UTC(2026, 8, 25, 9, 5, 7),
    } as SaveBackup;
    expect(archiveFileName(backup)).toBe("A_ _Tale_ _ of _Two_ - Zoë - 2026-09-25 09-05-07.tar");
    expect(archiveFileName({ ...backup, type: "device", userName: null })).toMatch(/ - device - /);
  });
});
