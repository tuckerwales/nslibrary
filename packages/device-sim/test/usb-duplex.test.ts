import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsbDeviceClient } from "@nslib/device-sim";
import { buildPfs0, deterministicBytes } from "@nslib/fixtures";
import { buildSaveArchive } from "@nslib/formats";
import { createServer, DeviceUsbHandler } from "@nslib/server";
import {
  encodeFrame,
  FrameKind,
  HelloResponseSchema,
  PairResponseSchema,
  SaveListResponseSchema,
  SaveUploadResponseSchema,
} from "@nslib/shared";
import { MemoryDuplex, UsbLink } from "@nslib/usb-host";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  }
});

describe("USB device-sim over in-memory duplex", () => {
  it("auto-trusts a Switch, serves hello and a Range GET", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nslib-usb-"));
    dirs.push(dir);
    const library = join(dir, "lib");
    await mkdir(library);
    const nsp = buildPfs0([{ name: "a.cnmt.nca", data: deterministicBytes("meta", 0x40) }]);
    await writeFile(join(library, "game.nsp"), nsp);

    const server = await createServer({
      dataDir: join(dir, "data"),
      databaseFile: ":memory:",
      host: "127.0.0.1",
      port: 0,
      webDir: null,
      forcePolling: true,
      pollIntervalMs: 50,
      stabilityThresholdMs: 100,
      logLevel: false,
      trustProxy: false,
      seed: false,
      seedLibraryDir: null,
      seedKeysPath: null,
      setupToken: null,
      serverName: "test",
      discoveryPort: null,
      usb: false,
      libraryScanDir: null,
      tlsKey: null,
      tlsCert: null,
      nroPath: null,
      forwarderMainPath: null,
      log: () => {},
    });
    const root = server.repo.createRoot({ path: library, label: "usb" });
    await server.scanner.scanRoot(root.id);
    const files = server.repo.listRootFiles(root.id);
    expect(files.length).toBe(1);

    const duplex = new MemoryDuplex();
    const link = new UsbLink(duplex.a, {
      handler: new DeviceUsbHandler(
        server.devices,
        join(dir, "data", "cache", "icons"),
        server.saves,
      ),
      idleMs: 0,
    });
    const running = link.run();
    const client = new UsbDeviceClient(duplex.b);
    const device = {
      deviceUuid: randomUUID(),
      name: "USB Switch",
      fw: "19.0.1",
      amsVersion: "1.8.0",
      appVersion: "0.1.0",
    };
    const hello = PairResponseSchema.parse(await client.usbHello(device));
    expect(hello.token).toHaveLength(43);

    const info = HelloResponseSchema.parse(await client.hello());
    expect(info.serverName).toBe("test");

    await client.ping();

    const file = await client.exchange("GET", `/files/${files[0]!.id}`, {
      headers: { range: "bytes=0-3" },
    });
    expect(file.status).toBe(206);
    expect(Buffer.from(file.payload).toString("latin1")).toBe("PFS0");

    const { bytesIn, bytesOut, elapsedMs } = link.stats();
    expect(bytesIn).toBeGreaterThan(0);
    expect(bytesOut).toBeGreaterThan(0);
    expect(elapsedMs).toBeGreaterThanOrEqual(0);

    link.stop();
    await running.catch(() => undefined);
    await server.close();
  });

  it("refuses USB hello when pairing is required", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nslib-usb-pair-"));
    dirs.push(dir);
    const server = await createServer({
      dataDir: join(dir, "data"),
      databaseFile: ":memory:",
      host: "127.0.0.1",
      port: 0,
      webDir: null,
      forcePolling: true,
      pollIntervalMs: 50,
      stabilityThresholdMs: 100,
      logLevel: false,
      trustProxy: false,
      seed: false,
      seedLibraryDir: null,
      seedKeysPath: null,
      setupToken: null,
      serverName: "test",
      discoveryPort: null,
      usb: false,
      libraryScanDir: null,
      tlsKey: null,
      tlsCert: null,
      nroPath: null,
      forwarderMainPath: null,
      log: () => {},
    });
    server.devices.updateSettings({ requireUsbPairing: true });
    const duplex = new MemoryDuplex();
    const link = new UsbLink(duplex.a, {
      handler: new DeviceUsbHandler(server.devices, join(dir, "icons"), server.saves),
      idleMs: 0,
    });
    const running = link.run();
    const client = new UsbDeviceClient(duplex.b);
    await expect(
      client.usbHello({
        deviceUuid: randomUUID(),
        name: "USB Switch",
        fw: "19.0.1",
        amsVersion: "1.8.0",
        appVersion: "0.1.0",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    link.stop();
    await running.catch(() => undefined);
    await server.close();
  });

  it("marks a running job interrupted when USB unplugs, then resumes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nslib-usb-unplug-"));
    dirs.push(dir);
    const library = join(dir, "lib");
    await mkdir(library);
    const nsp = buildPfs0([{ name: "a.cnmt.nca", data: deterministicBytes("meta", 0x40) }]);
    await writeFile(join(library, "game [0100ABCDEF012000][v0].nsp"), nsp);
    const server = await createServer({
      dataDir: join(dir, "data"),
      databaseFile: ":memory:",
      host: "127.0.0.1",
      port: 0,
      webDir: null,
      forcePolling: true,
      pollIntervalMs: 50,
      stabilityThresholdMs: 100,
      logLevel: false,
      trustProxy: false,
      seed: false,
      seedLibraryDir: null,
      seedKeysPath: null,
      setupToken: null,
      serverName: "test",
      discoveryPort: null,
      usb: false,
      libraryScanDir: null,
      tlsKey: null,
      tlsCert: null,
      nroPath: null,
      forwarderMainPath: null,
      log: () => {},
    });
    const root = server.repo.createRoot({ path: library, label: "usb" });
    await server.scanner.scanRoot(root.id);
    const file = server.repo.listRootFiles(root.id)[0];
    if (!file) throw new Error("expected scanned file");
    const meta = server.sqlite
      .prepare("select id from content_metas where file_id = ?")
      .get(file.id) as { id: number } | undefined;
    if (!meta) throw new Error("expected content meta");

    const duplex = new MemoryDuplex();
    const link = new UsbLink(duplex.a, {
      handler: new DeviceUsbHandler(
        server.devices,
        join(dir, "data", "cache", "icons"),
        server.saves,
      ),
      idleMs: 0,
    });
    const running = link.run();
    const client = new UsbDeviceClient(duplex.b);
    await client.usbHello({
      deviceUuid: randomUUID(),
      name: "USB Switch",
      fw: "19.0.1",
      amsVersion: "1.8.0",
      appVersion: "0.1.0",
    });
    const created = await client.exchange("POST", "/jobs", {
      body: { contentMetaId: meta.id, target: "sd" },
    });
    const job = created.json.b as { id: number };
    await client.exchange("POST", `/jobs/${job.id}/claim`);
    duplex.a.close();
    await running.catch(() => undefined);
    const listed = server.devices.listJobs();
    expect(listed[0]?.status).toBe("interrupted");
    const resumed = server.devices.resumeJob(listed[0]!.id);
    expect(resumed.status).toBe("queued");
    await server.close();
  });

  it("uploads, lists and downloads save backups over USB", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nslib-usb-saves-"));
    dirs.push(dir);
    const server = await createServer({
      dataDir: join(dir, "data"),
      databaseFile: ":memory:",
      host: "127.0.0.1",
      port: 0,
      webDir: null,
      forcePolling: true,
      pollIntervalMs: 50,
      stabilityThresholdMs: 100,
      logLevel: false,
      trustProxy: false,
      seed: false,
      seedLibraryDir: null,
      seedKeysPath: null,
      setupToken: null,
      serverName: "test",
      discoveryPort: null,
      usb: false,
      libraryScanDir: null,
      tlsKey: null,
      tlsCert: null,
      nroPath: null,
      forwarderMainPath: null,
      saveMaxBytes: 4 * 1024 * 1024,
      log: () => {},
    });
    const duplex = new MemoryDuplex();
    const link = new UsbLink(duplex.a, {
      handler: new DeviceUsbHandler(server.devices, join(dir, "icons"), server.saves),
      idleMs: 0,
      maxRequestPayload: 5 * 1024 * 1024,
    });
    const running = link.run();
    const client = new UsbDeviceClient(duplex.b);
    await client.usbHello({
      deviceUuid: randomUUID(),
      name: "USB Switch",
      fw: "19.0.1",
      amsVersion: "1.8.0",
      appVersion: "0.1.0",
    });
    expect(HelloResponseSchema.parse(await client.hello()).caps).toContain("saves");

    // Bigger than one 1 MiB USB chunk, so the payload arrives in pieces.
    const archive = buildSaveArchive([
      { path: "save.dat", data: deterministicBytes("save", 3 * 1024 * 1024 + 17) },
      { path: "profile/name.txt", data: Buffer.from("Zoë") },
    ]);
    const stored = SaveUploadResponseSchema.parse(
      await client.uploadSave(archive, {
        app: "0100ABCDEF010000",
        type: "account",
        user: "0123456789ABCDEF0FEDCBA987654321",
        userName: "Zoë",
        name: "Café Story",
      }),
    );
    expect(stored).toMatchObject({ dup: false, backup: { userName: "Zoë", device: "USB Switch" } });
    expect(stored.backup.sha256).toBe(createHash("sha256").update(archive).digest("hex"));

    const again = await client.uploadSave(archive, {
      app: "0100ABCDEF010000",
      type: "account",
      user: "0123456789ABCDEF0FEDCBA987654321",
      origin: "pre-restore",
    });
    expect(again.dup).toBe(true);

    await expect(
      client.uploadSave(archive, {
        app: "0100ABCDEF010000",
        type: "device",
        sha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "SAVE_INVALID", status: 422 });

    const list = SaveListResponseSchema.parse(await client.listSaves({ app: "0100abcdef010000" }));
    expect(list.backups.map((b) => [b.id, b.mine])).toEqual([[stored.backup.id, true]]);

    const whole = await client.exchange("GET", `/saves/${stored.backup.id}/data`);
    expect(whole.status).toBe(200);
    expect(Buffer.from(whole.payload).equals(archive)).toBe(true);
    const part = await client.exchange("GET", `/saves/${stored.backup.id}/data`, {
      headers: { range: "bytes=1048576-2097151" },
    });
    expect(part.status).toBe(206);
    expect(Buffer.from(part.payload).equals(archive.subarray(1048576, 2097152))).toBe(true);
    await expect(client.exchange("GET", "/saves/999/data")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    // Over the server's archive limit: rejected by the save service.
    const big = buildSaveArchive([{ path: "big", data: Buffer.alloc(4 * 1024 * 1024 + 1) }]);
    await expect(
      client.uploadSave(big, { app: "0100ABCDEF010000", type: "device" }),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });

    // Over the link's own limit: drained and refused, and the next request still lines up.
    await duplex.b.write(
      encodeFrame({
        kind: FrameKind.Request,
        requestId: 900,
        json: { m: "POST", p: "/saves?app=0100ABCDEF010000&type=device" },
        payload: new Uint8Array(6 * 1024 * 1024),
      }),
    );
    const { decodeFrameHeader, USB_FRAME_HEADER_SIZE } = await import("@nslib/shared");
    const header = decodeFrameHeader(await duplex.b.readExact(USB_FRAME_HEADER_SIZE));
    expect(header.status).toBe(413);
    const body = JSON.parse(
      new TextDecoder().decode(await duplex.b.readExact(header.jsonLength)),
    ) as { b: { error: { code: string } } };
    expect(body.b.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(HelloResponseSchema.parse(await client.hello()).serverName).toBe("test");

    link.stop();
    await running.catch(() => undefined);
    await server.close();
  });
});
