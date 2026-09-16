const HEADER_SIZE = 0x50;
const NONE = 0xffffffff;

function padded(length: number): number {
  return (length + 3) & ~3;
}

export interface RomfsFileSpec {
  name: string;
  data: Buffer;
}

/** Root-only RomFS (enough for `control.nacp` + `icon_*.dat`). */
export function buildRomfs(files: RomfsFileSpec[]): Buffer {
  const dirNamePad = 0;
  const dirEntry = Buffer.alloc(0x18 + dirNamePad);
  dirEntry.writeUInt32LE(0, 0x00);
  dirEntry.writeUInt32LE(NONE, 0x04);
  dirEntry.writeUInt32LE(NONE, 0x08);
  dirEntry.writeUInt32LE(files.length === 0 ? NONE : 0, 0x0c);
  dirEntry.writeUInt32LE(NONE, 0x10);
  dirEntry.writeUInt32LE(0, 0x14);

  const fileEntries: Buffer[] = [];
  const payloads: Buffer[] = [];
  let dataOffset = 0;
  let tableOffset = 0;
  files.forEach((file, i) => {
    const name = Buffer.from(file.name, "utf8");
    const entry = Buffer.alloc(0x20 + padded(name.length));
    const next = i === files.length - 1 ? NONE : tableOffset + entry.length;
    entry.writeUInt32LE(0, 0x00);
    entry.writeUInt32LE(next, 0x04);
    entry.writeBigUInt64LE(BigInt(dataOffset), 0x08);
    entry.writeBigUInt64LE(BigInt(file.data.length), 0x10);
    entry.writeUInt32LE(NONE, 0x18);
    entry.writeUInt32LE(name.length, 0x1c);
    name.copy(entry, 0x20);
    fileEntries.push(entry);
    payloads.push(file.data);
    dataOffset += file.data.length;
    tableOffset += entry.length;
  });

  const fileTable = Buffer.concat(fileEntries);
  const fileData = Buffer.concat(payloads);
  const dirHash = Buffer.alloc(4, 0xff);
  const fileHash = Buffer.alloc(4, 0xff);

  const header = Buffer.alloc(HEADER_SIZE);
  header.writeBigUInt64LE(BigInt(HEADER_SIZE), 0x00);
  let cursor = HEADER_SIZE;
  header.writeBigUInt64LE(BigInt(cursor), 0x08);
  header.writeBigUInt64LE(BigInt(dirHash.length), 0x10);
  cursor += dirHash.length;
  header.writeBigUInt64LE(BigInt(cursor), 0x18);
  header.writeBigUInt64LE(BigInt(dirEntry.length), 0x20);
  cursor += dirEntry.length;
  header.writeBigUInt64LE(BigInt(cursor), 0x28);
  header.writeBigUInt64LE(BigInt(fileHash.length), 0x30);
  cursor += fileHash.length;
  header.writeBigUInt64LE(BigInt(cursor), 0x38);
  header.writeBigUInt64LE(BigInt(fileTable.length), 0x40);
  cursor += fileTable.length;
  header.writeBigUInt64LE(BigInt(cursor), 0x48);

  return Buffer.concat([header, dirHash, dirEntry, fileHash, fileTable, fileData]);
}
