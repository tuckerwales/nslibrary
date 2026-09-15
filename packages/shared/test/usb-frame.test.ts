import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeFrameHeader,
  encodeFrame,
  encodeFrameHeader,
  FrameError,
  FrameKind,
  USB_FRAME_HEADER_SIZE,
} from "../src/index";

interface GoldenFrame {
  name: string;
  kind: keyof typeof FrameKind;
  requestId: number;
  status: number;
  flags: number;
  json: unknown;
  payloadHex: string;
  hex: string;
}

const goldenFrames: GoldenFrame[] = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "golden", "usb", "frames.json"), "utf8"),
);

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("USB frame golden vectors", () => {
  it.each(goldenFrames.map((f) => [f.name, f] as const))(
    "%s encodes byte-for-byte",
    (_name, frame) => {
      const encoded = encodeFrame({
        kind: FrameKind[frame.kind],
        requestId: frame.requestId,
        status: frame.status,
        flags: frame.flags,
        json: frame.json ?? undefined,
        payload: Buffer.from(frame.payloadHex, "hex"),
      });
      expect(toHex(encoded)).toBe(frame.hex);

      const header = decodeFrameHeader(encoded);
      expect(header.kind).toBe(FrameKind[frame.kind]);
      expect(header.requestId).toBe(frame.requestId);
      expect(header.payloadLength).toBe(frame.payloadHex.length / 2);
    },
  );
});

describe("USB frame header", () => {
  it("round-trips large payload lengths", () => {
    const header = {
      version: 1,
      kind: FrameKind.Response,
      flags: 1,
      requestId: 0xfffffffe,
      status: 206,
      jsonLength: 123,
      payloadLength: 16 * 1024 ** 3 + 7,
    };
    expect(decodeFrameHeader(encodeFrameHeader(header))).toEqual(header);
  });

  it("rejects short, foreign, and future frames", () => {
    const valid = encodeFrameHeader({
      kind: FrameKind.Ping,
      flags: 0,
      requestId: 1,
      status: 0,
      jsonLength: 0,
      payloadLength: 0,
    });
    const expectCode = (bytes: Uint8Array, code: string) => {
      try {
        decodeFrameHeader(bytes);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(FrameError);
        expect((err as FrameError).code).toBe(code);
      }
    };

    expectCode(valid.subarray(0, USB_FRAME_HEADER_SIZE - 1), "SHORT_HEADER");
    expectCode(Object.assign(new Uint8Array(valid), { 0: 0x58 }), "BAD_MAGIC");
    expectCode(Object.assign(new Uint8Array(valid), { 4: 2 }), "BAD_VERSION");
    expectCode(Object.assign(new Uint8Array(valid), { 6: 9 }), "BAD_KIND");
    const huge = new Uint8Array(valid);
    new DataView(huge.buffer).setBigUint64(0x18, 1n << 60n, true);
    expectCode(huge, "TOO_LARGE");
  });

  it("decodes a header embedded at a non-zero byte offset", () => {
    const frame = encodeFrame({
      kind: FrameKind.Request,
      requestId: 5,
      json: { m: "GET", p: "/hello" },
    });
    const padded = new Uint8Array(frame.byteLength + 3);
    padded.set(frame, 3);
    expect(decodeFrameHeader(padded.subarray(3)).requestId).toBe(5);
  });
});
