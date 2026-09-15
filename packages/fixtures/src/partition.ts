import { createHash } from "node:crypto";

export interface FixtureFile {
  name: string;
  data: Uint8Array;
}

export interface PartitionBuildOptions {
  /** Pad the string table so file data starts on this boundary. */
  align?: number;
}

export interface Hfs0BuildOptions extends PartitionBuildOptions {
  /** Bytes covered by each entry's SHA-256 (clamped to the entry size). */
  hashedSize?: number;
}

function buildStringTable(names: string[], fixedSize: number, align: number) {
  const offsets: number[] = [];
  const parts: Buffer[] = [];
  let length = 0;
  for (const name of names) {
    offsets.push(length);
    const encoded = Buffer.from(`${name}\0`, "utf8");
    parts.push(encoded);
    length += encoded.length;
  }
  const padding = (align - ((fixedSize + length) % align)) % align;
  parts.push(Buffer.alloc(padding));
  return { table: Buffer.concat(parts), offsets };
}

function buildPartition(
  magic: "PFS0" | "HFS0",
  entrySize: number,
  files: FixtureFile[],
  align: number,
  writeExtra: (header: Buffer, entryOffset: number, file: FixtureFile) => void,
): Buffer {
  const fixedSize = 0x10 + files.length * entrySize;
  const { table, offsets } = buildStringTable(
    files.map((f) => f.name),
    fixedSize,
    align,
  );
  const header = Buffer.alloc(fixedSize);
  header.write(magic, 0, "latin1");
  header.writeUInt32LE(files.length, 4);
  header.writeUInt32LE(table.length, 8);

  let dataOffset = 0;
  files.forEach((file, i) => {
    const o = 0x10 + i * entrySize;
    header.writeBigUInt64LE(BigInt(dataOffset), o);
    header.writeBigUInt64LE(BigInt(file.data.length), o + 0x08);
    header.writeUInt32LE(offsets[i] ?? 0, o + 0x10);
    writeExtra(header, o, file);
    dataOffset += file.data.length;
  });

  return Buffer.concat([header, table, ...files.map((f) => f.data)]);
}

export function buildPfs0(files: FixtureFile[], options: PartitionBuildOptions = {}): Buffer {
  return buildPartition("PFS0", 0x18, files, options.align ?? 0x20, () => {});
}

export function buildHfs0(files: FixtureFile[], options: Hfs0BuildOptions = {}): Buffer {
  const hashedSize = options.hashedSize ?? 0x200;
  return buildPartition("HFS0", 0x40, files, options.align ?? 0x20, (header, o, file) => {
    const covered = Math.min(hashedSize, file.data.length);
    header.writeUInt32LE(covered, o + 0x14);
    createHash("sha256")
      .update(file.data.subarray(0, covered))
      .digest()
      .copy(header, o + 0x20);
  });
}

/** Size of a built partition's header (fixed part + entries + string table). */
export function partitionHeaderSize(partition: Buffer): number {
  const entrySize = partition.toString("latin1", 0, 4) === "HFS0" ? 0x40 : 0x18;
  return 0x10 + partition.readUInt32LE(4) * entrySize + partition.readUInt32LE(8);
}
