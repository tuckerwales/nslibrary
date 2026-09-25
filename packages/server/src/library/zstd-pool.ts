/**
 * zstd compression on worker threads. `zlib.zstdCompress` would run on libuv's thread pool, which
 * has four threads by default and also serves every file read, so a few busy compressions could
 * stall installs streaming from the same server.
 */
import { Worker } from "node:worker_threads";

// An eval'd CommonJS worker, so it runs the same from source (tsx) and from the esbuild bundle.
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { constants, zstdCompressSync } = require("node:zlib");
parentPort.on("message", ({ id, data, level }) => {
  try {
    const out = zstdCompressSync(data, { params: { [constants.ZSTD_c_compressionLevel]: level } });
    parentPort.postMessage({ id, data: out });
  } catch (err) {
    parentPort.postMessage({ id, error: String((err && err.message) || err) });
  }
});
`;

interface Job {
  id: number;
  data: Buffer;
  resolve: (compressed: Buffer) => void;
  reject: (err: Error) => void;
}

interface Reply {
  id: number;
  data?: Uint8Array;
  error?: string;
}

export class ZstdWorkerPool {
  readonly size: number;
  readonly #level: number;
  readonly #idle: Worker[] = [];
  readonly #busy = new Map<Worker, Job>();
  readonly #waiting: Job[] = [];
  #nextId = 0;
  #closed = false;

  constructor(size: number, level: number) {
    this.size = Math.max(1, size);
    this.#level = level;
  }

  compress(data: Buffer): Promise<Buffer> {
    if (this.#closed) return Promise.reject(new Error("The compressor was stopped"));
    return new Promise((resolve, reject) => {
      this.#waiting.push({ id: this.#nextId++, data, resolve, reject });
      this.#dispatch();
    });
  }

  /** Stops the workers. Pending and running compressions reject. */
  async close(): Promise<void> {
    this.#closed = true;
    const stopped = new Error("The compressor was stopped");
    for (const job of this.#waiting.splice(0)) job.reject(stopped);
    for (const job of this.#busy.values()) job.reject(stopped);
    const workers = [...this.#idle.splice(0), ...this.#busy.keys()];
    this.#busy.clear();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }

  #dispatch(): void {
    while (this.#waiting.length > 0) {
      const worker = this.#idle.pop() ?? this.#spawn();
      if (!worker) return;
      const job = this.#waiting.shift();
      if (!job) {
        this.#idle.push(worker);
        return;
      }
      this.#busy.set(worker, job);
      worker.postMessage({ id: job.id, data: job.data, level: this.#level });
    }
  }

  #spawn(): Worker | null {
    if (this.#idle.length + this.#busy.size >= this.size) return null;
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    worker.unref();
    worker.on("message", (reply: Reply) => {
      const job = this.#busy.get(worker);
      this.#busy.delete(worker);
      if (!this.#closed) this.#idle.push(worker);
      if (job && job.id === reply.id) {
        if (reply.data) {
          job.resolve(Buffer.from(reply.data.buffer, reply.data.byteOffset, reply.data.byteLength));
        } else {
          job.reject(new Error(`zstd failed: ${reply.error ?? "unknown error"}`));
        }
      }
      this.#dispatch();
    });
    worker.on("error", (err) => this.#lose(worker, err));
    worker.on("exit", (code) => {
      if (!this.#closed) this.#lose(worker, new Error(`zstd worker exited with code ${code}`));
    });
    return worker;
  }

  /** A worker that crashed fails its job; the next job starts a replacement. */
  #lose(worker: Worker, err: Error): void {
    const job = this.#busy.get(worker);
    this.#busy.delete(worker);
    const idle = this.#idle.indexOf(worker);
    if (idle !== -1) this.#idle.splice(idle, 1);
    job?.reject(err);
    if (!this.#closed) this.#dispatch();
  }
}
