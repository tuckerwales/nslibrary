import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { trayIconPng } from "../src/tray-icon";

function decode(png: Buffer) {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const width = png.readUInt32BE(16);
  const idatLength = png.readUInt32BE(33);
  expect(png.toString("latin1", 37, 41)).toBe("IDAT");
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  const pixel = (x: number, y: number) => [
    ...raw.subarray(1 + y * (width * 4 + 1) + x * 4).subarray(0, 4),
  ];
  return { width, pixel };
}

describe("trayIconPng", () => {
  it("draws the three bars in their colours on a transparent background", () => {
    const { width, pixel } = decode(trayIconPng(32));
    expect(width).toBe(32);
    expect(pixel(0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(7, 16)).toEqual([0x17, 0x20, 0x2c, 255]);
    expect(pixel(16, 16)).toEqual([0x0d, 0x76, 0x6e, 255]);
    expect(pixel(25, 16)).toEqual([0x8f, 0x5a, 0x0c, 255]);
  });

  it("draws a black template image for macOS", () => {
    const { width, pixel } = decode(trayIconPng(16, true));
    expect(width).toBe(16);
    expect(pixel(8, 8)).toEqual([0, 0, 0, 255]);
  });
});
