/**
 * Runs file verification in the background, one file at a time, so a multi-GB hash neither ties
 * up an HTTP request nor competes with installs for disk. Progress and results are published as
 * `verify.updated` events.
 */
import type { VerifyMode, VerifyResult, VerifyTask } from "@nslib/shared";
import PQueue from "p-queue";
import { ApiError } from "../api/errors";
import type { EventBus } from "../events";
import { locateOnDisk, openLocatedFile } from "./library-fs";
import type { LibraryRepository } from "./repository";
import { verifyLibraryFile } from "./verify";

const PROGRESS_EVENT_INTERVAL_MS = 500;
/** Finished tasks kept so a page opened later still shows the last result. */
const MAX_FINISHED_TASKS = 200;

interface Entry {
  task: VerifyTask;
  abort: AbortController;
}

function isActive(task: VerifyTask): boolean {
  return task.state === "queued" || task.state === "running";
}

export class VerifyService {
  readonly #repo: LibraryRepository;
  readonly #events: EventBus;
  readonly #now: () => number;
  readonly #queue = new PQueue({ concurrency: 1 });
  /** Latest task per file, in insertion order (oldest first). */
  readonly #tasks = new Map<number, Entry>();

  constructor(repo: LibraryRepository, events: EventBus, now: () => number = Date.now) {
    this.#repo = repo;
    this.#events = events;
    this.#now = now;
  }

  /** Active tasks and recently finished ones, newest first. */
  list(): VerifyTask[] {
    return [...this.#tasks.values()].map((entry) => entry.task).reverse();
  }

  get(fileId: number): VerifyTask | null {
    return this.#tasks.get(fileId)?.task ?? null;
  }

  /** Queues a verify. A file that is already queued or running keeps its current task. */
  start(fileId: number, mode: VerifyMode): VerifyTask {
    const existing = this.#tasks.get(fileId);
    if (existing && isActive(existing.task)) return existing.task;

    const file = this.#repo.getFile(fileId);
    if (!file || !this.#repo.getRoot(file.rootId)) {
      throw new ApiError("NOT_FOUND", "That file is no longer in the library");
    }
    if (file.missingSince !== null) {
      throw new ApiError("FILE_MISSING", "This file is no longer on disk");
    }

    const now = this.#now();
    const entry: Entry = {
      task: {
        fileId,
        mode,
        state: "queued",
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

  cancel(fileId: number): VerifyTask {
    const entry = this.#tasks.get(fileId);
    if (!entry) throw new ApiError("NOT_FOUND", "That file isn't being verified");
    if (!isActive(entry.task)) return entry.task;
    entry.abort.abort();
    // A queued task never starts; a running one stops at its next chunk.
    this.#finish(entry, { state: "cancelled" });
    return entry.task;
  }

  close(): void {
    for (const entry of this.#tasks.values()) entry.abort.abort();
    this.#queue.clear();
  }

  async #run(entry: Entry): Promise<void> {
    if (entry.abort.signal.aborted) return;
    const { fileId, mode } = entry.task;
    this.#update(entry, { state: "running" });
    let lastEvent = 0;
    try {
      const result = await this.#verify(fileId, mode, entry.abort.signal, (done, total) => {
        entry.task = { ...entry.task, bytesDone: done, bytesTotal: total, updatedAt: this.#now() };
        const now = Date.now();
        if (now - lastEvent >= PROGRESS_EVENT_INTERVAL_MS) {
          lastEvent = now;
          this.#publish(entry);
        }
      });
      if (entry.abort.signal.aborted) return;
      this.#finish(entry, { state: "done", result });
      this.#events.publish({ type: "library.changed", rev: this.#repo.catalogRev() });
    } catch (err) {
      if (entry.abort.signal.aborted) return;
      const error =
        err instanceof ApiError
          ? err.message
          : `Couldn't read the file: ${err instanceof Error ? err.message : String(err)}`;
      this.#finish(entry, { state: "failed", error });
    }
  }

  async #verify(
    fileId: number,
    mode: VerifyMode,
    signal: AbortSignal,
    onProgress: (done: number, total: number) => void,
  ): Promise<VerifyResult> {
    // Looked up again here: the file may have moved or vanished while the task was queued.
    const file = this.#repo.getFile(fileId);
    const root = file && this.#repo.getRoot(file.rootId);
    if (!file || !root) throw new ApiError("NOT_FOUND", "That file is no longer in the library");
    if (file.missingSince !== null) {
      throw new ApiError("FILE_MISSING", "This file is no longer on disk");
    }
    const located = await locateOnDisk(root.path, file.relPath);
    if (!located) throw new ApiError("FILE_MISSING", "This file is no longer on disk");
    const reader = await openLocatedFile(located);
    try {
      return await verifyLibraryFile(this.#repo, file, reader, mode, { signal, onProgress });
    } finally {
      await reader.close();
    }
  }

  #finish(entry: Entry, patch: Partial<VerifyTask>): void {
    this.#update(entry, patch);
    this.#trimFinished();
  }

  #update(entry: Entry, patch: Partial<VerifyTask>): void {
    entry.task = { ...entry.task, ...patch, updatedAt: this.#now() };
    this.#publish(entry);
  }

  #publish(entry: Entry): void {
    this.#events.publish({ type: "verify.updated", task: entry.task });
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
