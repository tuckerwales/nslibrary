import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CatalogResponseSchema,
  type DeviceDetail,
  type DeviceSummary,
  HelloResponseSchema,
  type Job,
  type LibraryRoot,
  type PairingCode,
  PairResponseSchema,
  type WebJob,
} from "@nslib/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/auth/auth-service";
import { createServer, type NslibServer } from "../src/server";
import { fakeNsp, makeTempDir, removeDir, testConfig } from "./helpers";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const UUID = "3f2b8c1e-9a4d-4e7b-8c21-5d6f0a1b2c3d";
const UUID2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BASE = "0100ABCDEF012000";

describe("device API", () => {
  let dir: string;
  let server: NslibServer;
  let now: number;

  beforeEach(async () => {
    dir = await makeTempDir();
    now = 1_700_000_000_000;
    server = await createServer(testConfig(join(dir, "data")), { now: () => now });
  });

  afterEach(async () => {
    await server.close();
    await removeDir(dir);
  });

  function web(method: Method, url: string, options: { body?: unknown; session?: string } = {}) {
    return server.app.inject({
      method,
      url: `/api/v1${url}`,
      ...(options.body === undefined ? {} : { payload: options.body as object }),
      ...(options.session ? { cookies: { [SESSION_COOKIE]: options.session } } : {}),
    });
  }

  function device(
    method: Method,
    url: string,
    options: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
  ) {
    return server.app.inject({
      method,
      url: `/api/device/v1${url}`,
      ...(options.body === undefined ? {} : { payload: options.body as object }),
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
    });
  }

  async function setUp(): Promise<string> {
    const res = await web("POST", "/auth/setup", {
      body: { username: "admin", password: "correct horse" },
    });
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    if (!cookie) throw new Error("no session cookie");
    return cookie.value;
  }

  async function pair(
    session: string,
    options: { uuid?: string; name?: string; code?: string } = {},
  ) {
    const code =
      options.code ??
      (await web("POST", "/devices/pairing-code", { session })).json<PairingCode>().code;
    return device("POST", "/pair", {
      body: {
        code,
        deviceUuid: options.uuid ?? UUID,
        name: options.name ?? "Living room",
        fw: "19.0.1",
        amsVersion: "1.8.0",
        appVersion: "0.1.0",
      },
    });
  }

  async function addGame(
    session: string,
  ): Promise<{ fileId: number; contentMetaId: number; nsp: Buffer }> {
    const library = join(dir, "library");
    await mkdir(library, { recursive: true });
    const nsp = fakeNsp({ tickets: [BASE], seed: "device" });
    await writeFile(join(library, `Example [${BASE}][v0].nsp`), nsp);
    const root = (
      await web("POST", "/roots", { session, body: { path: library } })
    ).json<LibraryRoot>();
    await server.scanner.scanRoot(root.id);
    const detail = (await web("GET", `/apps/${BASE}`, { session })).json<{
      contents: { contentMetaId: number; files: { id: number }[] }[];
    }>();
    const content = detail.contents[0];
    const fileId = content?.files[0]?.id;
    if (!content || fileId === undefined) throw new Error("expected scanned content");
    return { fileId, contentMetaId: content.contentMetaId, nsp };
  }

  it("pairs with a web-issued code and never returns the token later", async () => {
    const session = await setUp();
    expect((await device("POST", "/pair", { body: { code: "000000" } })).statusCode).toBe(400);

    const issued = (await web("POST", "/devices/pairing-code", { session })).json<PairingCode>();
    expect(issued.code).toMatch(/^\d{6}$/);

    const wrong = await pair(session, { code: issued.code === "000000" ? "000001" : "000000" });
    expect(wrong.json().error.code).toBe("PAIR_CODE_INVALID");

    const published: unknown[] = [];
    const stop = server.events.subscribe((event) => published.push(event));
    const res = await pair(session, { code: issued.code });
    stop();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(PairResponseSchema.parse(body)).toEqual(body);
    expect(published).toContainEqual({
      type: "device.paired",
      deviceId: body.deviceId,
      name: "Living room",
    });
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const listed = (await web("GET", "/devices", { session })).json<DeviceSummary[]>();
    expect(listed).toMatchObject([{ name: "Living room", uuid: UUID, revoked: false }]);
    expect(JSON.stringify(listed)).not.toContain(body.token);

    const hello = await device("GET", "/hello", { token: body.token });
    expect(hello.statusCode).toBe(200);
    expect(HelloResponseSchema.parse(hello.json())).toEqual(hello.json());
    expect(hello.json().serverName).toBe("test");
    expect(hello.json().caps).toContain("events");
    expect(hello.json().caps).toContain("resume");
    expect(hello.json().appLatest).toBe("0.1.0");
  });

  it("expires pairing codes and rate-limits guesses", async () => {
    const session = await setUp();
    const issued = (await web("POST", "/devices/pairing-code", { session })).json<PairingCode>();
    now += 6 * 60 * 1000;
    const expired = await pair(session, { code: issued.code });
    expect(expired.json().error.code).toBe("PAIR_CODE_EXPIRED");

    const next = (await web("POST", "/devices/pairing-code", { session })).json<PairingCode>();
    for (let i = 0; i < 5; i++) {
      const res = await pair(session, { code: next.code === "111111" ? "222222" : "111111" });
      expect(["PAIR_CODE_INVALID", "PAIR_RATE_LIMITED"]).toContain(res.json().error.code);
    }
    const limited = await pair(session, { code: next.code });
    expect(limited.json().error.code).toBe("PAIR_RATE_LIMITED");
  });

  it("rejects revoked tokens and allows re-pairing the same console", async () => {
    const session = await setUp();
    const first = (await pair(session)).json();
    const id = first.deviceId as number;
    expect((await web("POST", `/devices/${id}/revoke`, { session })).statusCode).toBe(200);
    expect((await device("GET", "/hello", { token: first.token })).json().error.code).toBe(
      "DEVICE_REVOKED",
    );

    const again = (await pair(session, { name: "Back" })).json();
    expect(again.deviceId).toBe(id);
    expect((await device("GET", "/hello", { token: again.token })).statusCode).toBe(200);
    expect((await web("GET", "/devices", { session })).json<DeviceSummary[]>()[0]).toMatchObject({
      name: "Back",
      revoked: false,
    });
  });

  it("returns a compact catalog and an empty delta when since matches", async () => {
    const session = await setUp();
    const { token } = (await pair(session)).json();
    await addGame(session);

    const full = await device("GET", "/catalog", { token });
    expect(full.statusCode).toBe(200);
    const catalog = CatalogResponseSchema.parse(full.json());
    expect(catalog.full).toBe(true);
    expect(catalog.apps).toHaveLength(1);
    expect(catalog.apps[0]).toMatchObject({ i: BASE, n: "Example" });
    expect(catalog.apps[0]?.b?.[3]).toBe("nsp");

    const unchanged = (await device("GET", `/catalog?since=${catalog.rev}`, { token })).json();
    expect(unchanged).toEqual({ rev: catalog.rev, full: false, apps: [], del: [], next: null });

    const page = (await device("GET", "/catalog?limit=1", { token })).json();
    expect(page.apps).toHaveLength(1);
    expect(page.next).toBeNull();
  });

  it("stores a device state snapshot", async () => {
    const session = await setUp();
    const { token, deviceId } = (await pair(session)).json();
    const res = await device("PUT", "/state", {
      token,
      body: {
        fw: "19.0.1",
        ams: "1.8.0",
        space: { sd: [100, 200], nand: [10, 20] },
        titles: [[BASE, 0, "application", "sd"]],
      },
    });
    expect(res.statusCode).toBe(204);
    const detail = (await web("GET", `/devices/${deviceId}`, { session })).json<DeviceDetail>();
    expect(detail.space).toEqual({ sd: [100, 200], nand: [10, 20] });
    expect(detail.titles).toEqual([
      { titleId: BASE, version: 0, type: "application", storage: "sd", applicationId: BASE },
    ]);
  });

  it("queues jobs from the web UI and runs the device lifecycle", async () => {
    const session = await setUp();
    const { token, deviceId } = (await pair(session)).json();
    const { contentMetaId } = await addGame(session);

    const created = await web("POST", "/jobs", {
      session,
      body: { deviceId, items: [contentMetaId], target: "sd" },
    });
    expect(created.statusCode).toBe(201);
    const [job] = created.json<WebJob[]>();
    expect(job).toMatchObject({
      deviceId,
      status: "queued",
      target: "sd",
      titleId: BASE,
      source: "web",
    });

    const events = (await device("GET", "/events?wait=0", { token })).json();
    expect(events.ev.some((e: { t: string }) => e.t === "job.queued")).toBe(true);

    const claimed = (await device("POST", `/jobs/${job!.id}/claim`, { token })).json<{
      job: Job;
    }>();
    expect(claimed.job.status).toBe("claimed");

    expect(
      (
        await device("POST", `/jobs/${job!.id}/progress`, {
          token,
          body: { phase: "content", done: 10, total: 100, bps: 1 },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await device("POST", `/jobs/${job!.id}/complete`, { token, body: { ok: true } })).statusCode,
    ).toBe(204);
    const listed = (await web("GET", `/jobs?deviceId=${deviceId}`, { session })).json<WebJob[]>();
    expect(listed[0]?.status).toBe("done");
    expect(listed[0]?.source).toBe("web");
  });

  it("records installs started on the Switch", async () => {
    const session = await setUp();
    const { token, deviceId } = (await pair(session)).json();
    const { contentMetaId } = await addGame(session);
    expect(
      (await device("POST", "/jobs", { token, body: { contentMetaId, target: "nand" } }))
        .statusCode,
    ).toBe(201);
    const listed = (await web("GET", `/jobs?deviceId=${deviceId}`, { session })).json<WebJob[]>();
    expect(listed[0]).toMatchObject({ source: "switch", target: "nand", status: "queued" });
  });

  it("cancels a queued job and refuses another device's claim", async () => {
    const session = await setUp();
    const first = (await pair(session)).json();
    const { contentMetaId } = await addGame(session);
    const [job] = (
      await web("POST", "/jobs", {
        session,
        body: { deviceId: first.deviceId, items: [contentMetaId] },
      })
    ).json<WebJob[]>();

    const secondCode = (
      await web("POST", "/devices/pairing-code", { session })
    ).json<PairingCode>();
    const second = (
      await pair(session, { uuid: UUID2, name: "Other", code: secondCode.code })
    ).json();
    expect(
      (await device("POST", `/jobs/${job!.id}/claim`, { token: second.token })).json().error.code,
    ).toBe("FORBIDDEN");

    expect((await web("POST", `/jobs/${job!.id}/cancel`, { session })).statusCode).toBe(200);
    const after = (await device("GET", `/events?cursor=0&wait=0`, { token: first.token })).json();
    expect(
      after.ev.some((e: { t: string; id?: number }) => e.t === "job.cancel" && e.id === job!.id),
    ).toBe(true);
  });

  it("serves Range, suffix, If-Range, and 416 on library files", async () => {
    const session = await setUp();
    const { token } = (await pair(session)).json();
    const { fileId, nsp } = await addGame(session);

    const full = await device("GET", `/files/${fileId}`, { token });
    expect(full.statusCode).toBe(200);
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(Buffer.from(full.rawPayload).equals(nsp)).toBe(true);
    const etag = String(full.headers.etag);

    const ranged = await device("GET", `/files/${fileId}`, {
      token,
      headers: { range: "bytes=0-3" },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers["content-range"]).toBe(`bytes 0-3/${nsp.length}`);
    expect(Buffer.from(ranged.rawPayload).equals(nsp.subarray(0, 4))).toBe(true);

    const suffix = await device("GET", `/files/${fileId}`, {
      token,
      headers: { range: "bytes=-4" },
    });
    expect(suffix.statusCode).toBe(206);
    expect(Buffer.from(suffix.rawPayload).equals(nsp.subarray(nsp.length - 4))).toBe(true);

    const stale = await device("GET", `/files/${fileId}`, {
      token,
      headers: { range: "bytes=0-3", "if-range": '"deadbeef"' },
    });
    expect(stale.statusCode).toBe(200);
    expect(Buffer.from(stale.rawPayload).equals(nsp)).toBe(true);

    const fresh = await device("GET", `/files/${fileId}`, {
      token,
      headers: { range: "bytes=0-3", "if-range": etag },
    });
    expect(fresh.statusCode).toBe(206);

    const bad = await device("GET", `/files/${fileId}`, {
      token,
      headers: { range: `bytes=${nsp.length}-${nsp.length + 10}` },
    });
    expect(bad.statusCode).toBe(416);
    expect(bad.json().error.code).toBe("RANGE_NOT_SATISFIABLE");
    expect(bad.headers["content-range"]).toBe(`bytes */${nsp.length}`);

    await unlink(join(dir, "library", `Example [${BASE}][v0].nsp`));
    const missing = await device("GET", `/files/${fileId}`, { token });
    expect(missing.json().error.code).toBe("FILE_MISSING");
  });

  it("resumes an interrupted job and keeps queued jobs queued", async () => {
    const session = await setUp();
    const { token, deviceId } = (await pair(session)).json();
    const { contentMetaId } = await addGame(session);
    const [running] = (
      await web("POST", "/jobs", {
        session,
        body: { deviceId, items: [contentMetaId], target: "sd" },
      })
    ).json<WebJob[]>();
    expect((await device("POST", `/jobs/${running!.id}/claim`, { token })).statusCode).toBe(200);
    server.devices.interruptActiveJobs(deviceId, "USB unplug mid-NCA");
    const after = (await web("GET", `/jobs?deviceId=${deviceId}`, { session })).json<WebJob[]>();
    expect(after[0]?.status).toBe("interrupted");

    const resumed = await web("POST", `/jobs/${running!.id}/resume`, { session });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json<WebJob>().status).toBe("queued");
    expect(
      (await device("POST", `/jobs/${running!.id}/claim`, { token })).json<{ job: Job }>().job
        .status,
    ).toBe("claimed");
  });

  it("serves Range across split 00/01 parts", async () => {
    const session = await setUp();
    const { token } = (await pair(session)).json();
    const library = join(dir, "library");
    await mkdir(library, { recursive: true });
    const nsp = fakeNsp({ tickets: [BASE], seed: "split-range" });
    const splitDir = join(library, `Split [${BASE}][v0].nsp`);
    await mkdir(splitDir);
    await writeFile(join(splitDir, "00"), nsp.subarray(0, 32));
    await writeFile(join(splitDir, "01"), nsp.subarray(32));
    const root = (
      await web("POST", "/roots", { session, body: { path: library, label: "lib" } })
    ).json<LibraryRoot>();
    await server.scanner.scanRoot(root.id);
    const file = server.repo.listRootFiles(root.id)[0];
    expect(file?.size).toBe(nsp.length);

    const ranged = await device("GET", `/files/${file!.id}`, {
      token,
      headers: { range: "bytes=0-3" },
    });
    expect(ranged.statusCode).toBe(206);
    expect(Buffer.from(ranged.rawPayload).equals(nsp.subarray(0, 4))).toBe(true);
    const across = await device("GET", `/files/${file!.id}`, {
      token,
      headers: { range: `bytes=30-35` },
    });
    expect(across.statusCode).toBe(206);
    expect(Buffer.from(across.rawPayload).equals(nsp.subarray(30, 36))).toBe(true);
  });

  it("returns 404 for /update when no nro is configured", async () => {
    const session = await setUp();
    const { token } = (await pair(session)).json();
    const res = await device("GET", "/update", { token });
    expect(res.statusCode).toBe(404);
  });
});
