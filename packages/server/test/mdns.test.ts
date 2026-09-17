import { createSocket } from "node:dgram";
import { describe, expect, it } from "vitest";
import {
  answersFor,
  encodeResponse,
  MdnsResponder,
  type MdnsService,
  parseQuestions,
  SERVICE_TYPE,
} from "../src/device/mdns";

const SERVICE: MdnsService = {
  instance: "Living room",
  host: "tuckernet",
  port: 8465,
  txt: { id: "server-id", proto: "1", tls: "0" },
  addresses: ["192.168.1.20"],
};

function encodeName(name: string): Buffer {
  const labels = name
    .split(".")
    .map((part) => Buffer.concat([Buffer.from([part.length]), Buffer.from(part)]));
  return Buffer.concat([...labels, Buffer.from([0])]);
}

/** A query with one question, as a browser would send it. */
function query(name: string, type: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, encodeName(name), tail]);
}

/** Minimal reader for the records this responder writes (no compression pointers). */
function readAnswers(message: Buffer) {
  const count = message.readUInt16BE(6);
  const answers: { name: string; type: number; ttl: number; data: Buffer }[] = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const parts: string[] = [];
    while (message[offset] !== 0) {
      const length = message[offset] ?? 0;
      parts.push(message.toString("utf8", offset + 1, offset + 1 + length));
      offset += 1 + length;
    }
    offset += 1;
    const type = message.readUInt16BE(offset);
    const ttl = message.readUInt32BE(offset + 4);
    const length = message.readUInt16BE(offset + 8);
    const data = message.subarray(offset + 10, offset + 10 + length);
    offset += 10 + length;
    answers.push({ name: parts.join("."), type, ttl, data });
  }
  return answers;
}

describe("mDNS records", () => {
  it("reads the questions out of a query", () => {
    expect(parseQuestions(query(SERVICE_TYPE, 12))).toEqual([{ name: SERVICE_TYPE, type: 12 }]);
    // Responses are not questions.
    const response = encodeResponse(answersFor(SERVICE, [{ name: SERVICE_TYPE, type: 12 }]));
    expect(parseQuestions(response)).toEqual([]);
    expect(parseQuestions(Buffer.alloc(4))).toEqual([]);
  });

  it("answers a service query with the instance, its address, and its port", () => {
    const answers = readAnswers(
      encodeResponse(answersFor(SERVICE, parseQuestions(query(SERVICE_TYPE, 12)))),
    );
    const byType = new Map(answers.map((answer) => [answer.type, answer]));
    expect([...byType.keys()].sort()).toEqual([1, 12, 16, 33]);
    expect(byType.get(12)?.name).toBe(SERVICE_TYPE);
    expect(byType.get(33)?.name).toBe(`Living room.${SERVICE_TYPE}`);
    expect(byType.get(33)?.data.readUInt16BE(4)).toBe(8465);
    expect([...(byType.get(1)?.data ?? [])]).toEqual([192, 168, 1, 20]);
    expect(byType.get(16)?.data.toString("latin1")).toContain("id=server-id");
    expect(byType.get(1)?.ttl).toBe(120);
  });

  it("answers the service enumeration and ignores other names", () => {
    expect(
      answersFor(SERVICE, parseQuestions(query("_services._dns-sd._udp.local", 12))),
    ).toHaveLength(1);
    expect(answersFor(SERVICE, parseQuestions(query("_printer._tcp.local", 255)))).toEqual([]);
  });
});

describe("MdnsResponder", () => {
  it("replies to a query sent to its port", async () => {
    const responder = new MdnsResponder({ service: () => SERVICE, port: 0, log: () => {} });
    await responder.start();
    const client = createSocket({ type: "udp4" });
    try {
      const reply = new Promise<Buffer>((resolve) => client.once("message", resolve));
      client.send(query(SERVICE_TYPE, 255), responder.port, "127.0.0.1");
      const answers = readAnswers(await reply);
      expect(answers.some((a) => a.type === 33 && a.data.readUInt16BE(4) === 8465)).toBe(true);
    } finally {
      client.close();
      await responder.close();
    }
  });
});
