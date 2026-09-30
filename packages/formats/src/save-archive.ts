/**
 * Save data archives: the uncompressed POSIX ustar files the Switch uploads when it backs up a
 * save, and downloads again to restore one. Any tar tool opens them.
 *
 * The Switch writes them deterministically, so the same save always produces the same bytes and
 * the same SHA-256, which is how an unchanged save is recognised and not stored twice:
 *
 * - one entry per directory (`name/`, typeflag `5`) and per file (typeflag `0`), no links;
 * - entries in byte order of their path, directories with their trailing slash;
 * - mode 0755 for directories and 0644 for files, uid, gid and mtime zero, no user or group names;
 * - paths longer than 100 bytes split at the last `/` that fits the 155-byte prefix field;
 * - two zero blocks at the end and nothing after them.
 *
 * `readSaveArchive` accepts any ustar or GNU tar with only files and directories, so an archive
 * made by another tool can still be restored.
 */
import { FormatError } from "./binary";
import { type RandomAccessReader, readExact } from "./reader";

export const TAR_BLOCK = 512;
/** ustar stores a path as a 155-byte prefix and a 100-byte name. */
export const SAVE_ARCHIVE_MAX_PATH = 255;
export const SAVE_ARCHIVE_MAX_ENTRIES = 100_000;
/** Largest size the 11 octal digits of a ustar size field hold. */
const MAX_ENTRY_SIZE = 0o77777777777;

export interface SaveArchiveInput {
  /** Relative path with `/` separators and no trailing slash, e.g. `slot1/progress.bin`. */
  path: string;
  /** File contents. Omit for a directory. */
  data?: Uint8Array;
}

export interface SaveArchiveEntry {
  path: string;
  type: "file" | "dir";
  size: number;
  /** Where the entry's data starts in the archive. */
  offset: number;
}

export interface SaveArchiveListing {
  entries: SaveArchiveEntry[];
  fileCount: number;
  /** Sum of the file sizes, without tar headers and padding. */
  dataSize: number;
}

/** Why a path cannot go in a save archive, or null when it can. */
export function saveArchivePathProblem(path: string): string | null {
  if (path.length === 0) return "empty path";
  if (Buffer.byteLength(path, "utf8") > SAVE_ARCHIVE_MAX_PATH - 1) {
    return `path is longer than ${SAVE_ARCHIVE_MAX_PATH - 1} bytes`;
  }
  if (path.includes("\0")) return "path contains a NUL byte";
  if (path.includes("\\")) return "path contains a backslash";
  if (path.startsWith("/")) return "path is absolute";
  for (const part of path.split("/")) {
    if (part === "") return "path has an empty component";
    if (part === "." || part === "..") return `path contains "${part}"`;
  }
  return null;
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function writeOctal(header: Buffer, offset: number, width: number, value: number): void {
  // width - 1 digits, then NUL.
  header.write(value.toString(8).padStart(width - 1, "0"), offset, width - 1, "latin1");
  header[offset + width - 1] = 0;
}

/** Splits a tar path into ustar prefix and name, or throws when it does not fit. */
export function splitUstarPath(tarPath: string): { prefix: string; name: string } {
  const bytes = Buffer.from(tarPath, "utf8");
  if (bytes.length <= 100) return { prefix: "", name: tarPath };
  for (let i = Math.min(155, bytes.length - 1); i >= 0; i--) {
    if (bytes[i] !== 0x2f) continue;
    const nameLength = bytes.length - i - 1;
    if (nameLength >= 1 && nameLength <= 100) {
      return {
        prefix: bytes.subarray(0, i).toString("utf8"),
        name: bytes.subarray(i + 1).toString("utf8"),
      };
    }
  }
  throw new FormatError("UNSUPPORTED", `path does not fit a ustar header: ${tarPath}`);
}

function ustarHeader(tarPath: string, type: "file" | "dir", size: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK);
  const { prefix, name } = splitUstarPath(tarPath);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, type === "dir" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type === "dir" ? 0x35 : 0x30;
  header.write("ustar\0", 257, 6, "latin1");
  header.write("00", 263, 2, "latin1");
  header.write(prefix, 345, 155, "utf8");
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, "0"), 148, 6, "latin1");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

/**
 * Builds a save archive the way the Switch does. Parent directories are added for every file and
 * directory listed, so `[{ path: "a/b.bin", data }]` also gets an `a/` entry.
 */
export function buildSaveArchive(inputs: readonly SaveArchiveInput[]): Buffer {
  const entries = new Map<string, Uint8Array | null>();
  for (const input of inputs) {
    const problem = saveArchivePathProblem(input.path);
    if (problem) throw new FormatError("INVALID", `${problem}: ${input.path}`);
    const parts = input.path.split("/");
    for (let i = 1; i < parts.length; i++) entries.set(`${parts.slice(0, i).join("/")}/`, null);
    if (input.data) {
      if (input.data.byteLength > MAX_ENTRY_SIZE) {
        throw new FormatError("UNSUPPORTED", `file is too large for ustar: ${input.path}`);
      }
      entries.set(input.path, input.data);
    } else {
      entries.set(`${input.path}/`, null);
    }
  }
  const chunks: Buffer[] = [];
  for (const tarPath of [...entries.keys()].sort(compareBytes)) {
    const data = entries.get(tarPath) ?? null;
    if (data === null) {
      chunks.push(ustarHeader(tarPath, "dir", 0));
      continue;
    }
    chunks.push(ustarHeader(tarPath, "file", data.byteLength));
    chunks.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    const pad = (TAR_BLOCK - (data.byteLength % TAR_BLOCK)) % TAR_BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2));
  return Buffer.concat(chunks);
}

function cString(buf: Buffer, offset: number, length: number): string {
  const field = buf.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString("utf8");
}

function parseOctal(buf: Buffer, offset: number, length: number, what: string): number {
  const text = buf
    .toString("latin1", offset, offset + length)
    .replace(/[\0 ]+$/, "")
    .replace(/^ +/, "");
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new FormatError("INVALID", `tar ${what} field is not octal: ${JSON.stringify(text)}`);
  }
  return Number.parseInt(text, 8);
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

/**
 * Lists and validates a save archive without extracting it. Throws a FormatError for anything
 * that is not a plain tree of files and directories with safe relative paths.
 */
export async function readSaveArchive(reader: RandomAccessReader): Promise<SaveArchiveListing> {
  if (reader.size % TAR_BLOCK !== 0) {
    throw new FormatError("INVALID", "archive size is not a multiple of 512 bytes");
  }
  const entries: SaveArchiveEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let fileCount = 0;
  let dataSize = 0;
  for (;;) {
    if (offset + TAR_BLOCK > reader.size) {
      throw new FormatError("TRUNCATED", "archive ends without the two zero blocks");
    }
    const header = await readExact(reader, offset, TAR_BLOCK);
    if (isZeroBlock(header)) {
      if (offset + TAR_BLOCK * 2 > reader.size) {
        throw new FormatError("TRUNCATED", "archive ends after a single zero block");
      }
      // Tools pad archives to a record size with more zero blocks; anything else is not a tar.
      for (let rest = offset + TAR_BLOCK; rest < reader.size; ) {
        const block = await readExact(reader, rest, Math.min(reader.size - rest, 64 * TAR_BLOCK));
        if (!isZeroBlock(block)) throw new FormatError("INVALID", "data after the end of archive");
        rest += block.length;
      }
      break;
    }

    const magic = header.toString("latin1", 257, 262);
    if (magic !== "ustar") throw new FormatError("BAD_MAGIC", "not a ustar archive");
    const stored = parseOctal(header, 148, 8, "checksum");
    let sum = 0;
    for (let i = 0; i < TAR_BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
    if (sum !== stored) throw new FormatError("INVALID", `bad header checksum at ${offset}`);

    const typeflag = String.fromCharCode(header[156] ?? 0);
    const name = cString(header, 0, 100);
    const prefix = cString(header, 345, 155);
    let path = prefix ? `${prefix}/${name}` : name;
    let type: SaveArchiveEntry["type"];
    if (typeflag === "5") {
      type = "dir";
      path = path.replace(/\/+$/, "");
    } else if (typeflag === "0" || typeflag === "\0") {
      type = "file";
    } else {
      throw new FormatError(
        "UNSUPPORTED",
        `unsupported tar entry type ${JSON.stringify(typeflag)}`,
      );
    }
    // `tar -cf save.tar .` names everything ./…, and adds the folder itself as "./".
    while (path.startsWith("./")) path = path.slice(2);
    if (type === "dir" && (path === "" || path === ".")) {
      offset += TAR_BLOCK;
      continue;
    }
    const problem = saveArchivePathProblem(path);
    if (problem) throw new FormatError("INVALID", `${problem}: ${path}`);
    if (seen.has(path)) throw new FormatError("INVALID", `duplicate entry: ${path}`);
    seen.add(path);

    const size = type === "dir" ? 0 : parseOctal(header, 124, 12, "size");
    const dataOffset = offset + TAR_BLOCK;
    const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (dataOffset + padded > reader.size) {
      throw new FormatError("TRUNCATED", `entry runs past the end of the archive: ${path}`);
    }
    entries.push({ path, type, size, offset: dataOffset });
    if (entries.length > SAVE_ARCHIVE_MAX_ENTRIES) {
      throw new FormatError("UNSUPPORTED", "archive has too many entries");
    }
    if (type === "file") {
      fileCount++;
      dataSize += size;
    }
    offset = dataOffset + padded;
  }

  // A file and a directory of the same name, or a file used as a directory, cannot be restored.
  const kinds = new Map(entries.map((entry) => [entry.path, entry.type]));
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (kinds.get(parts.slice(0, i).join("/")) === "file") {
        throw new FormatError("INVALID", `${entry.path} is inside a file`);
      }
    }
  }
  return { entries, fileCount, dataSize };
}
