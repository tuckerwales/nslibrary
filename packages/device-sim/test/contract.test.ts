import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPfs0, buildTicket, deterministicBytes, rightsIdFor } from "@nslib/fixtures";
import { createServer, type ServerConfig } from "@nslib/server";
import {
  CatalogResponseSchema,
  ErrorBodySchema,
  EventsResponseSchema,
  HelloResponseSchema,
  PairResponseSchema,
} from "@nslib/shared";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceClient } from "../src/client";

const makeTempDir = () => mkdtemp(join(tmpdir(), "nslib-sim-"));
const removeDir = (dir: string) => rm(dir, { recursive: true, force: true });

function fakeNsp(titleId: string): Buffer {
  const rightsId = rightsIdFor(titleId, 0x0b);
  const ncaId = deterministicBytes("meta-id", 16).toString("hex");
  return buildPfs0([
    { name: `${ncaId}.cnmt.nca`, data: deterministicBytes("meta", 0x200) },
    {
      name: `${rightsId.toLowerCase()}.tik`,
      data: buildTicket({ rightsId, keyGeneration: 0x0b }),
    },
  ]);
}

function testConfig(dataDir: string): ServerConfig {
  return {
    dataDir,
    databaseFile: ":memory:",
    host: "127.0.0.1",
    port: 0,
    webDir: null,
    forcePolling: true,
    pollIntervalMs: 50,
    stabilityThresholdMs: 100,
    logLevel: false,
    trustProxy: false,
    serverName: "sim",
    discoveryPort: null,
    seed: false,
    seedLibraryDir: null,
    seedKeysPath: null,
    log: () => {},
  };
}

async function listenUrl(server: Awaited<ReturnType<typeof createServer>>): Promise<string> {
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const address = server.app.server.address();
  if (!address || typeof address === "string") throw new Error("no listen port");
  return `http://127.0.0.1:${address.port}`;
}

async function setupAdmin(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "correct horse" }),
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("no session cookie");
  const session = cookie.split(";")[0];
  if (!session) throw new Error("no session cookie");
  return session;
}

function web(baseUrl: string, cookie: string, method: string, path: string, body?: unknown) {
  return fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("device-sim contract", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) await removeDir(dir);
  });

  it("talks HTTP like a Switch against a live server", async () => {
    dir = await makeTempDir();
    const server = await createServer(testConfig(join(dir, "data")));
    const baseUrl = await listenUrl(server);
    try {
      const cookie = await setupAdmin(baseUrl);
      const library = join(dir, "library");
      await mkdir(library, { recursive: true });
      const bytes = fakeNsp("0100ABCDEF012000");
      await writeFile(join(library, "Example [0100ABCDEF012000][v0].nsp"), bytes);
      const root = (await (
        await web(baseUrl, cookie, "POST", "/roots", { path: library })
      ).json()) as {
        id: number;
      };
      await server.scanner.scanRoot(root.id);

      const { code } = (await (
        await web(baseUrl, cookie, "POST", "/devices/pairing-code")
      ).json()) as {
        code: string;
      };
      const client = new DeviceClient(baseUrl);
      const paired = await client.pair({
        code,
        deviceUuid: randomUUID(),
        name: "sim",
        fw: "19.0.1",
        amsVersion: "1.8.0",
        appVersion: "0.1.0",
      });
      expect(PairResponseSchema.parse(paired)).toEqual(paired);

      const hello = await client.hello();
      expect(HelloResponseSchema.parse(hello)).toEqual(hello);

      const catalog = await client.catalog();
      expect(CatalogResponseSchema.parse(catalog)).toEqual(catalog);
      expect(catalog.apps).toHaveLength(1);

      const events = await client.events({ wait: 0 });
      expect(EventsResponseSchema.parse(events)).toEqual(events);

      const detail = (await (
        await web(baseUrl, cookie, "GET", "/apps/0100ABCDEF012000")
      ).json()) as { contents: { files: { id: number }[] }[] };
      const fileId = detail.contents[0]?.files[0]?.id;
      if (fileId === undefined) throw new Error("missing file");

      const ranged = await client.getFile(fileId, { range: "bytes=0-7" });
      expect(ranged.status).toBe(206);
      expect(Buffer.from(await ranged.arrayBuffer()).equals(bytes.subarray(0, 8))).toBe(true);

      const unsat = await client.getFile(fileId, { range: `bytes=${bytes.length}-` });
      expect(unsat.status).toBe(416);
      expect(ErrorBodySchema.parse(await unsat.json()).error.code).toBe("RANGE_NOT_SATISFIABLE");

      const stale = await client.getFile(fileId, { range: "bytes=0-1", ifRange: '"nope"' });
      expect(stale.status).toBe(200);

      const metaId = catalog.apps[0]?.b?.[1];
      if (metaId === undefined) throw new Error("missing content meta");
      expect(
        (
          await web(baseUrl, cookie, "POST", "/jobs", {
            deviceId: paired.deviceId,
            items: [metaId],
            target: "auto",
          })
        ).status,
      ).toBe(201);

      const seen = await client.events({ cursor: events.cursor, wait: 0 });
      expect(seen.ev.some((e) => e.t === "job.queued")).toBe(true);

      const ac = new AbortController();
      const pending = client.events({ cursor: seen.cursor, wait: 20 }, ac.signal);
      await new Promise((resolve) => setTimeout(resolve, 50));
      ac.abort();
      await expect(pending).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it("delivers a job.queued event to a waiting long-poll", async () => {
    dir = await makeTempDir();
    const server = await createServer(testConfig(join(dir, "data")));
    const baseUrl = await listenUrl(server);
    try {
      const cookie = await setupAdmin(baseUrl);
      const library = join(dir, "library");
      await mkdir(library, { recursive: true });
      await writeFile(
        join(library, "Example [0100ABCDEF012000][v0].nsp"),
        fakeNsp("0100ABCDEF012000"),
      );
      const root = (await (
        await web(baseUrl, cookie, "POST", "/roots", { path: library })
      ).json()) as {
        id: number;
      };
      await server.scanner.scanRoot(root.id);
      const { code } = (await (
        await web(baseUrl, cookie, "POST", "/devices/pairing-code")
      ).json()) as { code: string };
      const client = new DeviceClient(baseUrl);
      const paired = await client.pair({
        code,
        deviceUuid: randomUUID(),
        name: "sim",
        fw: "19.0.1",
        amsVersion: "1.8.0",
        appVersion: "0.1.0",
      });
      const catalog = await client.catalog();
      const primed = await client.events({ wait: 0 });
      const waiting = client.events({ cursor: primed.cursor, wait: 8 });
      await new Promise((resolve) => setTimeout(resolve, 80));
      await web(baseUrl, cookie, "POST", "/jobs", {
        deviceId: paired.deviceId,
        items: [catalog.apps[0]?.b?.[1]],
        target: "sd",
      });
      const delivered = await waiting;
      expect(delivered.ev.some((e) => e.t === "job.queued")).toBe(true);
    } finally {
      await server.close();
    }
  });
});
