/**
 * AES primitives used by NCA: ECB (key area / title key), Nintendo AES-XTS (header),
 * and AES-CTR (sections). The XTS tweak matches nsz/hactool, not OpenSSL's default.
 */
import { createCipheriv, createDecipheriv } from "node:crypto";
import { FormatError } from "./binary";

export const XTS_SECTOR_SIZE = 0x200;

export function aesEcb(key: Buffer, data: Buffer, encrypt: boolean): Buffer {
  if (key.length !== 16) throw new FormatError("INVALID", "AES-128-ECB key must be 16 bytes");
  if (data.length === 0) return Buffer.alloc(0);
  if (data.length % 16 !== 0) {
    throw new FormatError("INVALID", `AES-ECB data length ${data.length} is not block-aligned`);
  }
  const cipher = encrypt
    ? createCipheriv("aes-128-ecb", key, null)
    : createDecipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * AES-128-CTR at an absolute NCA offset: counter = nonce (8 bytes) || BE64(offset >> 4).
 * Encryption and decryption are the same operation.
 */
export function aesCtrAt(
  key: Buffer,
  cryptoCounter: Buffer,
  absoluteOffset: number,
  data: Buffer,
): Buffer {
  const aligned = absoluteOffset - (absoluteOffset % 16);
  const iv = Buffer.alloc(16);
  cryptoCounter.copy(iv, 0, 0, 8);
  iv.writeBigUInt64BE(BigInt(aligned / 16), 8);
  const cipher = createCipheriv("aes-128-ctr", key, iv);
  if (absoluteOffset !== aligned) cipher.update(Buffer.alloc(absoluteOffset - aligned));
  const out = cipher.update(data);
  cipher.final();
  return out;
}

/** 16-byte AES-ECB input for Nintendo XTS: sector number as a big-endian 128-bit integer. */
function xtsTweak(sector: number): Buffer {
  const tweak = Buffer.alloc(16);
  let remaining = sector;
  for (let i = 0; i < 16; i++) {
    tweak[15 - i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return tweak;
}

/** GF(2^128) multiply-by-α on a tweak, treating the 16 bytes as little-endian (nsz `_mul_alpha_le`). */
function mulAlphaLe(tweak: Buffer): Buffer {
  let value = 0n;
  for (let i = 0; i < 16; i++) value |= BigInt(tweak[i] ?? 0) << BigInt(i * 8);
  value <<= 1n;
  if (value & (1n << 128n)) value ^= (1n << 128n) | 0x87n;
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = Number((value >> BigInt(i * 8)) & 0xffn);
  return out;
}

/**
 * Nintendo AES-128-XTS with 0x200-byte sectors. `headerKey` is 32 bytes (data || tweak).
 * Data must be a multiple of the sector size.
 */
export function nintendoXtsCrypt(
  headerKey: Buffer,
  data: Buffer,
  encrypt: boolean,
  firstSector = 0,
): Buffer {
  if (headerKey.length !== 32) {
    throw new FormatError("INVALID", "NCA header key must be 32 bytes");
  }
  if (data.length % XTS_SECTOR_SIZE !== 0) {
    throw new FormatError("INVALID", `XTS data length ${data.length} is not a multiple of 0x200`);
  }
  const dataKey = headerKey.subarray(0, 16);
  const tweakKey = headerKey.subarray(16, 32);
  const out = Buffer.alloc(data.length);

  for (let pos = 0, sector = firstSector; pos < data.length; pos += XTS_SECTOR_SIZE, sector++) {
    let tweak = aesEcb(tweakKey, xtsTweak(sector), true);
    const sectorData = data.subarray(pos, pos + XTS_SECTOR_SIZE);
    const xored = Buffer.alloc(XTS_SECTOR_SIZE);
    const tweaks: Buffer[] = [];
    for (let block = 0; block < XTS_SECTOR_SIZE; block += 16) {
      tweaks.push(tweak);
      for (let i = 0; i < 16; i++)
        xored[block + i] = (sectorData[block + i] ?? 0) ^ (tweak[i] ?? 0);
      tweak = mulAlphaLe(tweak);
    }
    const crypted = aesEcb(dataKey, xored, encrypt);
    for (let block = 0; block < XTS_SECTOR_SIZE; block += 16) {
      const t = tweaks[block / 16] ?? Buffer.alloc(16);
      for (let i = 0; i < 16; i++) out[pos + block + i] = (crypted[block + i] ?? 0) ^ (t[i] ?? 0);
    }
  }
  return out;
}
