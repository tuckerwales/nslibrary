import { decodeFrameHeader, encodeFrame, FrameKind, USB_FRAME_HEADER_SIZE } from "@nslib/shared";
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
