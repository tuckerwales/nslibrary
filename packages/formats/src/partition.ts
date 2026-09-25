/**
 * PFS0 (NSP/NSZ) and HFS0 (XCI partitions). Both are a 0x10 header, fixed-size entries,
 * a string table, then file data; entry offsets are relative to the end of the header.
 */
import { alignUp, FormatError, hex, readMagic, readU64 } from "./binary";
import { type RandomAccessReader, readExact } from "./reader";

export type EntryKind = "cnmt" | "nca" | "ncz" | "tik" | "cert" | "other";

export interface PartitionEntry {
  name: string;
  /** Absolute offset within the reader. */
  offset: number;
  size: number;
  kind: EntryKind;
}

export interface Hfs0Entry extends PartitionEntry {
  hashedSize: number;
  sha256: Buffer;
}

export interface Partition<E extends PartitionEntry> {
  /** Absolute offset of the partition header. */
  offset: number;
  headerSize: number;
  entries: E[];
}

const PFS0_ENTRY_SIZE = 0x18;
const HFS0_ENTRY_SIZE = 0x40;
const MAX_ENTRIES = 0x4000;
const MAX_STRING_TABLE_SIZE = 0x100000;

export function classifyEntry(name: string): EntryKind {
  const lower = name.toLowerCase();
  if (lower.endsWith(".cnmt.nca") || lower.endsWith(".cnmt.ncz")) return "cnmt";
  if (lower.endsWith(".nca")) return "nca";
  if (lower.endsWith(".ncz")) return "ncz";
  if (lower.endsWith(".tik")) return "tik";
  if (lower.endsWith(".cert")) return "cert";
  return "other";
}

interface RawPartition {
  header: Buffer;
  count: number;
  headerSize: number;
  stringTableOffset: number;
}

async function readPartitionHeader(
  reader: RandomAccessReader,
  base: number,
  end: number,
  magic: string,
  entrySize: number,
): Promise<RawPartition> {
  if (base + 0x10 > end) {
    throw new FormatError("TRUNCATED", `${magic} header at ${hex(base)} extends past ${hex(end)}`);
  }
  const fixed = await readExact(reader, base, 0x10);
  const actual = readMagic(fixed, 0, 4);
  if (actual !== magic) {
    throw new FormatError(
      "BAD_MAGIC",
      `expected ${magic} at ${hex(base)}, found ${JSON.stringify(actual)}`,
    );
  }
  const count = fixed.readUInt32LE(4);
  const stringTableSize = fixed.readUInt32LE(8);
  if (count > MAX_ENTRIES) {
    throw new FormatError("INVALID", `${magic} at ${hex(base)} claims ${count} entries`);
  }
  if (stringTableSize > MAX_STRING_TABLE_SIZE) {
    throw new FormatError(
      "INVALID",
      `${magic} at ${hex(base)} has a ${stringTableSize}-byte string table`,
    );
  }
  const stringTableOffset = 0x10 + count * entrySize;
  const headerSize = stringTableOffset + stringTableSize;
  if (base + headerSize > end) {
    throw new FormatError("TRUNCATED", `${magic} header at ${hex(base)} extends past ${hex(end)}`);
  }
  const header = await readExact(reader, base, headerSize);
  return { header, count, headerSize, stringTableOffset };
}

function entryName(raw: RawPartition, nameOffset: number, index: number): string {
  const start = raw.stringTableOffset + nameOffset;
  if (start >= raw.headerSize) {
    throw new FormatError(
      "INVALID",
      `entry ${index} name offset ${hex(nameOffset)} is outside the string table`,
    );
  }
  const nul = raw.header.indexOf(0, start);
  return raw.header.toString("utf8", start, nul === -1 ? raw.headerSize : nul);
}

function entryBounds(name: string, offset: number, size: number, end: number): void {
  if (offset + size > end) {
    throw new FormatError(
      "TRUNCATED",
      `entry ${JSON.stringify(name)} at ${hex(offset)}+${hex(size)} extends past ${hex(end)}`,
    );
  }
}

export async function parsePfs0(
  reader: RandomAccessReader,
  base = 0,
  end = reader.size,
): Promise<Partition<PartitionEntry>> {
  const raw = await readPartitionHeader(reader, base, end, "PFS0", PFS0_ENTRY_SIZE);
  const dataStart = base + raw.headerSize;
  const entries: PartitionEntry[] = [];
  for (let i = 0; i < raw.count; i++) {
    const o = 0x10 + i * PFS0_ENTRY_SIZE;
    const name = entryName(raw, raw.header.readUInt32LE(o + 0x10), i);
    const offset = dataStart + readU64(raw.header, o);
    const size = readU64(raw.header, o + 0x08);
    entryBounds(name, offset, size, end);
    entries.push({ name, offset, size, kind: classifyEntry(name) });
  }
  return { offset: base, headerSize: raw.headerSize, entries };
}

export async function parseHfs0(
  reader: RandomAccessReader,
  base = 0,
  end = reader.size,
): Promise<Partition<Hfs0Entry>> {
  const raw = await readPartitionHeader(reader, base, end, "HFS0", HFS0_ENTRY_SIZE);
  const dataStart = base + raw.headerSize;
  const entries: Hfs0Entry[] = [];
  for (let i = 0; i < raw.count; i++) {
    const o = 0x10 + i * HFS0_ENTRY_SIZE;
    const name = entryName(raw, raw.header.readUInt32LE(o + 0x10), i);
    const offset = dataStart + readU64(raw.header, o);
    const size = readU64(raw.header, o + 0x08);
    entryBounds(name, offset, size, end);
    entries.push({
      name,
      offset,
      size,
      kind: classifyEntry(name),
      hashedSize: raw.header.readUInt32LE(o + 0x14),
      sha256: Buffer.from(raw.header.subarray(o + 0x20, o + 0x40)),
    });
  }
  return { offset: base, headerSize: raw.headerSize, entries };
}

export interface Pfs0HeaderEntry {
  name: string;
  size: number;
}

/**
 * A PFS0 header for files stored back to back in `entries` order. Its length depends only on the
 * names, so a writer can reserve it, stream the files, and write it again once sizes are known.
 * The string table is padded so file data starts on an `align` boundary, as nsz does.
 */
export function buildPfs0Header(entries: readonly Pfs0HeaderEntry[], align = 0x20): Buffer {
  const names = entries.map((entry) => Buffer.from(`${entry.name}\0`, "utf8"));
  const fixedSize = 0x10 + entries.length * PFS0_ENTRY_SIZE;
  const namesSize = names.reduce((sum, name) => sum + name.length, 0);
  const stringTableSize = alignUp(fixedSize + namesSize, align) - fixedSize;
  const header = Buffer.alloc(fixedSize + stringTableSize);
  header.write("PFS0", 0, "latin1");
  header.writeUInt32LE(entries.length, 4);
  header.writeUInt32LE(stringTableSize, 8);

  let dataOffset = 0;
  let nameOffset = 0;
  entries.forEach((entry, i) => {
    const o = 0x10 + i * PFS0_ENTRY_SIZE;
    header.writeBigUInt64LE(BigInt(dataOffset), o);
    header.writeBigUInt64LE(BigInt(entry.size), o + 0x08);
    header.writeUInt32LE(nameOffset, o + 0x10);
    names[i]?.copy(header, fixedSize + nameOffset);
    dataOffset += entry.size;
    nameOffset += names[i]?.length ?? 0;
  });
  return header;
}
