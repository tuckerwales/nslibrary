import { createHash } from "node:crypto";
import {
  decodeFrameHeader,
  encodeFrame,
  FrameKind,
  USB_FRAME_HEADER_SIZE,
  USB_STREAM_CHUNK_SIZE,
} from "@nslib/shared";
import { describe, expect, it } from "vitest";
import { MemoryDuplex } from "../src/duplex";
import { UsbLink } from "../src/session";

describe("MemoryDuplex", () => {
  it("delivers writes from a to b", async () => {
    const d = new MemoryDuplex();
    await d.a.write(new Uint8Array([1, 2, 3, 4]));
    expect([...(await d.b.readExact(4))]).toEqual([1, 2, 3, 4]);
    d.close();
  });
});

describe("UsbLink ping/pong", () => {
  it("answers Ping with Pong carrying the same request id", async () => {
    const d = new MemoryDuplex();
    const link = new UsbLink(d.a, {
      handler: {
        handle: async () => ({ status: 404 }),
      },
      idleMs: 0,
    });
    const run = link.run();
    await d.b.write(encodeFrame({ kind: FrameKind.Ping, requestId: 99 }));
    const header = decodeFrameHeader(await d.b.readExact(USB_FRAME_HEADER_SIZE));
    expect(header.kind).toBe(FrameKind.Pong);
    expect(header.requestId).toBe(99);
    link.stop();
    await run.catch(() => undefined);
  });
});

describe("UsbLink streamed payloads", () => {
  async function request(
    chunks: Uint8Array[],
    length: number,
  ): Promise<{ d: MemoryDuplex; link: UsbLink; run: Promise<void> }> {
    const d = new MemoryDuplex();
    const link = new UsbLink(d.a, {
      handler: {
        handle: async () => ({
          status: 206,
          payload: {
            length,
            chunks: (async function* () {
              yield* chunks;
            })(),
          },
        }),
      },
      idleMs: 0,
      log: () => {},
    });
    const run = link.run();
    await d.b.write(
      encodeFrame({ kind: FrameKind.Request, requestId: 7, json: { m: "GET", p: "/files/1" } }),
    );
    return { d, link, run };
  }

  it("sends every chunk after a header announcing the total length", async () => {
    const chunks = [new Uint8Array(3).fill(1), new Uint8Array(5).fill(2)];
    const { d, link, run } = await request(chunks, 8);
    const header = decodeFrameHeader(await d.b.readExact(USB_FRAME_HEADER_SIZE));
    expect(header).toMatchObject({ kind: FrameKind.Response, requestId: 7, status: 206 });
    expect(header.payloadLength).toBe(8);
    expect([...(await d.b.readExact(header.jsonLength + 8))].slice(header.jsonLength)).toEqual([
      1, 1, 1, 2, 2, 2, 2, 2,
    ]);
    link.stop();
    await run.catch(() => undefined);
  });

  it("closes the link when a stream ends before its announced length", async () => {
    const { d, run } = await request([new Uint8Array(3)], 8);
    await expect(run).rejects.toThrow("ended after 3 of 8 bytes");
    expect(d.a.closed).toBe(true);
  });
});

describe("UsbLink request bodies", () => {
  const BIG = USB_STREAM_CHUNK_SIZE * 2 + 5;

  function bigBody(): Uint8Array {
    const body = new Uint8Array(BIG);
    for (let i = 0; i < BIG; i++) body[i] = i % 251;
    return body;
  }

  async function exchange(
    d: MemoryDuplex,
    requestId: number,
    payload?: Uint8Array,
  ): Promise<{ status: number; body: unknown }> {
    await d.b.write(
      encodeFrame({ kind: FrameKind.Request, requestId, json: { m: "POST", p: "/x" }, payload }),
    );
    const header = decodeFrameHeader(await d.b.readExact(USB_FRAME_HEADER_SIZE));
    expect(header.requestId).toBe(requestId);
    const json = JSON.parse(new TextDecoder().decode(await d.b.readExact(header.jsonLength)));
    return { status: header.status, body: json.b };
  }

  it("hands a small body over whole", async () => {
    const d = new MemoryDuplex();
    let seen: unknown;
    const link = new UsbLink(d.a, {
      handler: {
        handle: async (_req, payload) => {
          seen = payload;
          return { status: 200, body: {} };
        },
      },
      idleMs: 0,
    });
    const run = link.run();
    await exchange(d, 1, new Uint8Array([1, 2, 3]));
    expect(seen).toBeInstanceOf(Uint8Array);
    expect([...(seen as Uint8Array)]).toEqual([1, 2, 3]);
    link.stop();
    await run.catch(() => undefined);
  });

  it("streams a large body instead of buffering it", async () => {
    const d = new MemoryDuplex();
    const link = new UsbLink(d.a, {
      handler: {
        handle: async (_req, payload) => {
          if (payload instanceof Uint8Array) throw new Error("buffered");
          const sizes: number[] = [];
          const hash = createHash("sha256");
          for await (const chunk of payload.chunks) {
            sizes.push(chunk.byteLength);
            hash.update(chunk);
          }
          return { status: 200, body: { length: payload.length, sizes, sha: hash.digest("hex") } };
        },
      },
      idleMs: 0,
    });
    const run = link.run();
    const body = bigBody();
    const res = await exchange(d, 2, body);
    expect(res).toEqual({
      status: 200,
      body: {
        length: BIG,
        sizes: [USB_STREAM_CHUNK_SIZE, USB_STREAM_CHUNK_SIZE, 5],
        sha: createHash("sha256").update(body).digest("hex"),
      },
    });
    link.stop();
    await run.catch(() => undefined);
  });

  it("drains what the handler left unread before it answers", async () => {
    const d = new MemoryDuplex();
    let calls = 0;
    const link = new UsbLink(d.a, {
      handler: {
        handle: async (_req, payload) => {
          calls++;
          if (calls === 1) return { status: 200, body: { ignored: true } };
          if (calls === 2 && !(payload instanceof Uint8Array)) {
            // Read one chunk, then give up the way a size limit does.
            for await (const _chunk of payload.chunks) break;
            throw Object.assign(new Error("too big"), { code: "PAYLOAD_TOO_LARGE", status: 413 });
          }
          return { status: 204, body: { ok: true } };
        },
      },
      idleMs: 0,
    });
    const run = link.run();
    expect(await exchange(d, 3, bigBody())).toEqual({ status: 200, body: { ignored: true } });
    expect(await exchange(d, 4, bigBody())).toEqual({
      status: 413,
      body: { error: { code: "PAYLOAD_TOO_LARGE", msg: "too big" } },
    });
    expect(await exchange(d, 5)).toEqual({ status: 204, body: { ok: true } });
    link.stop();
    await run.catch(() => undefined);
  });
});
