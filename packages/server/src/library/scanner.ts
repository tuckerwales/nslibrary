import { createHash } from "node:crypto";
import { opendir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import {
  detectSplitDirectory,
  FormatError,
  formatFromFileName,
  groupNumberedSplitFiles,
  isLibraryOrSplitName,
  type Keyset,
  type LibraryFileFormat,
  parseNumberedSplitName,
} from "@nslib/formats";
import type { ScanProgress } from "@nslib/shared";
import { type FSWatcher, watch } from "chokidar";
import PQueue from "p-queue";
import type { RootRow } from "../db/schema";
import type { EventBus } from "../events";
import { inspectLibraryFile } from "./inspect";
import {
  fileStatFromLocated,
  libraryIdentityRelPath,
  locateOnDisk,
  openLocatedFile,
} from "./library-fs";
import type { FileStat, LibraryRepository } from "./repository";

export interface ScannerOptions {
  iconDir: string;
  parseConcurrency?: number;
  /** Poll every root regardless of its setting (useful in tests and for network mounts). */
  forcePolling?: boolean;
  pollIntervalMs?: number;
  /** How long a file's size must stay unchanged before a watcher event is handled. */
  stabilityThresholdMs?: number;
  /** Watcher events are batched for this long so renames arrive as unlink + add together. */
  watchBatchMs?: number;
  keys?: () => Keyset | null;
  log?: (message: string, err?: unknown) => void;
}

export interface ScanSummary {
  rootId: number;
  seen: number;
  parsed: number;
  added: number;
  moved: number;
  missing: number;
  error: string | null;
}

type WatchEventType = "add" | "change" | "unlink" | "unlinkDir";

const IDLE: ScanProgress = { state: "idle", done: 0, total: 0 };
const PROGRESS_PUBLISH_INTERVAL_MS = 200;
const LIBRARY_CHANGED_DEBOUNCE_MS = 250;

export function isLibraryFileName(name: string): boolean {
  return !name.startsWith(".") && formatFromFileName(name) !== null;
}

function describeFsError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case "ENOENT":
      return "Folder not found. Check that the drive or network share is connected.";
    case "EACCES":
    case "EPERM":
      return "Permission denied. Give the server read access to this folder.";
    case "ENOTDIR":
      return "This path is a file, not a folder.";
    default:
      return `Couldn't read folder: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const FORMAT_NAMES: Record<LibraryFileFormat, string> = {
  nsp: "NSP",
  nsz: "NSZ",
  xci: "XCI",
  xcz: "XCZ",
  nro: "NRO",
};

function describeParseError(err: unknown, format: LibraryFileFormat): string {
  const kind = `${FORMAT_NAMES[format]} file`;
  if (err instanceof FormatError) {
    switch (err.code) {
      case "TRUNCATED":
        return `This ${kind} is incomplete. It may still be copying, or the download was cut short.`;
      case "BAD_MAGIC":
        return `This isn't a valid ${kind}. It may be damaged, or a different kind of file with the wrong extension.`;
      case "UNSUPPORTED":
        return `This ${kind} uses a variant NSLibrary can't read yet (${err.message}).`;
      default:
        return `This ${kind} is damaged (${err.message}).`;
    }
  }
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code) return `Couldn't read file (${code})`;
  return `Couldn't read file: ${err instanceof Error ? err.message : String(err)}`;
}

export class LibraryScanner {
  readonly #repo: LibraryRepository;
  readonly #events: EventBus;
  readonly #options: Required<Omit<ScannerOptions, "log">> & Pick<ScannerOptions, "log">;
  readonly #queue: PQueue;
  readonly #scans = new Map<number, Promise<ScanSummary>>();
  readonly #progress = new Map<number, ScanProgress>();
  readonly #lastProgressPublish = new Map<number, number>();
  readonly #parsing = new Map<number, Promise<void>>();
  readonly #watchers = new Map<number, FSWatcher>();
  readonly #watchBatches = new Map<
    number,
    { timer: NodeJS.Timeout; events: Map<string, WatchEventType> }
  >();
  readonly #watchFlushes = new Set<Promise<void>>();
  #libraryChangedTimer: NodeJS.Timeout | null = null;
  #closed = false;
  #paused = false;

  constructor(repo: LibraryRepository, events: EventBus, options: ScannerOptions) {
    this.#repo = repo;
    this.#events = events;
    this.#options = {
      parseConcurrency: 4,
      forcePolling: false,
      pollIntervalMs: 2000,
      stabilityThresholdMs: 5000,
      watchBatchMs: 300,
      keys: () => null,
      ...options,
    };
    this.#queue = new PQueue({ concurrency: this.#options.parseConcurrency });
  }

  progress(rootId: number): ScanProgress {
    return this.#progress.get(rootId) ?? IDLE;
  }

  get paused(): boolean {
    return this.#paused;
  }

  async setPaused(paused: boolean): Promise<void> {
    this.#paused = paused;
    if (paused) {
      await Promise.all([...this.#watchers.keys()].map((id) => this.unwatchRoot(id)));
      return;
    }
    for (const root of this.#repo.listRoots()) await this.watchRoot(root);
  }

  /** Scans a root; concurrent calls for the same root share one scan. */
  scanRoot(rootId: number): Promise<ScanSummary> {
    const running = this.#scans.get(rootId);
    if (running) return running;
    const scan = this.#runScan(rootId).finally(() => this.#scans.delete(rootId));
    this.#scans.set(rootId, scan);
    return scan;
  }

  async scanAll(): Promise<ScanSummary[]> {
    const roots = this.#repo.listRoots().filter((root) => root.enabled);
    return Promise.all(roots.map((root) => this.scanRoot(root.id)));
  }

  /** Re-inspect every present file (after keys or titledb change). */
  reparseAll(): Promise<ScanSummary[]> {
    this.#repo.invalidatePresentFiles();
    return this.scanAll();
  }

  /** Resolves once queued parsing and batched watcher events are handled. */
  async idle(): Promise<void> {
    while (
      this.#watchBatches.size > 0 ||
      this.#watchFlushes.size > 0 ||
      this.#queue.size > 0 ||
      this.#queue.pending > 0
    ) {
      await Promise.all([this.#queue.onIdle(), ...this.#watchFlushes]);
      if (this.#watchBatches.size > 0)
        await new Promise((resolve) => setTimeout(resolve, this.#options.watchBatchMs));
    }
  }

  async #runScan(rootId: number): Promise<ScanSummary> {
    const root = this.#repo.getRoot(rootId);
    if (!root) throw new Error(`Unknown library folder ${rootId}`);
    const summary: ScanSummary = {
      rootId,
      seen: 0,
      parsed: 0,
      added: 0,
      moved: 0,
      missing: 0,
      error: null,
    };
    this.#setProgress(rootId, { state: "walking", done: 0, total: 0 });

    try {
      const seen = new Map<string, FileStat>();
      const skippedDirs: string[] = [];
      try {
        const rootStat = await stat(root.path);
        if (!rootStat.isDirectory())
          throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
        await this.#walk(root.path, "", seen, skippedDirs);
      } catch (err) {
        // Leave existing files alone: an unmounted share shouldn't empty the library.
        summary.error = describeFsError(err);
        this.#repo.setRootScanResult(rootId, summary.error);
        return summary;
      }

      const reconciled = this.#repo.reconcileScan(rootId, seen, skippedDirs);
      Object.assign(summary, {
        seen: seen.size,
        parsed: reconciled.toParse.length,
        added: reconciled.added,
        moved: reconciled.moved,
        missing: reconciled.missing,
      });
      if (reconciled.changed) this.#notifyLibraryChanged();

      let done = 0;
      const total = reconciled.toParse.length;
      this.#setProgress(rootId, { state: "parsing", done, total });
      await Promise.all(
        reconciled.toParse.map((fileId) =>
          this.#parse(fileId).then(() => {
            done++;
            this.#setProgress(rootId, { state: "parsing", done, total });
          }),
        ),
      );
      this.#repo.setRootScanResult(rootId, null);
      return summary;
    } finally {
      this.#setProgress(rootId, IDLE);
      this.#events.publish({ type: "roots.changed" });
    }
  }

  async #walk(
    absDir: string,
    relDir: string,
    out: Map<string, FileStat>,
    skippedDirs: string[],
  ): Promise<void> {
    const dir = await opendir(absDir);
    const numberedFiles: string[] = [];
    for await (const entry of dir) {
      if (entry.name.startsWith(".")) continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const absPath = join(absDir, entry.name);
      if (entry.isDirectory()) {
        try {
          const children = await opendir(absPath);
          const childEntries: Array<{ name: string; isFile: boolean }> = [];
          for await (const child of children) {
            childEntries.push({
              name: child.name,
              isFile: child.isFile() || child.isSymbolicLink(),
            });
          }
          const split = detectSplitDirectory(entry.name, childEntries);
          if (split) {
            const located = await locateOnDisk(absDir, entry.name);
            if (located) out.set(relPath, fileStatFromLocated(located));
            continue;
          }
          await this.#walk(absPath, relPath, out, skippedDirs);
        } catch (err) {
          this.#options.log?.(`Skipping unreadable folder ${absPath}`, err);
          skippedDirs.push(relPath);
        }
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (parseNumberedSplitName(entry.name)) {
          numberedFiles.push(entry.name);
          continue;
        }
        if (!isLibraryFileName(entry.name)) continue;
        try {
          const fileStat = await stat(absPath);
          if (fileStat.isFile())
            out.set(relPath, { size: fileStat.size, mtimeMs: Math.floor(fileStat.mtimeMs) });
        } catch {
          // Broken symlink or the file vanished mid-walk.
        }
      }
    }
    for (const layout of groupNumberedSplitFiles(numberedFiles)) {
      const relPath = relDir ? `${relDir}/${layout.relName}` : layout.relName;
      if (out.has(relPath)) continue;
      const located = await locateOnDisk(absDir, layout.relName);
      if (located) out.set(relPath, fileStatFromLocated(located));
    }
  }

  #parse(fileId: number): Promise<void> {
    const existing = this.#parsing.get(fileId);
    if (existing) return existing;
    const job = this.#queue
      .add(() => this.#parseNow(fileId))
      .catch((err) => this.#options.log?.(`Failed to inspect file ${fileId}`, err))
      .finally(() => this.#parsing.delete(fileId));
    this.#parsing.set(fileId, job);
    return job;
  }

  async #parseNow(fileId: number): Promise<void> {
    if (this.#closed) return;
    const file = this.#repo.getFile(fileId);
    const root = file && this.#repo.getRoot(file.rootId);
    if (!file || !root) return;

    const fileName = basename(file.relPath);
    const located = await locateOnDisk(root.path, file.relPath);
    if (!located) {
      this.#repo.markMissing(root.id, file.relPath, false);
      this.#notifyLibraryChanged();
      return;
    }
    let reader: Awaited<ReturnType<typeof openLocatedFile>>;
    try {
      reader = await openLocatedFile(located);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.#repo.markMissing(root.id, file.relPath, false);
      } else {
        this.#repo.saveInspection(fileId, null, {
          status: "error",
          message: describeParseError(err, file.format),
        });
      }
      this.#notifyLibraryChanged();
      return;
    }

    const fileStat = { size: reader.size, mtimeMs: reader.mtimeMs, format: located.format };
    try {
      const result = await inspectLibraryFile(reader, fileName, file.format, {
        keys: this.#options.keys?.() ?? null,
      });
      const icon = result.homebrew?.icon ?? result.application?.icon;
      const iconKey = icon ? await this.#storeIcon(icon) : null;
      const identified = result.metas.length > 0 || result.homebrew !== null;
      this.#repo.saveInspection(fileId, fileStat, {
        status: identified ? "ok" : "unidentified",
        result,
        iconKey,
        message: identified
          ? null
          : "No title ID found. Add the title ID to the file name, like [0100ABCDEF012000].",
      });
    } catch (err) {
      this.#repo.saveInspection(fileId, fileStat, {
        status: "error",
        message: describeParseError(err, file.format),
      });
    } finally {
      await reader.close();
    }
    this.#notifyLibraryChanged();
  }

  async #storeIcon(icon: Buffer): Promise<string> {
    const key = createHash("sha256").update(icon).digest("hex").slice(0, 32);
    try {
      await writeFile(join(this.#options.iconDir, `${key}.jpg`), icon, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    return key;
  }

  // Watching

  async watchRoot(root: RootRow): Promise<void> {
    await this.unwatchRoot(root.id);
    if (!root.enabled || this.#closed || this.#paused) return;
    const { pollIntervalMs, stabilityThresholdMs } = this.#options;
    const watcher = watch(root.path, {
      ignoreInitial: true,
      usePolling: root.usePolling || this.#options.forcePolling,
      interval: pollIntervalMs,
      binaryInterval: pollIntervalMs,
      awaitWriteFinish: {
        stabilityThreshold: stabilityThresholdMs,
        pollInterval: Math.max(20, Math.min(100, stabilityThresholdMs / 2)),
      },
      ignored: (path, stats) => {
        if (path === root.path) return false;
        const name = basename(path);
        if (name.startsWith(".")) return true;
        if (stats?.isDirectory()) return false;
        return stats?.isFile() === true && !isLibraryOrSplitName(name);
      },
    });
    this.#watchers.set(root.id, watcher);

    for (const type of ["add", "change", "unlink", "unlinkDir"] as const) {
      watcher.on(type, (path: string) => this.#queueWatchEvent(root, path, type));
    }
    watcher.on("error", (err) => this.#options.log?.(`Watcher error in ${root.path}`, err));
    await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
  }

  async unwatchRoot(rootId: number): Promise<void> {
    const batch = this.#watchBatches.get(rootId);
    if (batch) {
      clearTimeout(batch.timer);
      this.#watchBatches.delete(rootId);
    }
    const watcher = this.#watchers.get(rootId);
    if (!watcher) return;
    this.#watchers.delete(rootId);
    await watcher.close();
  }

  #queueWatchEvent(root: RootRow, absPath: string, type: WatchEventType): void {
    const relPath = relative(root.path, absPath).split(sep).join("/");
    if (relPath === "" || relPath.startsWith("..")) return;
    let identity = relPath;
    if (type !== "unlinkDir") {
      if (!isLibraryOrSplitName(basename(relPath))) return;
      identity = libraryIdentityRelPath(relPath);
    }

    let batch = this.#watchBatches.get(root.id);
    if (!batch) {
      const timer = setTimeout(() => {
        this.#watchBatches.delete(root.id);
        const flush = this.#flushWatchEvents(root.id, root.path, events).finally(() =>
          this.#watchFlushes.delete(flush),
        );
        this.#watchFlushes.add(flush);
      }, this.#options.watchBatchMs);
      const events = new Map<string, WatchEventType>();
      batch = { timer, events };
      this.#watchBatches.set(root.id, batch);
    }
    batch.events.set(identity, type);
  }

  async #flushWatchEvents(
    rootId: number,
    rootPath: string,
    events: Map<string, WatchEventType>,
  ): Promise<void> {
    if (this.#closed) return;
    let changed = false;
    // Removals first, so a rename's new path can claim the row its old path just released.
    for (const [relPath, type] of events) {
      if (type === "unlink" || type === "unlinkDir") {
        changed = this.#repo.markMissing(rootId, relPath, type === "unlinkDir") > 0 || changed;
      }
    }
    for (const [relPath, type] of events) {
      if (type !== "add" && type !== "change") continue;
      try {
        const located = await locateOnDisk(rootPath, relPath);
        if (!located) {
          changed = this.#repo.markMissing(rootId, relPath, false) > 0 || changed;
          continue;
        }
        const seen = this.#repo.upsertSeenFile(rootId, relPath, fileStatFromLocated(located));
        changed = seen.changed || changed;
        if (seen.needsParse) void this.#parse(seen.fileId);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          changed = this.#repo.markMissing(rootId, relPath, false) > 0 || changed;
        } else {
          this.#options.log?.(`Couldn't handle change to ${relPath}`, err);
        }
      }
    }
    if (changed) this.#notifyLibraryChanged();
  }

  #setProgress(rootId: number, progress: ScanProgress): void {
    const previous = this.#progress.get(rootId) ?? IDLE;
    this.#progress.set(rootId, progress);
    const now = Date.now();
    const last = this.#lastProgressPublish.get(rootId) ?? 0;
    const finished = progress.state === "parsing" && progress.done === progress.total;
    if (
      previous.state !== progress.state ||
      finished ||
      now - last >= PROGRESS_PUBLISH_INTERVAL_MS
    ) {
      this.#lastProgressPublish.set(rootId, now);
      this.#events.publish({ type: "scan.progress", rootId, scan: progress });
    }
  }

  #notifyLibraryChanged(): void {
    if (this.#libraryChangedTimer || this.#closed) return;
    this.#libraryChangedTimer = setTimeout(() => {
      this.#libraryChangedTimer = null;
      this.#events.publish({ type: "library.changed", rev: this.#repo.catalogRev() });
    }, LIBRARY_CHANGED_DEBOUNCE_MS);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#libraryChangedTimer) clearTimeout(this.#libraryChangedTimer);
    await Promise.all([...this.#watchers.keys()].map((id) => this.unwatchRoot(id)));
    this.#queue.clear();
    await this.#queue.onIdle();
    await Promise.all(this.#watchFlushes);
  }
}
