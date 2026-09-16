/**
 * RomFS used by control NCAs (`control.nacp` and `icon_*.dat`). Offsets in the header are
 * relative to the start of the image.
 */
import { FormatError, hex, readU64 } from "./binary";

const HEADER_SIZE = 0x50;
const NONE = 0xffffffff;
const DIR_FIXED = 0x18;
const FILE_FIXED = 0x20;

export interface RomfsFile {
  /** Path relative to the RomFS root, using `/` separators and no leading slash. */
  path: string;
  /** Absolute offset of the file bytes within the RomFS image. */
  offset: number;
  size: number;
}

function padded(nameLength: number): number {
  return (nameLength + 3) & ~3;
}

function cString(buf: Buffer, offset: number, length: number): string {
  const end = buf.indexOf(0, offset);
  const stop = end === -1 || end > offset + length ? offset + length : end;
  return buf.toString("utf8", offset, stop);
}

function need(buf: Buffer, offset: number, size: number, what: string): void {
  if (offset < 0 || size < 0 || offset + size > buf.length) {
    throw new FormatError("TRUNCATED", `RomFS ${what} at ${hex(offset)} extends past the image`);
  }
}

export function parseRomfs(image: Buffer): RomfsFile[] {
  if (image.length < HEADER_SIZE) {
    throw new FormatError(
      "TRUNCATED",
      `RomFS is ${hex(image.length)} bytes, expected a 0x50 header`,
    );
  }
  const dirTableOffset = readU64(image, 0x18);
  const dirTableSize = readU64(image, 0x20);
  const fileTableOffset = readU64(image, 0x38);
  const fileTableSize = readU64(image, 0x40);
  const fileDataOffset = readU64(image, 0x48);
  need(image, dirTableOffset, dirTableSize, "directory table");
  need(image, fileTableOffset, fileTableSize, "file table");

  const dirs = image.subarray(dirTableOffset, dirTableOffset + dirTableSize);
  const files = image.subarray(fileTableOffset, fileTableOffset + fileTableSize);
  const out: RomfsFile[] = [];

  const walkDir = (dirOffset: number, prefix: string): void => {
    need(dirs, dirOffset, DIR_FIXED, "directory entry");
    const childDir = dirs.readUInt32LE(dirOffset + 0x08);
    const childFile = dirs.readUInt32LE(dirOffset + 0x0c);
    const nameLength = dirs.readUInt32LE(dirOffset + 0x14);
    need(dirs, dirOffset + DIR_FIXED, padded(nameLength), "directory name");
    const name = cString(dirs, dirOffset + DIR_FIXED, nameLength);
    const path = prefix && name ? `${prefix}/${name}` : name || prefix;

    if (childDir !== NONE) walkDir(childDir, path);
    const sibling = dirs.readUInt32LE(dirOffset + 0x04);
    if (sibling !== NONE) walkDir(sibling, prefix);

    let fileOffset = childFile;
    while (fileOffset !== NONE) {
      need(files, fileOffset, FILE_FIXED, "file entry");
      const next = files.readUInt32LE(fileOffset + 0x04);
      const dataOffset = readU64(files, fileOffset + 0x08);
      const size = readU64(files, fileOffset + 0x10);
      const fileNameLength = files.readUInt32LE(fileOffset + 0x1c);
      need(files, fileOffset + FILE_FIXED, padded(fileNameLength), "file name");
      const fileName = cString(files, fileOffset + FILE_FIXED, fileNameLength);
      const filePath = path ? `${path}/${fileName}` : fileName;
      const absolute = fileDataOffset + dataOffset;
      need(image, absolute, size, `file ${JSON.stringify(filePath)}`);
      out.push({ path: filePath, offset: absolute, size });
      fileOffset = next;
    }
  };

  if (dirTableSize >= DIR_FIXED) walkDir(0, "");
  return out;
}

export function readRomfsFile(image: Buffer, file: RomfsFile): Buffer {
  need(image, file.offset, file.size, `file ${JSON.stringify(file.path)}`);
  return Buffer.from(image.subarray(file.offset, file.offset + file.size));
}
