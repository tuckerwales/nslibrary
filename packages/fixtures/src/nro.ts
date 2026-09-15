import { deterministicBytes } from "./bytes";

export interface NacpBuildOptions {
  name: string;
  publisher: string;
  displayVersion: string;
  addOnContentBaseId?: bigint;
}

export function buildNacp(options: NacpBuildOptions): Buffer {
  const nacp = Buffer.alloc(0x4000);
  nacp.write(options.name, 0x0, 0x1ff, "utf8");
  nacp.write(options.publisher, 0x200, 0xff, "utf8");
  nacp.write(options.displayVersion, 0x3060, 0xf, "utf8");
  nacp.writeBigUInt64LE(options.addOnContentBaseId ?? 0n, 0x3070);
  return nacp;
}

/** Smallest byte sequence that looks like a JPEG (SOI … EOI); enough for icon plumbing tests. */
export function fakeJpeg(seed: string, size = 0x200): Buffer {
  const jpeg = deterministicBytes(`jpeg:${seed}`, size);
  jpeg.set([0xff, 0xd8, 0xff, 0xe0], 0);
  jpeg.set([0xff, 0xd9], size - 2);
  return jpeg;
}

export interface NroBuildOptions extends NacpBuildOptions {
  icon?: Buffer | null;
  /** Omit the asset section entirely. */
  withoutAssets?: boolean;
  codeSize?: number;
}

export function buildNro(options: NroBuildOptions): Buffer {
  const code = deterministicBytes(`nro:${options.name}:code`, options.codeSize ?? 0x1000);
  code.fill(0, 0, 0x80);
  code.write("NRO0", 0x10, "latin1");
  code.writeUInt32LE(code.length, 0x18);
  if (options.withoutAssets) return code;

  const icon = options.icon === null ? Buffer.alloc(0) : (options.icon ?? fakeJpeg(options.name));
  const nacp = buildNacp(options);
  const assets = Buffer.alloc(0x38);
  assets.write("ASET", 0, "latin1");
  assets.writeBigUInt64LE(0x38n, 0x08);
  assets.writeBigUInt64LE(BigInt(icon.length), 0x10);
  assets.writeBigUInt64LE(BigInt(0x38 + icon.length), 0x18);
  assets.writeBigUInt64LE(BigInt(nacp.length), 0x20);
  assets.writeBigUInt64LE(BigInt(0x38 + icon.length + nacp.length), 0x28);
  return Buffer.concat([code, assets, icon, nacp]);
}
