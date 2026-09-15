import { FormatError, hex } from "./binary";

/** Random access over a file, HTTP range source, or buffer. Parsers only depend on this. */
export interface RandomAccessReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export class BufferReader implements RandomAccessReader {
  readonly size: number;
  readonly #buffer: Buffer;

  constructor(buffer: Buffer) {
    this.#buffer = buffer;
    this.size = buffer.length;
  }

  async read(offset: number, length: number): Promise<Buffer> {
    return this.#buffer.subarray(offset, offset + length);
  }
}

/** A window onto part of another reader, e.g. one entry inside an NSP. */
export class SliceReader implements RandomAccessReader {
  readonly size: number;
  readonly #parent: RandomAccessReader;
  readonly #start: number;

  constructor(parent: RandomAccessReader, start: number, size: number) {
    if (start < 0 || size < 0 || start + size > parent.size) {
      throw new FormatError(
        "TRUNCATED",
        `slice ${hex(start)}+${hex(size)} exceeds parent size ${hex(parent.size)}`,
      );
    }
    this.#parent = parent;
    this.#start = start;
    this.size = size;
  }

  read(offset: number, length: number): Promise<Buffer> {
    return this.#parent.read(this.#start + offset, length);
  }
}

export async function readExact(
  reader: RandomAccessReader,
  offset: number,
  length: number,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > reader.size
  ) {
    throw new FormatError(
      "TRUNCATED",
      `read of ${length} bytes at ${hex(offset)} exceeds size ${hex(reader.size)}`,
    );
  }
  const buf = await reader.read(offset, length);
  if (buf.length !== length) {
    throw new FormatError(
      "TRUNCATED",
      `short read at ${hex(offset)}: wanted ${length}, got ${buf.length}`,
    );
  }
  return buf;
}
