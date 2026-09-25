/**
 * Compresses NSP files to NSZ in the background, one file at a time (each spreads its blocks over
 * a few worker threads). The NSZ is written under a hidden name in the output folder, checked,
 * then renamed, so a half-written file never shows up in the library. Progress and results are
 * published as `compress.updated` events.
 */
import { access, constants, opendir, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { Keyset } from "@nslib/formats";
import {
  type CompressCandidate,
  type CompressPhase,
  type CompressResult,
  type CompressSettings,
  type CompressSettingsPatch,
  type CompressTask,
  type ContentMetaType,
  DEFAULT_COMPRESS_LEVEL,
} from "@nslib/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import PQueue from "p-queue";
import type { LogFn } from "../api/context";
import { ApiError } from "../api/errors";
import {
  contentMetas,
  contentRecords,
  type FileRow,
  files,
  installJobs,
  libraryRoots,
  type RootRow,
} from "../db/schema";
import type { EventBus } from "../events";
import { CompressError, compressNsp } from "./compress";
import { type LocatedLibraryFile, locateOnDisk, openLocatedFile } from "./library-fs";
import { fileInfoColumns } from "./queries";
import type { LibraryRepository } from "./repository";
import { ZstdWorkerPool } from "./zstd-pool";

export const COMPRESS_OUTPUT_DIR_KEY = "compress_output_dir";
export const COMPRESS_LEVEL_KEY = "compress_level";
export const COMPRESS_REMOVE_ORIGINAL_KEY = "compress_remove_original";

/** Suffix of the hidden file an NSZ is written to before it is checked and renamed. */
const PARTIAL_SUFFIX = ".nslib-partial";
const PROGRESS_EVENT_INTERVAL_MS = 500;
const MAX_FINISHED_TASKS = 200;
const TYPE_ORDER: Record<ContentMetaType, number> = { application: 0, patch: 1, addon: 2 };

interface Entry {
  task: CompressTask;
  abort: AbortController;
}

export interface CompressServiceOptions {
  repo: LibraryRepository;
  events: EventBus;
  keys: () => Keyset | null;
  /** Called with the library folders whose contents a compression changed. */
  rescan: (rootId: number) => void;
  /** Worker threads per compression. */
  threads: number;
  now?: () => number;
  log?: LogFn;
}

function isActive(task: CompressTask): boolean {
  return task.state === "queued" || task.state === "running";
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** `Game [0100…][v0].nsp` → `Game [0100…][v0].nsz`; a split folder `Game.nsp` names it too. */
export function nszNameFor(relPath: string): string {
  const name = basename(relPath);
  return /\.nsp$/i.test(name) ? `${name.slice(0, -4)}.nsz` : `${name}.nsz`;
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (errorCode(err) === "ENOENT") return false;
    throw err;
  }
}

export class CompressService {
  readonly #repo: LibraryRepository;
  readonly #events: EventBus;
  readonly #keys: () => Keyset | null;
  readonly #rescan: (rootId: number) => void;
  readonly #threads: number;
  readonly #now: () => number;
  readonly #log: LogFn;
  readonly #queue = new PQueue({ concurrency: 1 });
  /** Latest task per file, in insertion order (oldest first). */
  readonly #tasks = new Map<number, Entry>();
  readonly #pools = new Set<ZstdWorkerPool>();

  constructor(options: CompressServiceOptions) {
    this.#repo = options.repo;
    this.#events = options.events;
    this.#keys = options.keys;
    this.#rescan = options.rescan;
    this.#threads = Math.max(1, options.threads);
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
  }

  // Settings

  #outputDir(): string | null {
    return this.#repo.getSetting(COMPRESS_OUTPUT_DIR_KEY);
  }

  #level(): number {
    const level = Number(this.#repo.getSetting(COMPRESS_LEVEL_KEY));
    return Number.isInteger(level) && level > 0 ? level : DEFAULT_COMPRESS_LEVEL;
  }

  #removeOriginal(): boolean {
    return this.#repo.getSetting(COMPRESS_REMOVE_ORIGINAL_KEY) === "1";
  }

  async settings(): Promise<CompressSettings> {
    const outputDir = this.#outputDir();
    return {
      outputDir,
      level: this.#level(),
      removeOriginal: this.#removeOriginal(),
      outputInLibrary: outputDir !== null && this.#rootContaining(outputDir) !== null,
      problem: await this.#problem(outputDir),
    };
  }

  async updateSettings(patch: CompressSettingsPatch): Promise<CompressSettings> {
    if (patch.outputDir !== undefined) {
      const outputDir = patch.outputDir ? await this.#checkOutputDir(patch.outputDir) : null;
      this.#repo.putSetting(COMPRESS_OUTPUT_DIR_KEY, outputDir);
    }
    if (patch.level !== undefined) this.#repo.putSetting(COMPRESS_LEVEL_KEY, String(patch.level));
    if (patch.removeOriginal !== undefined) {
      this.#repo.putSetting(COMPRESS_REMOVE_ORIGINAL_KEY, patch.removeOriginal ? "1" : "0");
    }
    return this.settings();
  }

  /** Resolves and checks a folder the server can write NSZ files to. */
  async #checkOutputDir(input: string): Promise<string> {
    if (!isAbsolute(input)) {
      throw new ApiError("BAD_REQUEST", "Enter the full folder path, like /library/compressed");
    }
    let resolved: string;
    try {
      resolved = await realpath(input);
      if (!(await stat(resolved)).isDirectory()) {
        throw new ApiError("BAD_REQUEST", `${input} is a file. Enter a folder.`);
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError("BAD_REQUEST", `Folder not found: ${input}`);
    }
    try {
      await access(resolved, constants.W_OK);
    } catch {
      throw new ApiError(
        "BAD_REQUEST",
        `The server can't write to ${input}. In Docker, mount it without :ro.`,
      );
    }
    return resolved;
  }

  async #problem(outputDir: string | null): Promise<string | null> {
    if (!this.#keys()?.has("header_key")) {
      return "Compressing needs your prod.keys. Add them in Settings.";
    }
    if (!outputDir) return "Choose an output folder first.";
    try {
      await this.#checkOutputDir(outputDir);
      return null;
    } catch (err) {
      return err instanceof ApiError ? err.message : String(err);
    }
  }

  #rootContaining(path: string): RootRow | null {
    return this.#repo.listRoots().find((root) => root.enabled && contains(root.path, path)) ?? null;
  }

  // Tasks

  /** Active tasks and recently finished ones, newest first. */
  list(): CompressTask[] {
    return [...this.#tasks.values()].map((entry) => entry.task).reverse();
  }

  get(fileId: number): CompressTask | null {
    return this.#tasks.get(fileId)?.task ?? null;
  }

  /** Queues a compression. A file that is already queued or running keeps its current task. */
  async start(fileId: number): Promise<CompressTask> {
    const existing = this.#tasks.get(fileId);
    if (existing && isActive(existing.task)) return existing.task;

    const file = this.#checkFile(fileId);
    const problem = await this.#problem(this.#outputDir());
    if (problem) throw new ApiError("CONFLICT", problem);
    // Another request may have queued it while the folder was being checked.
    const queued = this.#tasks.get(fileId);
    if (queued && isActive(queued.task)) return queued.task;

    const now = this.#now();
    const entry: Entry = {
      task: {
        fileId,
        relPath: file.relPath,
        state: "queued",
        phase: null,
        bytesDone: 0,
        bytesTotal: 0,
        result: null,
        error: null,
        startedAt: now,
        updatedAt: now,
      },
      abort: new AbortController(),
    };
    this.#tasks.delete(fileId);
    this.#tasks.set(fileId, entry);
    this.#trimFinished();
    this.#publish(entry);
    void this.#queue.add(() => this.#run(entry));
    return entry.task;
  }

  cancel(fileId: number): CompressTask {
    const entry = this.#tasks.get(fileId);
    if (!entry) throw new ApiError("NOT_FOUND", "That file isn't being compressed");
    if (!isActive(entry.task)) return entry.task;
    entry.abort.abort();
    // A queued task never starts; a running one stops at its next block and removes its file.
    this.#finish(entry, { state: "cancelled", phase: null });
    return entry.task;
  }

  /** Stops running work. Partial files are removed as each task unwinds. */
  async close(): Promise<void> {
    for (const entry of this.#tasks.values()) entry.abort.abort();
    this.#queue.clear();
    await Promise.all([...this.#pools].map((pool) => pool.close()));
  }

  /** Removes partial files a crash or restart left in the output folder. */
  async removeLeftovers(): Promise<number> {
    const outputDir = this.#outputDir();
    if (!outputDir) return 0;
    let removed = 0;
    try {
      const dir = await opendir(outputDir);
      for await (const item of dir) {
        if (!item.isFile() || !item.name.startsWith(".") || !item.name.endsWith(PARTIAL_SUFFIX)) {
          continue;
        }
        await rm(join(outputDir, item.name), { force: true });
        removed++;
      }
    } catch (err) {
      this.#log(`Couldn't clear partial files from ${outputDir}`, err);
    }
    return removed;
  }

  /** NSP files whose titles aren't in the library as NSZ yet, and that have a content list. */
  candidates(): CompressCandidate[] {
    const rows = this.#repo.db
      .select({
        file: fileInfoColumns,
        metaId: contentMetas.id,
        titleId: contentMetas.titleId,
        version: contentMetas.version,
        type: contentMetas.type,
        name: contentMetas.displayName,
      })
      .from(contentMetas)
      .innerJoin(files, eq(files.id, contentMetas.fileId))
      .innerJoin(libraryRoots, eq(libraryRoots.id, files.rootId))
      .where(and(isNull(files.missingSince), eq(libraryRoots.enabled, true)))
      .all();
    const key = (row: { titleId: string; version: number | null }) =>
      `${row.titleId}:${row.version ?? "?"}`;
    const compressed = new Set(
      rows.filter((row) => row.file.format === "nsz").map((row) => key(row)),
    );
    const nspRows = rows.filter((row) => row.file.format === "nsp");
    const metaIds = nspRows.map((row) => row.metaId);
    const withRecords = new Set(
      metaIds.length === 0
        ? []
        : this.#repo.db
            .selectDistinct({ metaId: contentRecords.metaId })
            .from(contentRecords)
            .where(inArray(contentRecords.metaId, metaIds))
            .all()
            .map((row) => row.metaId),
    );

    const byFile = new Map<number, typeof nspRows>();
    for (const row of nspRows) {
      byFile.set(row.file.id, [...(byFile.get(row.file.id) ?? []), row]);
    }
    const candidates: CompressCandidate[] = [];
    for (const metas of byFile.values()) {
      if (!metas.every((meta) => withRecords.has(meta.metaId))) continue;
      if (metas.every((meta) => compressed.has(key(meta)))) continue;
      const head = [...metas].sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type])[0];
      if (!head) continue;
      candidates.push({ file: head.file, name: head.name, type: head.type, version: head.version });
    }
    return candidates.sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) ||
        TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
        (a.version ?? -1) - (b.version ?? -1) ||
        a.file.id - b.file.id,
    );
  }

  #checkFile(fileId: number): FileRow {
    const file = this.#repo.getFile(fileId);
    if (!file || !this.#repo.getRoot(file.rootId)) {
      throw new ApiError("NOT_FOUND", "That file is no longer in the library");
    }
    if (file.missingSince !== null) {
      throw new ApiError("FILE_MISSING", "This file is no longer on disk");
    }
    if (file.format !== "nsp") {
      throw new ApiError("BAD_REQUEST", "Only NSP files can be compressed to NSZ");
    }
    return file;
  }

  /** SHA-256 of every NCA the file's CNMTs list, by NCA ID. */
  #expectedHashes(fileId: number): Map<string, string> {
    const records = this.#repo.db
      .select({ ncaId: contentRecords.ncaId, sha256: contentRecords.sha256 })
      .from(contentRecords)
      .innerJoin(contentMetas, eq(contentMetas.id, contentRecords.metaId))
      .where(eq(contentMetas.fileId, fileId))
      .all();
    return new Map(records.map((record) => [record.ncaId, record.sha256]));
  }

  async #run(entry: Entry): Promise<void> {
    if (entry.abort.signal.aborted) return;
    this.#update(entry, { state: "running", phase: "compressing" });
    let lastEvent = 0;
    const onProgress = (phase: CompressPhase, done: number, total: number) => {
      const phaseChanged = entry.task.phase !== phase;
      entry.task = {
        ...entry.task,
        phase,
        bytesDone: done,
        bytesTotal: total,
        updatedAt: this.#now(),
      };
      const now = Date.now();
      if (phaseChanged || now - lastEvent >= PROGRESS_EVENT_INTERVAL_MS) {
        lastEvent = now;
        this.#publish(entry);
      }
    };
    try {
      const result = await this.#compress(entry, onProgress);
      if (entry.abort.signal.aborted) return;
      this.#finish(entry, { state: "done", phase: null, result });
    } catch (err) {
      if (entry.abort.signal.aborted) return;
      if (!(err instanceof ApiError || err instanceof CompressError)) {
        this.#log(`Compressing ${entry.task.relPath} failed`, err);
      }
      const error =
        err instanceof ApiError || err instanceof CompressError
          ? err.message
          : `Couldn't compress the file: ${err instanceof Error ? err.message : String(err)}`;
      this.#finish(entry, { state: "failed", phase: null, error });
    }
  }

  async #compress(
    entry: Entry,
    onProgress: (phase: CompressPhase, done: number, total: number) => void,
  ): Promise<CompressResult> {
    const { signal } = entry.abort;
    // Looked up again here: the file may have moved or vanished while the task was queued.
    const file = this.#checkFile(entry.task.fileId);
    const root = this.#repo.getRoot(file.rootId);
    if (!root) throw new ApiError("NOT_FOUND", "That file is no longer in the library");
    const keys = this.#keys();
    const outputDir = this.#outputDir();
    const problem = await this.#problem(outputDir);
    if (problem || !keys || !outputDir) throw new ApiError("CONFLICT", problem ?? "Not ready");
    const expected = this.#expectedHashes(file.id);
    if (expected.size === 0) {
      throw new ApiError(
        "CONFLICT",
        "This file has no content list yet, so the result couldn't be checked. Add prod.keys in Settings so NSLibrary can read it.",
      );
    }

    const outputName = nszNameFor(file.relPath);
    const outputPath = join(outputDir, outputName);
    if (await exists(outputPath)) {
      throw new ApiError("CONFLICT", `${outputName} already exists in the output folder`);
    }
    const located = await locateOnDisk(root.path, file.relPath);
    if (!located) throw new ApiError("FILE_MISSING", "This file is no longer on disk");

    const partialPath = join(outputDir, `.${outputName}${PARTIAL_SUFFIX}`);
    const pool = new ZstdWorkerPool(this.#threads, this.#level());
    this.#pools.add(pool);
    const reader = await openLocatedFile(located);
    let compressed: Awaited<ReturnType<typeof compressNsp>>;
    try {
      compressed = await compressNsp({
        reader,
        keys,
        expected,
        outputPath: partialPath,
        compressBlock: (block) => pool.compress(block),
        // Enough queued that no worker waits while this thread reads and decrypts.
        parallelBlocks: pool.size * 2,
        signal,
        onProgress,
      });
      signal.throwIfAborted();
      onProgress("finishing", 0, 0);
      // Another file may have taken the name while this one was compressing.
      if (await exists(outputPath)) {
        throw new ApiError("CONFLICT", `${outputName} already exists in the output folder`);
      }
      await rename(partialPath, outputPath);
    } catch (err) {
      await rm(partialPath, { force: true }).catch((rmErr) =>
        this.#log(`Couldn't remove ${partialPath}`, rmErr),
      );
      throw err;
    } finally {
      await reader.close();
      this.#pools.delete(pool);
      await pool.close();
    }

    const warnings = [...compressed.warnings];
    let originalRemoved = false;
    if (this.#removeOriginal()) {
      const kept = await this.#removeOriginalFile(file, root, located);
      if (kept) warnings.push(kept);
      else originalRemoved = true;
    }

    const outputRoot = this.#rootContaining(outputDir);
    if (outputRoot) this.#rescan(outputRoot.id);
    if (originalRemoved && outputRoot?.id !== root.id) this.#rescan(root.id);
    return {
      outputPath,
      sourceSize: located.size,
      outputSize: compressed.outputSize,
      savedBytes: located.size - compressed.outputSize,
      items: compressed.items,
      inLibrary: outputRoot !== null,
      originalRemoved,
      warnings,
    };
  }

  /** Deletes the NSP (every part of a split one). Returns why it was kept, if it was. */
  async #removeOriginalFile(
    file: FileRow,
    root: RootRow,
    compressedFrom: LocatedLibraryFile,
  ): Promise<string | null> {
    const busy = this.#repo.db
      .select({ id: installJobs.id })
      .from(installJobs)
      .where(
        and(
          eq(installJobs.fileId, file.id),
          inArray(installJobs.status, ["queued", "claimed", "running"]),
        ),
      )
      .get();
    if (busy) {
      return "The original was kept because an install from it is queued or running. Delete it once that finishes.";
    }
    const now = await locateOnDisk(root.path, file.relPath);
    if (
      !now ||
      now.size !== compressedFrom.size ||
      now.mtimeMs !== compressedFrom.mtimeMs ||
      now.parts.length !== compressedFrom.parts.length
    ) {
      return "The original was kept because it changed while it was being compressed.";
    }
    try {
      for (const part of now.parts) await rm(part.path);
      // A split folder (`Game.nsp/00`, `01`, …) goes too once it's empty.
      const folder = join(root.path, ...file.relPath.split("/"));
      if (dirname(now.absolutePath) === folder) await rmdir(folder).catch(() => {});
      return null;
    } catch (err) {
      const code = errorCode(err);
      const why = code === "EROFS" || code === "EACCES" || code === "EPERM" ? "read-only" : code;
      return `The original couldn't be removed${why ? ` (${why})` : ""}. Delete it yourself if you don't need it.`;
    }
  }

  #finish(entry: Entry, patch: Partial<CompressTask>): void {
    this.#update(entry, patch);
    this.#trimFinished();
  }

  #update(entry: Entry, patch: Partial<CompressTask>): void {
    entry.task = { ...entry.task, ...patch, updatedAt: this.#now() };
    this.#publish(entry);
  }

  #publish(entry: Entry): void {
    this.#events.publish({ type: "compress.updated", task: entry.task });
  }

  #trimFinished(): void {
    let finished = [...this.#tasks.values()].filter((entry) => !isActive(entry.task)).length;
    for (const [fileId, entry] of this.#tasks) {
      if (finished <= MAX_FINISHED_TASKS) break;
      if (isActive(entry.task)) continue;
      this.#tasks.delete(fileId);
      finished--;
    }
  }
}
