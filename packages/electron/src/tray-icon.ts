/**
 * Draws the tray icon (the favicon's three content bars) as a PNG in code, so no binary asset
 * has to be shipped or located at runtime.
 */
import { crc32, deflateSync } from "node:zlib";

type Rgba = [number, number, number, number];

/** The favicon's bars in its 32×32 viewBox: x, y, width, height, corner radius, colour. */
const BARS: [number, number, number, number, number, Rgba][] = [
  [3, 9, 9, 14, 2, [0x17, 0x20, 0x2c, 255]],
  [13.5, 9, 7, 14, 1.5, [0x0d, 0x76, 0x6e, 255]],
  [22, 9, 7, 14, 1.5, [0x8f, 0x5a, 0x0c, 255]],
];
/** Subsamples per pixel axis, for smooth rounded corners at 16 px. */
const SAMPLES = 4;

function coverage(px: number, py: number, scale: number, bar: (typeof BARS)[number]): number {
  const [x, y, w, h, r] = bar;
  let inside = 0;
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const u = (px + (sx + 0.5) / SAMPLES) / scale;
      const v = (py + (sy + 0.5) / SAMPLES) / scale;
      if (u < x || u > x + w || v < y || v > y + h) continue;
      const cx = Math.min(Math.max(u, x + r), x + w - r);
      const cy = Math.min(Math.max(v, y + r), y + h - r);
      if ((u - cx) ** 2 + (v - cy) ** 2 <= r * r) inside++;
    }
  }
  return inside / (SAMPLES * SAMPLES);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A square RGBA PNG of `size` pixels. `template` draws every bar in black for macOS template
 * images, which the menu bar recolours for light and dark mode.
 */
export function trayIconPng(size: number, template = false): Buffer {
  const scale = size / 32;
  const rows: Buffer[] = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0, then RGBA
    for (let px = 0; px < size; px++) {
      for (const bar of BARS) {
        const alpha = coverage(px, py, scale, bar);
        if (alpha === 0) continue;
        const [r, g, b, a] = template ? ([0, 0, 0, 255] as Rgba) : bar[5];
        row.set([r, g, b, Math.round(a * alpha)], 1 + px * 4);
      }
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
