/**
 * Independent copies of Nintendo AES-XTS / ECB / CTR so fixture builders do not import the
 * parser package (tests then check the two implementations against each other).
 */
import { createCipheriv, createDecipheriv } from "node:crypto";

export function aesEcb(key: Buffer, data: Buffer, encrypt: boolean): Buffer {
  const cipher = encrypt
    ? createCipheriv("aes-128-ecb", key, null)
    : createDecipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function aesCtrAt(key: Buffer, counter: Buffer, offset: number, data: Buffer): Buffer {
  const blockIndex = Math.floor(offset / 16);
  const iv = Buffer.concat([counter.subarray(0, 8), Buffer.alloc(8)]);
  iv.writeBigUInt64BE(BigInt(blockIndex), 8);
  const keystream = createCipheriv("aes-128-ctr", key, iv).update(
    Buffer.alloc(offset - blockIndex * 16 + data.length),
  );
  const out = Buffer.alloc(data.length);
  const skip = offset - blockIndex * 16;
  for (let i = 0; i < data.length; i++) out[i] = (data[i] ?? 0) ^ (keystream[skip + i] ?? 0);
  return out;
}

function xtsTweak(sector: number): Buffer {
  const tweak = Buffer.alloc(16);
  let remaining = sector;
  for (let i = 0; i < 16; i++) {
    tweak[15 - i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return tweak;
}

function mulAlphaLe(tweak: Buffer): Buffer {
  let value = 0n;
  for (let i = 0; i < 16; i++) value |= BigInt(tweak[i] ?? 0) << BigInt(i * 8);
  value <<= 1n;
  if (value & (1n << 128n)) value ^= (1n << 128n) | 0x87n;
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = Number((value >> BigInt(i * 8)) & 0xffn);
  return out;
}

export function nintendoXtsCrypt(
  headerKey: Buffer,
  data: Buffer,
  encrypt: boolean,
  firstSector = 0,
): Buffer {
  const dataKey = headerKey.subarray(0, 16);
  const tweakKey = headerKey.subarray(16, 32);
  const out = Buffer.alloc(data.length);
  for (let pos = 0, sector = firstSector; pos < data.length; pos += 0x200, sector++) {
    let tweak = aesEcb(tweakKey, xtsTweak(sector), true);
    const sectorData = data.subarray(pos, pos + 0x200);
    const xored = Buffer.alloc(0x200);
    const tweaks: Buffer[] = [];
    for (let block = 0; block < 0x200; block += 16) {
      tweaks.push(tweak);
      for (let i = 0; i < 16; i++)
        xored[block + i] = (sectorData[block + i] ?? 0) ^ (tweak[i] ?? 0);
      tweak = mulAlphaLe(tweak);
    }
    const crypted = aesEcb(dataKey, xored, encrypt);
    for (let block = 0; block < 0x200; block += 16) {
      const t = tweaks[block / 16] ?? Buffer.alloc(16);
      for (let i = 0; i < 16; i++) out[pos + block + i] = (crypted[block + i] ?? 0) ^ (t[i] ?? 0);
    }
  }
  return out;
}
