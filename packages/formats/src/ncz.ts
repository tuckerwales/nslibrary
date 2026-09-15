/**
 * NCZ: an NCA whose first 0x4000 bytes are kept verbatim, followed by a section table
 * (NCZSECTN) and the *decrypted* remainder compressed with zstd, either as one solid
 * stream or as independently compressed blocks (NCZBLOCK). Restoring the NCA means
 * decompressing and re-applying AES-CTR to the encrypted sections.
 *
 * Layout reference: nicoboss/nsz docs/formats.md.
 */
import { createCipheriv } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { FormatError, hex, readMagic, readU64 } from "./binary";
import { type RandomAccessReader, readExact } from "./reader";

export const NCZ_UNCOMPRESSED_PREFIX_SIZE = 0x4000;
const SECTION_TABLE_HEADER_SIZE = 0x10;
const SECTION_ENTRY_SIZE = 0x40;
const BLOCK_HEADER_SIZE = 0x18;
const MAX_SECTIONS = 64;
const MIN_BLOCK_EXPONENT = 14;
const MAX_BLOCK_EXPONENT = 32;

export const NczCryptoType = {
  None: 1,
  Xts: 2,
  Ctr: 3,
  Bktr: 4,
} as const;

export interface NczSection {
  /** Absolute offset within the NCA. */
  offset: number;
  size: number;
  cryptoType: number;
  cryptoKey: Buffer;
  /** 16 bytes; the upper 8 form the AES-CTR nonce. */
  cryptoCounter: Buffer;
}

export interface NczBlockInfo {
  version: number;
  type: number;
  blockSizeExponent: number;
  blockSize: number;
  decompressedSize: number;
  compressedBlockSizes: number[];
}

export interface NczHeader {
  sections: NczSection[];
  block: NczBlockInfo | null;
  /** Absolute offset of the zstd stream (solid) or first block (block mode). */
  dataOffset: number;
}

export async function parseNczHeader(reader: RandomAccessReader): Promise<NczHeader> {
  const tableOffset = NCZ_UNCOMPRESSED_PREFIX_SIZE;
  const fixed = await readExact(reader, tableOffset, SECTION_TABLE_HEADER_SIZE);
  if (readMagic(fixed, 0, 8) !== "NCZSECTN") {
    throw new FormatError("BAD_MAGIC", `no NCZSECTN table at ${hex(tableOffset)}`);
  }
  const count = readU64(fixed, 8);
  if (count === 0 || count > MAX_SECTIONS) {
    throw new FormatError("INVALID", `NCZ declares ${count} sections`);
  }

  const table = await readExact(
    reader,
    tableOffset + SECTION_TABLE_HEADER_SIZE,
    count * SECTION_ENTRY_SIZE,
  );
  const sections: NczSection[] = [];
  for (let i = 0; i < count; i++) {
    const o = i * SECTION_ENTRY_SIZE;
    const section: NczSection = {
      offset: readU64(table, o),
      size: readU64(table, o + 0x08),
      cryptoType: readU64(table, o + 0x10),
      cryptoKey: Buffer.from(table.subarray(o + 0x20, o + 0x30)),
      cryptoCounter: Buffer.from(table.subarray(o + 0x30, o + 0x40)),
    };
    if (section.cryptoType === NczCryptoType.Xts || section.cryptoType > NczCryptoType.Bktr) {
      throw new FormatError(
        "UNSUPPORTED",
        `NCZ section ${i} uses crypto type ${section.cryptoType}`,
      );
    }
    sections.push(section);
  }

  let dataOffset = tableOffset + SECTION_TABLE_HEADER_SIZE + count * SECTION_ENTRY_SIZE;
  if (dataOffset + 8 > reader.size) {
    throw new FormatError("TRUNCATED", "NCZ has no compressed data");
  }
  const peek = await readExact(reader, dataOffset, 8);
  if (readMagic(peek, 0, 8) !== "NCZBLOCK") {
    return { sections, block: null, dataOffset };
  }

  const blockHeader = await readExact(reader, dataOffset, BLOCK_HEADER_SIZE);
  const blockSizeExponent = blockHeader.readUInt8(0x0b);
  if (blockSizeExponent < MIN_BLOCK_EXPONENT || blockSizeExponent > MAX_BLOCK_EXPONENT) {
    throw new FormatError("INVALID", `NCZ block size exponent ${blockSizeExponent} out of range`);
  }
  const blockSize = 2 ** blockSizeExponent;
  const blockCount = blockHeader.readUInt32LE(0x0c);
  const decompressedSize = readU64(blockHeader, 0x10);
  if (blockCount !== Math.ceil(decompressedSize / blockSize)) {
    throw new FormatError(
      "INVALID",
      `NCZ has ${blockCount} blocks for ${decompressedSize} bytes at ${blockSize}/block`,
    );
  }

  const sizeTable = await readExact(reader, dataOffset + BLOCK_HEADER_SIZE, blockCount * 4);
  const compressedBlockSizes: number[] = [];
  let compressedTotal = 0;
  for (let i = 0; i < blockCount; i++) {
    const size = sizeTable.readUInt32LE(i * 4);
    compressedBlockSizes.push(size);
    compressedTotal += size;
  }
  dataOffset += BLOCK_HEADER_SIZE + blockCount * 4;
  if (dataOffset + compressedTotal > reader.size) {
    throw new FormatError("TRUNCATED", "NCZ block data extends past end of file");
  }

  return {
    sections,
    dataOffset,
    block: {
      version: blockHeader.readUInt8(0x08),
      type: blockHeader.readUInt8(0x09),
      blockSizeExponent,
      blockSize,
      decompressedSize,
      compressedBlockSizes,
    },
  };
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

/** Re-encrypts CTR/BKTR sections in place, for bytes at or after `from`. */
export function applySectionCrypto(
  nca: Buffer,
  sections: readonly NczSection[],
  from = NCZ_UNCOMPRESSED_PREFIX_SIZE,
): void {
  for (const section of sections) {
    if (section.cryptoType !== NczCryptoType.Ctr && section.cryptoType !== NczCryptoType.Bktr)
      continue;
    const start = Math.max(section.offset, from);
    const stop = Math.min(section.offset + section.size, nca.length);
    if (stop <= start) continue;
    aesCtrAt(section.cryptoKey, section.cryptoCounter, start, nca.subarray(start, stop)).copy(
      nca,
      start,
    );
  }
}

/**
 * Restores the original NCA fully in memory. Intended for tests and small files; the server
 * verifier and the Switch installer use streaming equivalents.
 */
export async function decompressNczToBuffer(reader: RandomAccessReader): Promise<Buffer> {
  const header = await parseNczHeader(reader);
  const prefix = await readExact(reader, 0, NCZ_UNCOMPRESSED_PREFIX_SIZE);

  let body: Buffer;
  if (header.block) {
    const { blockSize, decompressedSize, compressedBlockSizes } = header.block;
    const blocks: Buffer[] = [];
    let position = header.dataOffset;
    let remaining = decompressedSize;
    for (const [index, storedSize] of compressedBlockSizes.entries()) {
      const expected = Math.min(blockSize, remaining);
      const stored = await readExact(reader, position, storedSize);
      position += storedSize;
      // nsz stores a block raw whenever compression does not make it smaller.
      const block = storedSize < expected ? zstdDecompressSync(stored) : stored;
      if (storedSize > expected || block.length !== expected) {
        throw new FormatError(
          "INVALID",
          `NCZ block ${index} decompressed to ${block.length} bytes, expected ${expected}`,
        );
      }
      blocks.push(block);
      remaining -= expected;
    }
    body = Buffer.concat(blocks);
  } else {
    body = zstdDecompressSync(
      await readExact(reader, header.dataOffset, reader.size - header.dataOffset),
    );
  }

  const nca = Buffer.concat([prefix, body]);
  applySectionCrypto(nca, header.sections);
  return nca;
}
