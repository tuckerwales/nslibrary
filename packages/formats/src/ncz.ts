/**
 * NCZ: an NCA whose first 0x4000 bytes are kept verbatim, followed by a section table
 * (NCZSECTN) and the *decrypted* remainder compressed with zstd, either as one solid
 * stream or as independently compressed blocks (NCZBLOCK). Restoring the NCA means
 * decompressing and re-applying AES-CTR to the encrypted sections.
 *
 * Layout reference: nicoboss/nsz docs/formats.md.
 */
import { Readable } from "node:stream";
import { createZstdDecompress, zstdDecompressSync } from "node:zlib";
import { FormatError, hex, readMagic, readU64 } from "./binary";
import { aesCtrAt } from "./crypto";
import { type RandomAccessReader, readExact } from "./reader";

export const NCZ_UNCOMPRESSED_PREFIX_SIZE = 0x4000;
const SECTION_TABLE_HEADER_SIZE = 0x10;
const SECTION_ENTRY_SIZE = 0x40;
const BLOCK_HEADER_SIZE = 0x18;
// Patch NCAs are BKTR, and nsz writes one section per AES-CTR subsection, so a large update
// carries thousands (a 10 GB Witcher 3 update has 8711). This only stops a corrupt count.
const MAX_SECTIONS = 1 << 18;
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
 * Applies AES-CTR to the CTR/BKTR parts of `chunk` in place, which holds the NCA bytes starting at
 * `absoluteOffset`. CTR is its own inverse, so this re-encrypts when restoring and decrypts when
 * encoding. `sections` must be sorted by offset and chunks must arrive in order; the returned
 * cursor skips sections that ended before this chunk, so thousands of sections don't make every
 * chunk rescan the table.
 */
export function applyNczSectionCrypto(
  chunk: Buffer,
  absoluteOffset: number,
  sections: readonly NczSection[],
  cursor: number,
): number {
  const chunkEnd = absoluteOffset + chunk.length;
  let next = cursor;
  while (next < sections.length) {
    const section = sections[next];
    if (!section || section.offset + section.size > absoluteOffset) break;
    next++;
  }
  for (let i = next; i < sections.length; i++) {
    const section = sections[i];
    if (!section || section.offset >= chunkEnd) break;
    if (section.cryptoType !== NczCryptoType.Ctr && section.cryptoType !== NczCryptoType.Bktr)
      continue;
    const start = Math.max(section.offset, absoluteOffset, NCZ_UNCOMPRESSED_PREFIX_SIZE);
    const stop = Math.min(section.offset + section.size, chunkEnd);
    if (stop <= start) continue;
    const view = chunk.subarray(start - absoluteOffset, stop - absoluteOffset);
    aesCtrAt(section.cryptoKey, section.cryptoCounter, start, view).copy(view);
  }
  return next;
}

const READ_CHUNK = 1024 * 1024;

async function* solidBody(reader: RandomAccessReader, dataOffset: number): AsyncGenerator<Buffer> {
  const decompress = createZstdDecompress();
  const input = Readable.from(
    (async function* () {
      for (let offset = dataOffset; offset < reader.size; offset += READ_CHUNK) {
        yield await readExact(reader, offset, Math.min(READ_CHUNK, reader.size - offset));
      }
    })(),
  );
  input.on("error", (err) => decompress.destroy(err));
  input.pipe(decompress);
  try {
    for await (const chunk of decompress) yield chunk as Buffer;
  } finally {
    input.destroy();
    decompress.destroy();
  }
}

async function* blockBody(
  reader: RandomAccessReader,
  header: NczHeader & { block: NczBlockInfo },
): AsyncGenerator<Buffer> {
  const { blockSize, decompressedSize, compressedBlockSizes } = header.block;
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
    remaining -= expected;
    yield block;
  }
}

/**
 * Restores the original NCA as a sequence of chunks, holding about one block (or 1 MiB of solid
 * stream) in memory at a time. Use this for anything that may be large.
 */
export async function* restoreNczChunks(reader: RandomAccessReader): AsyncGenerator<Buffer> {
  const header = await parseNczHeader(reader);
  const sections = [...header.sections].sort((a, b) => a.offset - b.offset);
  yield await readExact(reader, 0, NCZ_UNCOMPRESSED_PREFIX_SIZE);

  const body = header.block
    ? blockBody(reader, header as NczHeader & { block: NczBlockInfo })
    : solidBody(reader, header.dataOffset);
  let offset = NCZ_UNCOMPRESSED_PREFIX_SIZE;
  let cursor = 0;
  for await (const chunk of body) {
    // Raw blocks can be views of the reader's buffer, and stream chunks can share the decoder's
    // memory, so copy before encrypting in place.
    const owned = Buffer.from(chunk);
    cursor = applyNczSectionCrypto(owned, offset, sections, cursor);
    offset += owned.length;
    yield owned;
  }
}

/** Restores the original NCA fully in memory. Only for small NCAs; see `restoreNczChunks`. */
export async function decompressNczToBuffer(reader: RandomAccessReader): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of restoreNczChunks(reader)) chunks.push(chunk);
  return Buffer.concat(chunks);
}
