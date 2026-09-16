import { encodeFrame, FrameKind } from "@nslib/shared";
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
    const { decodeFrameHeader, USB_FRAME_HEADER_SIZE } = await import("@nslib/shared");
    const header = decodeFrameHeader(await d.b.readExact(USB_FRAME_HEADER_SIZE));
    expect(header.kind).toBe(FrameKind.Pong);
    expect(header.requestId).toBe(99);
    link.stop();
    await run.catch(() => undefined);
  });
});
