/**
 * Minimal mDNS responder for `_nslibrary._tcp.local`, so the server shows up in Bonjour/Avahi
 * browsers on the LAN. The Switch uses the simpler `NSLIB?1` UDP query (discovery.ts); this is for
 * everything else, and you can always type an address by hand.
 *
 * Only what advertising one service needs: PTR, SRV, TXT, and A answers to PTR/SRV/TXT/A/ANY
 * questions, an announcement on start, and a goodbye on close.
 */
import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";
import type { LogFn } from "../api/context";

export const MDNS_ADDRESS = "224.0.0.251";
export const MDNS_PORT = 5353;
export const SERVICE_TYPE = "_nslibrary._tcp.local";
const SERVICE_ENUMERATION = "_services._dns-sd._udp.local";
const TTL_SECONDS = 120;
/** Records answering a question sent to this port go back to it, not to the multicast group. */
const CLASS_IN = 1;
const FLUSH = 0x8000;

const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 } as const;

export interface MdnsService {
  /** Instance name shown in browsers, e.g. the server name. */
  instance: string;
  /** Host name to publish, without `.local`. */
  host: string;
  port: number;
  txt: Record<string, string>;
  addresses: string[];
}

interface Question {
  name: string;
  type: number;
}

interface Answer {
  name: string;
  type: number;
  data: Buffer;
}

function encodeName(name: string): Buffer {
  const parts = name.split(".").filter((part) => part.length > 0);
  const buffers = parts.map((part) => {
    const label = Buffer.from(part, "utf8");
    if (label.length > 63) throw new Error(`mDNS label too long: ${part}`);
    return Buffer.concat([Buffer.from([label.length]), label]);
  });
  return Buffer.concat([...buffers, Buffer.from([0])]);
}

/** Returns the name and the offset just past it, following compression pointers. */
function decodeName(message: Buffer, offset: number): { name: string; next: number } {
  const parts: string[] = [];
  let next = -1;
  let cursor = offset;
  let hops = 0;
  while (cursor < message.length) {
    const length = message[cursor] ?? 0;
    if (length === 0) {
      cursor += 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      const pointer = ((length & 0x3f) << 8) | (message[cursor + 1] ?? 0);
      if (next === -1) next = cursor + 2;
      if (++hops > 16 || pointer >= message.length) break;
      cursor = pointer;
      continue;
    }
    parts.push(message.toString("utf8", cursor + 1, cursor + 1 + length));
    cursor += 1 + length;
  }
  return { name: parts.join("."), next: next === -1 ? cursor : next };
}

export function parseQuestions(message: Buffer): Question[] {
  if (message.length < 12) return [];
  const flags = message.readUInt16BE(2);
  // Ignore responses; only queries (QR=0) are answered.
  if ((flags & 0x8000) !== 0) return [];
  const count = message.readUInt16BE(4);
  const questions: Question[] = [];
  let offset = 12;
  for (let i = 0; i < count && offset + 4 <= message.length; i++) {
    const { name, next } = decodeName(message, offset);
    questions.push({ name: name.toLowerCase(), type: message.readUInt16BE(next) });
    offset = next + 4;
  }
  return questions;
}

function txtData(txt: Record<string, string>): Buffer {
  const entries = Object.entries(txt).map(([key, value]) => Buffer.from(`${key}=${value}`, "utf8"));
  if (entries.length === 0) return Buffer.from([0]);
  return Buffer.concat(entries.map((entry) => Buffer.concat([Buffer.from([entry.length]), entry])));
}

function srvData(port: number, host: string): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(0, 0); // priority
  head.writeUInt16BE(0, 2); // weight
  head.writeUInt16BE(port, 4);
  return Buffer.concat([head, encodeName(`${host}.local`)]);
}

function aData(address: string): Buffer | null {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return Buffer.from(octets);
}

function serviceAnswers(service: MdnsService): Answer[] {
  const instance = `${service.instance}.${SERVICE_TYPE}`;
  const answers: Answer[] = [
    { name: SERVICE_ENUMERATION, type: TYPE.PTR, data: encodeName(SERVICE_TYPE) },
    { name: SERVICE_TYPE, type: TYPE.PTR, data: encodeName(instance) },
    { name: instance, type: TYPE.SRV, data: srvData(service.port, service.host) },
    { name: instance, type: TYPE.TXT, data: txtData(service.txt) },
  ];
  for (const address of service.addresses) {
    const data = aData(address);
    if (data) answers.push({ name: `${service.host}.local`, type: TYPE.A, data });
  }
  return answers;
}

/** The records that answer `questions`, or an empty list when none apply. */
export function answersFor(service: MdnsService, questions: Question[]): Answer[] {
  const all = serviceAnswers(service);
  const matched = new Map<string, Answer>();
  for (const question of questions) {
    for (const answer of all) {
      if (answer.name.toLowerCase() !== question.name) continue;
      if (question.type !== TYPE.ANY && question.type !== answer.type) continue;
      matched.set(`${answer.name}:${answer.type}:${answer.data.toString("hex")}`, answer);
      // A PTR answer is worth little on its own, so send the service's details with it.
      if (answer.type === TYPE.PTR && question.name === SERVICE_TYPE) {
        for (const extra of all) {
          if (extra.type === TYPE.SRV || extra.type === TYPE.TXT || extra.type === TYPE.A) {
            matched.set(`${extra.name}:${extra.type}:${extra.data.toString("hex")}`, extra);
          }
        }
      }
    }
  }
  return [...matched.values()];
}

export function encodeResponse(answers: Answer[], ttl = TTL_SECONDS): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2); // response, authoritative
  header.writeUInt16BE(answers.length, 6);
  const records = answers.map((answer) => {
    const name = encodeName(answer.name);
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(answer.type, 0);
    fixed.writeUInt16BE(CLASS_IN | FLUSH, 2);
    fixed.writeUInt32BE(ttl, 4);
    fixed.writeUInt16BE(answer.data.length, 8);
    return Buffer.concat([name, fixed, answer.data]);
  });
  return Buffer.concat([header, ...records]);
}

/** Non-internal IPv4 addresses, which are what an A record should point at. */
export function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

export interface MdnsOptions {
  /** Called for each query so the reply always carries the current name, port, and addresses. */
  service: () => MdnsService;
  /** Defaults to 5353. Tests use an ephemeral port so they don't touch the real group. */
  port?: number;
  log?: LogFn;
}

export class MdnsResponder {
  readonly #options: MdnsOptions;
  readonly #port: number;
  #socket: Socket | null = null;

  constructor(options: MdnsOptions) {
    this.#options = options;
    this.#port = options.port ?? MDNS_PORT;
  }

  /** The port actually bound, for tests. */
  get port(): number {
    return this.#socket?.address().port ?? this.#port;
  }

  start(): Promise<void> {
    if (this.#socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = createSocket({ type: "udp4", reuseAddr: true });
      socket.once("error", (err) => {
        socket.close();
        reject(err);
      });
      socket.on("message", (message, rinfo) => {
        try {
          const questions = parseQuestions(message);
          if (questions.length === 0) return;
          const answers = answersFor(this.#options.service(), questions);
          if (answers.length === 0) return;
          socket.send(encodeResponse(answers), rinfo.port, rinfo.address);
        } catch (err) {
          this.#options.log?.("mDNS reply failed", err);
        }
      });
      socket.bind(this.#port, () => {
        socket.removeAllListeners("error");
        socket.on("error", (err) => this.#options.log?.("mDNS socket error", err));
        try {
          socket.addMembership(MDNS_ADDRESS);
          socket.setMulticastTTL(255);
        } catch (err) {
          // A host without multicast (some containers) still answers unicast queries.
          this.#options.log?.("mDNS multicast unavailable", err);
        }
        this.#socket = socket;
        this.#announce();
        resolve();
      });
    });
  }

  /** Multicasts the service's records, with `ttl` 0 to withdraw them. */
  #announce(ttl = TTL_SECONDS): void {
    const socket = this.#socket;
    if (!socket) return;
    try {
      const service = this.#options.service();
      socket.send(encodeResponse(serviceAnswers(service), ttl), this.#port, MDNS_ADDRESS);
    } catch (err) {
      this.#options.log?.("mDNS announcement failed", err);
    }
  }

  close(): Promise<void> {
    const socket = this.#socket;
    if (!socket) return Promise.resolve();
    this.#announce(0);
    this.#socket = null;
    return new Promise((resolve) => socket.close(resolve));
  }
}
