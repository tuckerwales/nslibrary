import { execFileSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server";
import { makeTempDir, removeDir, testConfig } from "./helpers";

function getJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("optional HTTPS", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await removeDir(dir);
  });

  it("serves /api/health over TLS", async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    const key = join(dir, "key.pem");
    const cert = join(dir, "cert.pem");
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=localhost",
    ]);
    const server = await createServer(
      testConfig(join(dir, "data"), { tlsKey: key, tlsCert: cert, port: 0 }),
    );
    try {
      await server.app.listen({ host: "127.0.0.1", port: 0 });
      const address = server.app.server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const res = await getJson(address.port, "/api/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(server.devices.tls).toBe(true);
    } finally {
      await server.close();
    }
  });
});
