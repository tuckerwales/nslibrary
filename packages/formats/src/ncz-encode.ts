/**
 * NCZ encoding, the inverse of `restoreNczChunks`: the first 0x4000 bytes are kept, the NCA's
 * encrypted sections are decrypted so zstd sees plaintext, and the rest is compressed as
 * independent blocks (NCZBLOCK). Blocks keep the Switch's memory use to one block and let
 * several compress at once.
 *
 * AES-CTR is its own inverse and a decoder re-applies exactly the section table written here, so
 * a section planned with the wrong counter still restores byte for byte. It only compresses
 * badly. That is why a BKTR table this code can't follow falls back to the base counter instead
 * of failing.
 */
import { promisify } from "node:util";
import { constants, zstdCompress } from "node:zlib";
import { FormatError, hex, readMagic, readU64 } from "./binary";
import { aesCtrAt } from "./crypto";
import type { Keyset } from "./keys";
import {
  decryptNcaHeader,
  NCA_HEADER_SIZE,
  NcaEncryptionType,
  type NcaInfo,
  type NcaSection,
  parseDecryptedNcaHeader,
} from "./nca";
import {
  applyNczSectionCrypto,
  NCZ_UNCOMPRESSED_PREFIX_SIZE,
  NczCryptoType,
  type NczSection,
} from "./ncz";
import { type RandomAccessReader, readExact } from "./reader";

const SECTION_TABLE_HEADER_SIZE = 0x10;
const SECTION_ENTRY_SIZE = 0x40;
const BLOCK_HEADER_SIZE = 0x18;
/** What nsz writes; decoders don't check either. */
const BLOCK_VERSION = 2;
const BLOCK_TYPE = 1;
/** 1 MiB blocks, nsz's default. */
export const NCZ_DEFAULT_BLOCK_SIZE_EXPONENT = 20;
const MIN_BLOCK_EXPONENT = 14;
const MAX_BLOCK_EXPONENT = 32;

const FS_HEADER_OFFSET = 0x400;
const FS_HEADER_SIZE = 0x200;
/** BucketTree layout of a BKTR AesCtrEx table: 16 KiB nodes of 16-byte entries. */
const BKTR_NODE_SIZE = 0x4000;
const BKTR_NODE_HEADER_SIZE = 0x10;
const BKTR_ENTRY_SIZE = 0x10;
const BKTR_MAX_ENTRIES_PER_NODE = (BKTR_NODE_SIZE - BKTR_NODE_HEADER_SIZE) / BKTR_ENTRY_SIZE;
const BKTR_MAX_NODES = (BKTR_NODE_SIZE - BKTR_NODE_HEADER_SIZE) / 8;

export interface NczPlan {
  nca: NcaInfo;
  /** Sorted by offset and non-overlapping, ready for `encodeNcz`. */
  sections: NczSection[];
  /** Sections whose BKTR table couldn't be read and were planned with the base counter. */
  bktrFallbacks: number;
}

function counterWithGeneration(base: Buffer, generation: number): Buffer {
  const counter = Buffer.from(base);
  counter.writeUInt32BE(generation >>> 0, 4);
  return counter;
}

/**
 * Splits a BKTR (AesCtrEx) section into its subsections, each with its own counter generation.
 * The table is stored at the end of the section under the base counter, as are the bytes after
 * the region it describes. Returns null when the table doesn't look sound.
 */
async function bktrSubsections(
  reader: RandomAccessReader,
  section: NcaSection,
  key: Buffer,
  fsHeader: Buffer,
): Promise<NczSection[] | null> {
  try {
    const tableOffset = readU64(fsHeader, 0x120);
    const tableSize = readU64(fsHeader, 0x128);
    const entryCount = fsHeader.readUInt32LE(0x138);
    if (readMagic(fsHeader, 0x130, 4) !== "BKTR" || entryCount === 0) return null;
    if (tableSize < 2 * BKTR_NODE_SIZE || tableOffset + tableSize > section.size) return null;

    const absoluteTable = section.offset + tableOffset;
    const table = aesCtrAt(
      key,
      section.cryptoCounter,
      absoluteTable,
      await readExact(reader, absoluteTable, tableSize),
    );
    const nodeCount = table.readUInt32LE(4);
    const end = readU64(table, 8);
    if (nodeCount === 0 || nodeCount > BKTR_MAX_NODES) return null;
    if ((nodeCount + 1) * BKTR_NODE_SIZE > table.length || end > tableOffset) return null;

    const starts: { offset: number; generation: number }[] = [];
    for (let node = 0; node < nodeCount; node++) {
      const base = (node + 1) * BKTR_NODE_SIZE;
      const count = table.readUInt32LE(base + 4);
      if (count === 0 || count > BKTR_MAX_ENTRIES_PER_NODE) return null;
      for (let i = 0; i < count; i++) {
        const o = base + BKTR_NODE_HEADER_SIZE + i * BKTR_ENTRY_SIZE;
        const offset = readU64(table, o);
        const previous = starts.at(-1);
        if ((previous && offset < previous.offset) || offset > end) return null;
        starts.push({ offset, generation: table.readUInt32LE(o + 0x0c) });
      }
    }
    if (starts.length !== entryCount || starts[0]?.offset !== 0) return null;

    const sections: NczSection[] = [];
    starts.forEach((start, i) => {
      const stop = starts[i + 1]?.offset ?? end;
      if (stop <= start.offset) return;
      sections.push({
        offset: section.offset + start.offset,
        size: stop - start.offset,
        cryptoType: NczCryptoType.Bktr,
        cryptoKey: key,
        cryptoCounter: counterWithGeneration(section.cryptoCounter, start.generation),
      });
    });
    if (end < section.size) {
      sections.push({
        offset: section.offset + end,
        size: section.size - end,
        cryptoType: NczCryptoType.Ctr,
        cryptoKey: key,
        cryptoCounter: section.cryptoCounter,
      });
    }
    return sections;
  } catch (err) {
    if (err instanceof FormatError) return null;
    throw err;
  }
}

/**
 * Reads an NCA's header and works out the NCZ section table for it. Throws `MissingKeyError` when
 * a key (or the title key, for rights-ID content) is missing, and `FormatError` "UNSUPPORTED" for
 * AES-XTS sections, which NCZ can't describe.
 */
export async function planNczSections(
  reader: RandomAccessReader,
  keys: Keyset,
  titleKey?: Buffer,
): Promise<NczPlan> {
  if (reader.size <= NCZ_UNCOMPRESSED_PREFIX_SIZE) {
    throw new FormatError("INVALID", `NCA is ${hex(reader.size)} bytes, too small for NCZ`);
  }
  const header = decryptNcaHeader(await readExact(reader, 0, NCA_HEADER_SIZE), keys);
  const nca = parseDecryptedNcaHeader(header, keys, titleKey, { allowAesCtrEx: true });

  const sections: NczSection[] = [];
  let bktrFallbacks = 0;
  for (const section of nca.sections) {
    if (section.end > reader.size) {
      throw new FormatError(
        "TRUNCATED",
        `NCA section ${section.index} ends at ${hex(section.end)}, past ${hex(reader.size)}`,
      );
    }
    const key = section.cryptoKey;
    if (section.encryptionType === NcaEncryptionType.None || !key) {
      sections.push({
        offset: section.offset,
        size: section.size,
        cryptoType: NczCryptoType.None,
        cryptoKey: Buffer.alloc(16),
        cryptoCounter: section.cryptoCounter,
      });
      continue;
    }
    if (section.encryptionType === NcaEncryptionType.AesCtrEx) {
      const fsStart = FS_HEADER_OFFSET + section.index * FS_HEADER_SIZE;
      const fsHeader = header.subarray(fsStart, fsStart + FS_HEADER_SIZE);
      const subsections = await bktrSubsections(reader, section, key, fsHeader);
      if (subsections) {
        sections.push(...subsections);
        continue;
      }
      bktrFallbacks++;
    }
    sections.push({
      offset: section.offset,
      size: section.size,
      cryptoType: NczCryptoType.Ctr,
      cryptoKey: key,
      cryptoCounter: section.cryptoCounter,
    });
  }

  sections.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sections.length; i++) {
    const previous = sections[i - 1];
    const current = sections[i];
    if (previous && current && previous.offset + previous.size > current.offset) {
      throw new FormatError("INVALID", `NCA sections overlap at ${hex(current.offset)}`);
    }
  }
  if (sections.length === 0) throw new FormatError("INVALID", "NCA has no sections");
  // The Switch client sizes the restored NCA from the furthest section end, so bytes after the
  // last section (padding some tools add) get a plain section of their own.
  const last = sections.at(-1);
  const end = last ? last.offset + last.size : 0;
  if (end < reader.size) {
    sections.push({
      offset: Math.max(end, NCZ_UNCOMPRESSED_PREFIX_SIZE),
      size: reader.size - Math.max(end, NCZ_UNCOMPRESSED_PREFIX_SIZE),
      cryptoType: NczCryptoType.None,
      cryptoKey: Buffer.alloc(16),
      cryptoCounter: Buffer.alloc(16),
    });
  }
  return { nca, sections, bktrFallbacks };
}

export type BlockCompressor = (block: Buffer) => Promise<Buffer>;

/** zstd on libuv's thread pool. Servers that also stream files may prefer a worker pool. */
export function zstdBlockCompressor(level: number): BlockCompressor {
  const compress = promisify(zstdCompress);
  const options = { params: { [constants.ZSTD_c_compressionLevel]: level } };
  return (block) => compress(block, options);
}

export interface NczEncodeOptions {
  compressBlock: BlockCompressor;
  blockSizeExponent?: number;
  /** Blocks compressing at once. */
  parallelBlocks?: number;
  /** Checked between blocks; aborting rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Receives the original NCA bytes in order, as they are read (for hashing and progress). */
  onSource?: (chunk: Buffer) => void;
}

export interface NczEncodeResult {
  /** Bytes written. */
  size: number;
  /**
   * The block size table is written as zeros, since sizes are known only once every block is
   * compressed. Write `data` at `offset` (relative to the start of the NCZ) to finish the file.
   */
  blockTable: { offset: number; data: Buffer };
}

function sectionTable(sections: readonly NczSection[]): Buffer {
  const table = Buffer.alloc(SECTION_TABLE_HEADER_SIZE + sections.length * SECTION_ENTRY_SIZE);
  table.write("NCZSECTN", 0, "latin1");
  table.writeBigUInt64LE(BigInt(sections.length), 0x08);
  sections.forEach((section, i) => {
    const o = SECTION_TABLE_HEADER_SIZE + i * SECTION_ENTRY_SIZE;
    table.writeBigUInt64LE(BigInt(section.offset), o);
    table.writeBigUInt64LE(BigInt(section.size), o + 0x08);
    table.writeBigUInt64LE(BigInt(section.cryptoType), o + 0x10);
    section.cryptoKey.copy(table, o + 0x20);
    section.cryptoCounter.copy(table, o + 0x30);
  });
  return table;
}

/**
 * Writes `reader` (a whole NCA) as a block-mode NCZ through `write`, which must append. Holds
 * about `parallelBlocks` blocks in memory.
 */
export async function encodeNcz(
  reader: RandomAccessReader,
  sections: readonly NczSection[],
  write: (chunk: Buffer) => Promise<void>,
  options: NczEncodeOptions,
): Promise<NczEncodeResult> {
  const exponent = options.blockSizeExponent ?? NCZ_DEFAULT_BLOCK_SIZE_EXPONENT;
  if (exponent < MIN_BLOCK_EXPONENT || exponent > MAX_BLOCK_EXPONENT) {
    throw new FormatError("INVALID", `NCZ block size exponent ${exponent} out of range`);
  }
  if (reader.size <= NCZ_UNCOMPRESSED_PREFIX_SIZE) {
    throw new FormatError("INVALID", `NCA is ${hex(reader.size)} bytes, too small for NCZ`);
  }
  const blockSize = 2 ** exponent;
  const bodySize = reader.size - NCZ_UNCOMPRESSED_PREFIX_SIZE;
  const blockCount = Math.ceil(bodySize / blockSize);
  const parallel = Math.max(1, options.parallelBlocks ?? 1);
  const sorted = [...sections].sort((a, b) => a.offset - b.offset);
  const { signal, onSource } = options;

  let size = 0;
  const append = async (chunk: Buffer) => {
    await write(chunk);
    size += chunk.length;
  };

  const prefix = await readExact(reader, 0, NCZ_UNCOMPRESSED_PREFIX_SIZE);
  onSource?.(prefix);
  await append(prefix);
  await append(sectionTable(sorted));

  const blockHeader = Buffer.alloc(BLOCK_HEADER_SIZE);
  blockHeader.write("NCZBLOCK", 0, "latin1");
  blockHeader.writeUInt8(BLOCK_VERSION, 0x08);
  blockHeader.writeUInt8(BLOCK_TYPE, 0x09);
  blockHeader.writeUInt8(exponent, 0x0b);
  blockHeader.writeUInt32LE(blockCount, 0x0c);
  blockHeader.writeBigUInt64LE(BigInt(bodySize), 0x10);
  await append(blockHeader);
  const sizes = Buffer.alloc(blockCount * 4);
  const blockTableOffset = size;
  await append(sizes);

  // Blocks are read and decrypted in order on this thread, compressed in parallel, and written
  // in order as the oldest one finishes.
  const inFlight: { plain: Buffer; compressed: Promise<Buffer> }[] = [];
  const flushOldest = async (index: number) => {
    const oldest = inFlight.shift();
    if (!oldest) return;
    const compressed = await oldest.compressed;
    // Stored raw when zstd doesn't help, which decoders recognise by the size.
    const stored = compressed.length < oldest.plain.length ? compressed : oldest.plain;
    sizes.writeUInt32LE(stored.length, index * 4);
    await append(stored);
  };

  let cursor = 0;
  let written = 0;
  try {
    for (let block = 0; block < blockCount; block++) {
      signal?.throwIfAborted();
      const offset = NCZ_UNCOMPRESSED_PREFIX_SIZE + block * blockSize;
      const raw = await readExact(reader, offset, Math.min(blockSize, reader.size - offset));
      onSource?.(raw);
      // The reader may hand out views of memory it still owns, so decrypt a copy.
      const plain = Buffer.from(raw);
      cursor = applyNczSectionCrypto(plain, offset, sorted, cursor);
      const compressed = options.compressBlock(plain);
      // Settled later in order; this keeps an early failure from being reported as unhandled.
      compressed.catch(() => {});
      inFlight.push({ plain, compressed });
      if (inFlight.length >= parallel) await flushOldest(written++);
    }
    while (inFlight.length > 0) {
      signal?.throwIfAborted();
      await flushOldest(written++);
    }
  } finally {
    inFlight.length = 0;
  }

  return { size, blockTable: { offset: blockTableOffset, data: sizes } };
}
