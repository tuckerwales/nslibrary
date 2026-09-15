/**
 * Synthetic NCAs and their NCZ encodings. The "NCA" is a random 0x4000-byte prefix followed
 * by sections, some AES-CTR encrypted; it is not a structurally valid NCA header yet (that
 * arrives with the NCA crypto fixtures), but it exercises the NCZ container and crypto paths.
 */
import { createCipheriv } from "node:crypto";
import { constants, zstdCompressSync } from "node:zlib";
import { deterministicBytes, mixedBytes } from "./bytes";

const PREFIX_SIZE = 0x4000;

export interface FixtureSectionSpec {
  size: number;
  encrypted: boolean;
}

export interface FixtureNczSection {
  offset: number;
  size: number;
  cryptoType: number;
  cryptoKey: Buffer;
  cryptoCounter: Buffer;
}

export interface FixtureNca {
  /** The NCA as it would appear inside an NSP. */
  encrypted: Buffer;
  /** Same bytes with every section decrypted (the prefix is untouched). */
  plaintext: Buffer;
  sections: FixtureNczSection[];
}

export type NczBuildOptions =
  | { mode: "solid"; level?: number }
  | { mode: "block"; blockSizeExponent: number; level?: number };

/** Independent AES-CTR-at-offset implementation so tests don't just check the parser against itself. */
function ctrTransform(key: Buffer, counter: Buffer, offset: number, data: Buffer): Buffer {
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

export function buildFixtureNca(seed: string, specs: FixtureSectionSpec[]): FixtureNca {
  const prefix = deterministicBytes(`${seed}:prefix`, PREFIX_SIZE);
  const plainParts: Buffer[] = [prefix];
  const encryptedParts: Buffer[] = [prefix];
  const sections: FixtureNczSection[] = [];

  let offset = PREFIX_SIZE;
  specs.forEach((spec, i) => {
    const plain = mixedBytes(`${seed}:section${i}`, spec.size);
    const cryptoKey = deterministicBytes(`${seed}:key${i}`, 16);
    const cryptoCounter = Buffer.concat([
      deterministicBytes(`${seed}:nonce${i}`, 8),
      Buffer.alloc(8),
    ]);
    plainParts.push(plain);
    encryptedParts.push(
      spec.encrypted ? ctrTransform(cryptoKey, cryptoCounter, offset, plain) : plain,
    );
    sections.push({
      offset,
      size: spec.size,
      cryptoType: spec.encrypted ? 3 : 1,
      cryptoKey,
      cryptoCounter,
    });
    offset += spec.size;
  });

  return {
    encrypted: Buffer.concat(encryptedParts),
    plaintext: Buffer.concat(plainParts),
    sections,
  };
}

export function buildNcz(nca: FixtureNca, options: NczBuildOptions): Buffer {
  const body = nca.plaintext.subarray(PREFIX_SIZE);
  const zstdOptions = { params: { [constants.ZSTD_c_compressionLevel]: options.level ?? 3 } };

  const table = Buffer.alloc(0x10 + nca.sections.length * 0x40);
  table.write("NCZSECTN", 0, "latin1");
  table.writeBigUInt64LE(BigInt(nca.sections.length), 0x08);
  nca.sections.forEach((section, i) => {
    const o = 0x10 + i * 0x40;
    table.writeBigUInt64LE(BigInt(section.offset), o);
    table.writeBigUInt64LE(BigInt(section.size), o + 0x08);
    table.writeBigUInt64LE(BigInt(section.cryptoType), o + 0x10);
    section.cryptoKey.copy(table, o + 0x20);
    section.cryptoCounter.copy(table, o + 0x30);
  });

  const prefix = nca.encrypted.subarray(0, PREFIX_SIZE);
  if (options.mode === "solid") {
    return Buffer.concat([prefix, table, zstdCompressSync(body, zstdOptions)]);
  }

  const blockSize = 2 ** options.blockSizeExponent;
  const blockCount = Math.ceil(body.length / blockSize);
  const blockHeader = Buffer.alloc(0x18 + blockCount * 4);
  blockHeader.write("NCZBLOCK", 0, "latin1");
  blockHeader.writeUInt8(2, 0x08); // version
  blockHeader.writeUInt8(1, 0x09); // type
  blockHeader.writeUInt8(options.blockSizeExponent, 0x0b);
  blockHeader.writeUInt32LE(blockCount, 0x0c);
  blockHeader.writeBigUInt64LE(BigInt(body.length), 0x10);

  const blocks: Buffer[] = [];
  for (let i = 0; i < blockCount; i++) {
    const raw = body.subarray(i * blockSize, Math.min((i + 1) * blockSize, body.length));
    const compressed = zstdCompressSync(raw, zstdOptions);
    const stored = compressed.length < raw.length ? compressed : raw;
    blockHeader.writeUInt32LE(stored.length, 0x18 + i * 4);
    blocks.push(stored);
  }
  return Buffer.concat([prefix, table, blockHeader, ...blocks]);
}
