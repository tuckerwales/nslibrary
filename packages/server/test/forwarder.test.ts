import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatProdKeys, generateFakeKeyset } from "@nslib/fixtures";
import { BufferReader, listContainerEntries } from "@nslib/formats";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/auth/auth-service";
import { packForwarderWithFakeKeys } from "../src/forwarder";
import { createServer, type NslibServer } from "../src/server";
import { makeTempDir, removeDir, testConfig } from "./helpers";

describe("HOME-menu forwarder NSP", () => {
  it("packs a parseable NSP with program, control, and meta NCAs", async () => {
    const nsp = packForwarderWithFakeKeys();
    const entries = await listContainerEntries(new BufferReader(nsp), "nsp");
    const names = entries.map((e) => e.name);
    expect(names.some((n) => n.endsWith(".cnmt.nca"))).toBe(true);
    expect(names.filter((n) => n.endsWith(".nca") && !n.endsWith(".cnmt.nca")).length).toBe(2);
  });
});

describe("forwarder HTTP", () => {
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

  it("refuses to pack without keys and downloads an NSP after keys are saved", async () => {
    const setup = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { username: "admin", password: "correct horse" },
    });
    const cookie = setup.cookies.find((c) => c.name === SESSION_COOKIE);
    if (!cookie) throw new Error("no session");

    const missing = await server.app.inject({
      method: "POST",
      url: "/api/v1/forwarder",
      cookies: { [SESSION_COOKIE]: cookie.value },
      payload: {},
    });
    expect(missing.statusCode).toBe(400);

    const keys = generateFakeKeyset("web-forwarder");
    await server.app.inject({
      method: "PUT",
      url: "/api/v1/keys",
      cookies: { [SESSION_COOKIE]: cookie.value },
      payload: { contents: formatProdKeys(keys) },
    });

    const packed = await server.app.inject({
      method: "POST",
      url: "/api/v1/forwarder",
      cookies: { [SESSION_COOKIE]: cookie.value },
      payload: { name: "NSLibrary" },
    });
    expect(packed.statusCode).toBe(200);
    expect(packed.headers["content-type"]).toMatch(/octet-stream/);
    expect(packed.rawPayload.length).toBeGreaterThan(0x400);
    await writeFile(join(dir, "NSLibrary.nsp"), packed.rawPayload);
  });
});
