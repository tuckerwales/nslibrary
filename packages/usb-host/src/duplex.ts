/**
 * In-memory USB-shaped byte pipes. Each side of a MemoryDuplex is a ByteChannel:
 * writes on `a` are read from `b` and vice versa.
 */

export interface ByteChannel {
  readExact(n: number, signal?: AbortSignal): Promise<Uint8Array>;
  write(data: Uint8Array): Promise<void>;
  close(): void;
  readonly closed: boolean;
}

class QueueChannel implements ByteChannel {
  #chunks: Uint8Array[] = [];
  #waiters: Array<() => void> = [];
  #closed = false;
  peer: QueueChannel | null = null;

  get closed(): boolean {
    return this.#closed;
  }

  async readExact(n: number, signal?: AbortSignal): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let filled = 0;
    const abort = () => {
      this.#wake();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      while (filled < n) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (this.#closed && this.#available() === 0) {
          throw new Error("USB channel closed");
        }
        const take = this.#pull(out.subarray(filled));
        filled += take;
        if (filled < n) {
          await new Promise<void>((resolve) => {
            this.#waiters.push(resolve);
          });
        }
      }
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    return out;
  }

  async write(data: Uint8Array): Promise<void> {
    const peer = this.peer;
    if (!peer || peer.#closed) throw new Error("USB channel closed");
    if (data.byteLength === 0) return;
    peer.#chunks.push(data.slice());
    peer.#wake();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
    const peer = this.peer;
    if (peer && !peer.#closed) {
      peer.#closed = true;
      peer.#wake();
    }
  }

  #available(): number {
    return this.#chunks.reduce((n, c) => n + c.byteLength, 0);
  }

  #pull(dst: Uint8Array): number {
    let filled = 0;
    while (filled < dst.byteLength && this.#chunks.length > 0) {
      const chunk = this.#chunks[0];
      if (!chunk) break;
      const take = Math.min(dst.byteLength - filled, chunk.byteLength);
      dst.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take === chunk.byteLength) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(take);
    }
    return filled;
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  }
}

export class MemoryDuplex {
  readonly a: ByteChannel;
  readonly b: ByteChannel;

  constructor() {
    const a = new QueueChannel();
    const b = new QueueChannel();
    a.peer = b;
    b.peer = a;
    this.a = a;
    this.b = b;
  }

  close(): void {
    this.a.close();
  }
}
