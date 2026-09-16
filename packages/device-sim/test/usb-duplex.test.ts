import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsbDeviceClient } from "@nslib/device-sim";
import { buildPfs0, deterministicBytes } from "@nslib/fixtures";
import { createServer, DeviceUsbHandler } from "@nslib/server";
import { HelloResponseSchema, PairResponseSchema } from "@nslib/shared";
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
      serverName: "test",
      discoveryPort: null,
      usb: false,
      libraryScanDir: null,
      log: () => {},
    });
    const root = server.repo.createRoot({ path: library, label: "usb" });
    await server.scanner.scanRoot(root.id);
    const files = server.repo.listRootFiles(root.id);
    expect(files.length).toBe(1);

    const duplex = new MemoryDuplex();
    const link = new UsbLink(duplex.a, {
      handler: new DeviceUsbHandler(server.devices, join(dir, "data", "cache", "icons")),
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
      serverName: "test",
      discoveryPort: null,
      usb: false,
      libraryScanDir: null,
      log: () => {},
    });
    server.devices.updateSettings({ requireUsbPairing: true });
    const duplex = new MemoryDuplex();
    const link = new UsbLink(duplex.a, {
      handler: new DeviceUsbHandler(server.devices, join(dir, "icons")),
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
});
