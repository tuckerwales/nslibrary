import { createSocket } from "node:dgram";
import { join } from "node:path";
import { DISCOVERY_QUERY, DiscoveryReplySchema } from "@nslib/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type NslibServer } from "../src/server";
import { makeTempDir, removeDir, testConfig } from "./helpers";

function query(port: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("discovery timed out"));
    }, 2000);
    socket.on("message", (msg) => {
      clearTimeout(timer);
      socket.close();
      resolve(JSON.parse(msg.toString("utf8")));
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });
    socket.send(DISCOVERY_QUERY, port, "127.0.0.1");
  });
}

describe("UDP discovery", () => {
  let dir: string;
  let server: NslibServer;

  beforeEach(async () => {
    dir = await makeTempDir();
    server = await createServer(
      testConfig(join(dir, "data"), { discoveryPort: 0, port: 8465, serverName: "nas" }),
    );
    await server.start();
  });

  afterEach(async () => {
    await server.close();
    await removeDir(dir);
  });

  it("replies unicast to NSLIB?1", async () => {
    const port = server.discovery?.port;
    expect(port).toBeGreaterThan(0);
    const reply = DiscoveryReplySchema.parse(await query(port as number));
    expect(reply).toMatchObject({
      name: "nas",
      port: 8465,
      proto: 1,
    });
    expect(reply.serverId).toBe(server.devices.serverId);
  });
});
