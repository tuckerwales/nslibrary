import { createSocket, type Socket } from "node:dgram";
import { DEVICE_API_PROTOCOL_VERSION, DISCOVERY_QUERY, type DiscoveryReply } from "@nslib/shared";
import type { LogFn } from "../api/context";

export interface DiscoveryOptions {
  port: number;
  reply: () => DiscoveryReply;
  log?: LogFn;
}

/** Answers LAN UDP broadcasts of `NSLIB?1` with a unicast JSON reply. */
export class DiscoveryServer {
  readonly #options: DiscoveryOptions;
  #socket: Socket | null = null;
  #port = 0;

  constructor(options: DiscoveryOptions) {
    this.#options = options;
  }

  get port(): number {
    return this.#port;
  }

  start(): Promise<number> {
    if (this.#socket) return Promise.resolve(this.#port);
    return new Promise((resolve, reject) => {
      const socket = createSocket("udp4");
      socket.on("message", (msg, rinfo) => {
        if (msg.toString("utf8").trim() !== DISCOVERY_QUERY) return;
        const body = Buffer.from(JSON.stringify(this.#options.reply()), "utf8");
        socket.send(body, rinfo.port, rinfo.address, (err) => {
          if (err) this.#options.log?.("Discovery reply failed", err);
        });
      });
      socket.once("error", (err) => {
        socket.close();
        this.#socket = null;
        reject(err);
      });
      socket.bind(this.#options.port, () => {
        socket.removeAllListeners("error");
        socket.on("error", (err) => this.#options.log?.("Discovery socket error", err));
        this.#socket = socket;
        this.#port = socket.address().port;
        resolve(this.#port);
      });
    });
  }

  close(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    this.#port = 0;
    if (!socket) return Promise.resolve();
    return new Promise((resolve) => socket.close(resolve));
  }
}

export function discoveryReply(
  serverId: string,
  name: string,
  port: number,
  tls = false,
): DiscoveryReply {
  return { serverId, name, port, proto: DEVICE_API_PROTOCOL_VERSION, tls };
}
