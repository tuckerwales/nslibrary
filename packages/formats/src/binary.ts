export type FormatErrorCode = "BAD_MAGIC" | "TRUNCATED" | "INVALID" | "UNSUPPORTED";

export class FormatError extends Error {
  readonly code: FormatErrorCode;

  constructor(code: FormatErrorCode, message: string) {
    super(message);
    this.name = "FormatError";
    this.code = code;
  }
}

export function hex(offset: number): string {
  return `0x${offset.toString(16)}`;
}

/** Reads a little-endian u64 that must fit in a JS number (all real file offsets do). */
export function readU64(buf: Buffer, offset: number): number {
  const value = buf.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new FormatError("INVALID", `u64 at ${hex(offset)} is out of range`);
  }
  return Number(value);
}

export function readMagic(buf: Buffer, offset: number, length: number): string {
  return buf.toString("latin1", offset, offset + length);
}

/** Title IDs are stored as little-endian u64 and displayed as 16 uppercase hex digits. */
export function readTitleId(buf: Buffer, offset: number): string {
  return buf.readBigUInt64LE(offset).toString(16).toUpperCase().padStart(16, "0");
}

export function writeTitleId(buf: Buffer, offset: number, titleId: string): void {
  buf.writeBigUInt64LE(BigInt(`0x${titleId}`), offset);
}

export function alignUp(value: number, alignment: number): number {
  if (alignment <= 0) return value;
  return Math.ceil(value / alignment) * alignment;
}
