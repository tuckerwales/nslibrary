import { type FileHandle, open } from "node:fs/promises";
import { ConcatReader, type RandomAccessReader } from "@nslib/formats";

export interface ClosableReader extends RandomAccessReader {
  readonly mtimeMs: number;
  close(): Promise<void>;
}

export class FileHandleReader implements ClosableReader {
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

export class ConcatFileReader implements ClosableReader {
  readonly size: number;
  readonly mtimeMs: number;
  readonly #inner: ConcatReader;
  readonly #parts: FileHandleReader[];

  private constructor(parts: FileHandleReader[]) {
    this.#parts = parts;
    this.#inner = new ConcatReader(parts.map((part) => ({ reader: part, size: part.size })));
    this.size = this.#inner.size;
    this.mtimeMs = parts.reduce((max, part) => Math.max(max, part.mtimeMs), 0);
  }

  static async open(paths: string[]): Promise<ConcatFileReader> {
    const parts: FileHandleReader[] = [];
    try {
      for (const path of paths) parts.push(await FileHandleReader.open(path));
      return new ConcatFileReader(parts);
    } catch (err) {
      await Promise.all(parts.map((part) => part.close()));
      throw err;
    }
  }

  read(offset: number, length: number): Promise<Buffer> {
    return this.#inner.read(offset, length);
  }

  async close(): Promise<void> {
    await Promise.all(this.#parts.map((part) => part.close()));
  }
}
