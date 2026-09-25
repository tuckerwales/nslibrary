/**
 * Integrity check against CNMT content records. Quick mode confirms each NCA is present;
 * full mode hashes the NCA (decompressed as it streams if it is an NCZ), so memory use stays small
 * however large the content is.
 */
import { createHash } from "node:crypto";
import { type RandomAccessReader, readExact, restoreNczChunks, SliceReader } from "@nslib/formats";
import type { VerifyItem, VerifyMode, VerifyResult, VerifyStatus } from "@nslib/shared";
import { eq } from "drizzle-orm";
import { containerEntries, contentMetas, contentRecords, type FileRow } from "../db/schema";
import type { LibraryRepository } from "./repository";

const CHUNK = 1024 * 1024;

function ncaIdFromName(name: string): string | null {
  const match = /^([0-9a-f]{32})\./i.exec(name);
  return match?.[1]?.toLowerCase() ?? null;
}

export interface VerifyOptions {
  /** Aborting stops hashing between chunks and rejects with the signal's reason. */
  signal?: AbortSignal;
  /** NCA bytes hashed so far, out of the sum of the file's content record sizes. */
  onProgress?: (done: number, total: number) => void;
}

/** SHA-256 of an NCA, restored first when `compressed` (an NCZ). */
export async function sha256Of(
  reader: RandomAccessReader,
  compressed: boolean,
  onChunk: (bytes: number) => void,
  signal: AbortSignal | undefined,
): Promise<string> {
  const hash = createHash("sha256");
  const add = (chunk: Buffer) => {
    signal?.throwIfAborted();
    hash.update(chunk);
    onChunk(chunk.byteLength);
  };
  if (compressed) {
    for await (const chunk of restoreNczChunks(reader)) add(chunk);
    return hash.digest("hex");
  }
  for (let offset = 0; offset < reader.size; offset += CHUNK) {
    signal?.throwIfAborted();
    add(await readExact(reader, offset, Math.min(CHUNK, reader.size - offset)));
  }
  return hash.digest("hex");
}

export async function verifyLibraryFile(
  repo: LibraryRepository,
  file: FileRow,
  reader: RandomAccessReader,
  mode: VerifyMode,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const fileId = file.id;
  const records = repo.db
    .select({
      ncaId: contentRecords.ncaId,
      sha256: contentRecords.sha256,
      size: contentRecords.size,
    })
    .from(contentRecords)
    .innerJoin(contentMetas, eq(contentMetas.id, contentRecords.metaId))
    .where(eq(contentMetas.fileId, fileId))
    .all();

  if (records.length === 0) {
    repo.setFileVerify(fileId, "unverified");
    return {
      status: "unverified",
      mode,
      items: [
        {
          ncaId: "",
          ok: false,
          message:
            "This file has no content list yet. Add prod.keys in Settings so NSLibrary can read the metadata.",
        },
      ],
    };
  }

  const container = repo.db
    .select()
    .from(containerEntries)
    .where(eq(containerEntries.fileId, fileId))
    .all();
  const byNcaId = new Map<string, (typeof container)[number]>();
  for (const entry of container) {
    const id = ncaIdFromName(entry.name);
    if (id) byNcaId.set(id, entry);
  }

  const total = records.reduce((sum, record) => sum + record.size, 0);
  let done = 0;
  options.onProgress?.(done, total);
  const items: VerifyItem[] = [];
  for (const record of records) {
    const entry = byNcaId.get(record.ncaId);
    if (!entry) {
      items.push({
        ncaId: record.ncaId,
        ok: false,
        message: `Missing ${record.ncaId}.nca in the container`,
      });
      continue;
    }
    if (mode === "quick") {
      items.push({ ncaId: record.ncaId, ok: true, message: "Present" });
      continue;
    }
    const slice = new SliceReader(reader, entry.offset, entry.size);
    const actual = await sha256Of(
      slice,
      entry.name.toLowerCase().endsWith(".ncz"),
      (bytes) => {
        done += bytes;
        options.onProgress?.(done, total);
      },
      options.signal,
    );
    const ok = actual === record.sha256;
    items.push({
      ncaId: record.ncaId,
      ok,
      message: ok ? "Hash matches" : "SHA-256 does not match the content metadata",
    });
  }

  const okCount = items.filter((item) => item.ok).length;
  const status: VerifyStatus = okCount === items.length ? "ok" : okCount === 0 ? "bad" : "partial";
  repo.setFileVerify(fileId, status);
  return { status, mode, items };
}
