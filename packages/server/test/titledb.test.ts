import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client";
import { TitledbService } from "../src/titledb/service";
import { makeTempDir, removeDir } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const BODY = JSON.stringify({ "0100ABCDEF012000": { name: "Game", version: 65536 } });

describe("TitledbService scheduled refresh", () => {
  let dir: string;
  let http: Server;
  let requests: number;
  let now: number;
  let service: TitledbService;

  beforeEach(async () => {
    dir = await makeTempDir();
    requests = 0;
    now = 1_700_000_000_000;
    http = createServer((_req, res) => {
      requests++;
      res.setHeader("content-type", "application/json");
      res.end(BODY);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    service = new TitledbService(openDatabase(":memory:").db, () => now);
  });

  afterEach(async () => {
    await new Promise((resolve) => http.close(resolve));
    await removeDir(dir);
  });

  const url = () => `http://127.0.0.1:${(http.address() as AddressInfo).port}/titles.json`;

  it("refreshes a URL once it is older than the limit", async () => {
    service.configure({ source: url() });
    expect(await service.refreshIfStale(DAY)).toBe(true);
    expect(service.status()).toMatchObject({ titleCount: 1, lastError: null });

    now += DAY / 2;
    expect(await service.refreshIfStale(DAY)).toBe(false);
    now += DAY;
    expect(await service.refreshIfStale(DAY)).toBe(true);
    expect(requests).toBe(2);
  });

  it("shares one download between concurrent refreshes", async () => {
    service.configure({ source: url() });
    await Promise.all([service.refresh(), service.refresh(), service.refresh()]);
    expect(requests).toBe(1);
  });

  it("leaves file sources and a turned-off titledb alone", async () => {
    const path = join(dir, "titles.json");
    await writeFile(path, BODY);
    service.configure({ source: path });
    expect(await service.refreshIfStale(DAY)).toBe(false);

    service.configure({ source: url(), enabled: false });
    expect(await service.refreshIfStale(DAY)).toBe(false);
    expect(requests).toBe(0);
  });
});
