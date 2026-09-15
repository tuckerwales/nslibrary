import { createCipheriv, createHash } from "node:crypto";

/** Reproducible pseudo-random bytes: the AES-CTR keystream of a key derived from `seed`. */
export function deterministicBytes(seed: string, length: number): Buffer {
  const key = createHash("sha256").update(seed).digest().subarray(0, 16);
  return createCipheriv("aes-128-ctr", key, Buffer.alloc(16)).update(Buffer.alloc(length));
}

/**
 * Alternates highly compressible text runs with random runs, so zstd block fixtures
 * contain both compressed blocks and blocks stored raw.
 */
export function mixedBytes(seed: string, length: number, runSize = 0x10000): Buffer {
  const out = Buffer.alloc(length);
  const text = Buffer.from(`nslibrary fixture ${seed} `);
  for (let position = 0, run = 0; position < length; position += runSize, run++) {
    const n = Math.min(runSize, length - position);
    if (run % 2 === 0) {
      for (let i = 0; i < n; i++) out[position + i] = text[i % text.length] ?? 0;
    } else {
      deterministicBytes(`${seed}:run${run}`, n).copy(out, position);
    }
  }
  return out;
}
