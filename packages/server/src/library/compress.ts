/**
 * NSP → NSZ. Program and PublicData NCAs become NCZ, as nsz does; everything else (meta, control,
 * tickets) is copied as it is. Each original NCA is checked against the CNMT while it is read,
 * then the new file is read back and every entry compared with the original, so a file that
 * comes out of here restores to exactly the NSP it was made from.
 */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import {
  type BlockCompressor,
  buildPfs0Header,
  decryptNcaHeader,
  encodeNcz,
  FormatError,
  type Keyset,
  MissingKeyError,
  NCA_HEADER_SIZE,
  NCZ_UNCOMPRESSED_PREFIX_SIZE,
  NcaContentType,
  type NczSection,
  type PartitionEntry,
  parsePfs0,
  planNczSections,
  type RandomAccessReader,
  readExact,
  SliceReader,
} from "@nslib/formats";
import type { CompressItem } from "@nslib/shared";
import { FileHandleReader } from "./file-reader";
import { readTickets, titleKeyFor } from "./inspect";
import { sha256Of } from "./verify";

const COPY_CHUNK = 1024 * 1024;
const COMPRESSIBLE_CONTENT = new Set<number>([NcaContentType.Program, NcaContentType.PublicData]);

/** A failure with a message meant for the person who started the compression. */
export class CompressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompressError";
  }
}

export type CompressProgress = (
  phase: "compressing" | "checking",
  done: number,
  total: number,
) => void;

export interface CompressNspOptions {
  /** The NSP. */
  reader: RandomAccessReader;
  keys: Keyset;
  /** SHA-256 of each NCA the file's CNMTs list, by NCA ID. */
  expected: ReadonlyMap<string, string>;
  /** Where to write the NSZ. Created or truncated. */
  outputPath: string;
  compressBlock: BlockCompressor;
  /** Blocks compressing at once. */
  parallelBlocks: number;
  blockSizeExponent?: number;
  signal?: AbortSignal;
  onProgress?: CompressProgress;
}

export interface CompressNspResult {
  outputSize: number;
  items: CompressItem[];
  warnings: string[];
}

interface EntryPlan {
  entry: PartitionEntry;
  outputName: string;
  sections: NczSection[] | null;
  note: string | null;
}

function ncaIdFromName(name: string): string | null {
  const match = /^([0-9a-f]{32})\./i.exec(name);
  return match?.[1]?.toLowerCase() ?? null;
}

function hasRightsId(header: Buffer): boolean {
  return header.subarray(0x230, 0x240).some((b) => b !== 0);
}

async function planEntry(
  reader: RandomAccessReader,
  entry: PartitionEntry,
  keys: Keyset,
  tickets: Awaited<ReturnType<typeof readTickets>>,
): Promise<EntryPlan> {
  const copy = (note: string | null): EntryPlan => ({
    entry,
    outputName: entry.name,
    sections: null,
    note,
  });
  if (entry.kind !== "nca" || entry.size <= NCZ_UNCOMPRESSED_PREFIX_SIZE) return copy(null);

  const slice = new SliceReader(reader, entry.offset, entry.size);
  try {
    const header = decryptNcaHeader(await readExact(slice, 0, NCA_HEADER_SIZE), keys);
    if (!COMPRESSIBLE_CONTENT.has(header.readUInt8(0x205))) return copy(null);
    let titleKey: Buffer | undefined;
    if (hasRightsId(header)) {
      const problems: string[] = [];
      titleKey = titleKeyFor(keys, header, tickets, problems, entry.name);
      if (!titleKey) return copy(problems[0] ?? `${entry.name} needs a title key`);
    }
    const plan = await planNczSections(slice, keys, titleKey);
    return {
      entry,
      outputName: `${entry.name.slice(0, -".nca".length)}.ncz`,
      sections: plan.sections,
      note:
        plan.bktrFallbacks > 0
          ? "Its update table couldn't be read, so part of it is stored without much compression"
          : null,
    };
  } catch (err) {
    if (err instanceof MissingKeyError || err instanceof FormatError) {
      return copy(`Copied as it is: ${err.message}`);
    }
    throw err;
  }
}

async function planEntries(
  reader: RandomAccessReader,
  keys: Keyset,
): Promise<{ plans: EntryPlan[]; warnings: string[] }> {
  let entries: PartitionEntry[];
  try {
    entries = (await parsePfs0(reader)).entries;
  } catch (err) {
    if (err instanceof FormatError) {
      throw new CompressError(`This NSP can't be read (${err.message})`);
    }
    throw err;
  }
  const warnings: string[] = [];
  const tickets = await readTickets(reader, entries, warnings);
  const plans: EntryPlan[] = [];
  for (const entry of entries) plans.push(await planEntry(reader, entry, keys, tickets));
  return { plans, warnings };
}

/** Writes `options.reader` as an NSZ at `options.outputPath`, then checks what it wrote. */
export async function compressNsp(options: CompressNspOptions): Promise<CompressNspResult> {
  const { reader, keys, expected, signal } = options;
  if (!keys.has("header_key")) {
    throw new CompressError("Compressing needs your prod.keys. Add them in Settings.");
  }
  const { plans, warnings } = await planEntries(reader, keys);
  if (!plans.some((plan) => plan.sections)) {
    const reason = plans.find((plan) => plan.note)?.note;
    throw new CompressError(
      reason
        ? `Nothing in this file can be compressed. ${reason}`
        : "Nothing in this file can be compressed: it has no program or data NCAs.",
    );
  }

  const total = plans.reduce((sum, plan) => sum + plan.entry.size, 0);
  let done = 0;
  options.onProgress?.("compressing", done, total);
  const hashes: string[] = [];
  const items: CompressItem[] = [];

  let outputSize = 0;
  const handle = await open(options.outputPath, "w");
  try {
    let position = 0;
    const writeAt = async (at: number, chunk: Buffer) => {
      let written = 0;
      while (written < chunk.length) {
        const { bytesWritten } = await handle.write(
          chunk,
          written,
          chunk.length - written,
          at + written,
        );
        written += bytesWritten;
      }
    };
    const append = async (chunk: Buffer) => {
      await writeAt(position, chunk);
      position += chunk.length;
    };

    // Rewritten with the real sizes at the end; its length depends only on the names.
    await append(buildPfs0Header(plans.map((plan) => ({ name: plan.outputName, size: 0 }))));

    for (const plan of plans) {
      signal?.throwIfAborted();
      const { entry } = plan;
      const slice = new SliceReader(reader, entry.offset, entry.size);
      const start = position;
      const hash = createHash("sha256");
      const onSource = (chunk: Buffer) => {
        hash.update(chunk);
        done += chunk.length;
        options.onProgress?.("compressing", done, total);
      };

      if (plan.sections) {
        const encoded = await encodeNcz(slice, plan.sections, append, {
          compressBlock: options.compressBlock,
          parallelBlocks: options.parallelBlocks,
          blockSizeExponent: options.blockSizeExponent,
          signal,
          onSource,
        });
        await writeAt(start + encoded.blockTable.offset, encoded.blockTable.data);
      } else {
        for (let offset = 0; offset < entry.size; offset += COPY_CHUNK) {
          signal?.throwIfAborted();
          const chunk = await readExact(slice, offset, Math.min(COPY_CHUNK, entry.size - offset));
          onSource(chunk);
          await append(chunk);
        }
      }

      const sha256 = hash.digest("hex");
      // An NCZ already in the NSP is copied as it is; its CNMT hash is of the restored NCA.
      const ncaId = entry.kind === "ncz" ? null : ncaIdFromName(entry.name);
      const want = ncaId ? expected.get(ncaId) : undefined;
      if (want !== undefined && want !== sha256) {
        throw new CompressError(
          `The original is damaged: ${entry.name} doesn't match its content metadata, so it wasn't compressed. Verify the file for details.`,
        );
      }
      hashes.push(sha256);
      items.push({
        name: entry.name,
        outputName: plan.outputName,
        compressed: plan.sections !== null,
        sourceSize: entry.size,
        outputSize: position - start,
        note: plan.note,
      });
    }

    const header = buildPfs0Header(
      items.map((item) => ({ name: item.outputName, size: item.outputSize })),
    );
    await writeAt(0, header);
    await handle.sync();
    outputSize = position;
  } finally {
    await handle.close();
  }

  await checkOutput(options.outputPath, items, hashes, options);
  return { outputSize, items, warnings };
}

/** Reads the new file back and compares every entry with the original's hash. */
async function checkOutput(
  path: string,
  items: CompressItem[],
  hashes: string[],
  options: CompressNspOptions,
): Promise<void> {
  const total = items.reduce((sum, item) => sum + item.sourceSize, 0);
  let done = 0;
  options.onProgress?.("checking", done, total);
  const reader = await FileHandleReader.open(path);
  try {
    let entries: PartitionEntry[];
    try {
      entries = (await parsePfs0(reader)).entries;
    } catch (err) {
      if (err instanceof FormatError) {
        throw new CompressError(`The new NSZ didn't read back correctly (${err.message})`);
      }
      throw err;
    }
    const names = entries.map((entry) => entry.name);
    if (names.join("\n") !== items.map((item) => item.outputName).join("\n")) {
      throw new CompressError("The new NSZ didn't read back with the entries that were written");
    }
    for (const [index, entry] of entries.entries()) {
      const actual = await sha256Of(
        new SliceReader(reader, entry.offset, entry.size),
        items[index]?.compressed ?? false,
        (bytes) => {
          done += bytes;
          options.onProgress?.("checking", done, total);
        },
        options.signal,
      );
      if (actual !== hashes[index]) {
        throw new CompressError(
          `The compressed copy of ${items[index]?.name ?? entry.name} doesn't match the original, so it wasn't kept`,
        );
      }
    }
  } finally {
    await reader.close();
  }
}
