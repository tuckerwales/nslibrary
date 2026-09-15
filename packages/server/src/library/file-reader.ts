import { type FileHandle, open } from "node:fs/promises";
import type { RandomAccessReader } from "@nslib/formats";

export class FileHandleReader implements RandomAccessReader {
  readonly size: number;
  readonly mtimeMs: number;
  readonly #handle: FileHandle;

  private constructor(handle: FileHandle, size: number, mtimeMs: number) {
    this.#handle = handle;
    this.size = size;
    this.mtimeMs = mtimeMs;
  }

  static async open(path: string): Promise<FileHandleReader> {
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      return new FileHandleReader(handle, stat.size, Math.floor(stat.mtimeMs));
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  async read(offset: number, length: number): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await this.#handle.read(
        buffer,
        filled,
        length - filled,
        offset + filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  }

  close(): Promise<void> {
    return this.#handle.close();
  }
}
