import { Readable } from "node:stream";
import type { RandomAccessReader } from "@nslib/formats";

const CHUNK = 1024 * 1024;

/** Sequential 1 MiB reads covering an inclusive byte range. */
export function rangeReadable(reader: RandomAccessReader, start: number, end: number): Readable {
  let offset = start;
  return Readable.from(
    (async function* () {
      while (offset <= end) {
        const n = Math.min(CHUNK, end - offset + 1);
        const buf = await reader.read(offset, n);
        if (buf.length === 0) return;
        offset += buf.length;
        yield buf;
      }
    })(),
  );
}
