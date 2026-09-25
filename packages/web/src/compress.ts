import type { CompressResult, CompressTask } from "@nslib/shared";
import { formatBytes } from "./format";

/** zstd levels offered on the Compression page. The server accepts 1–22. */
export const COMPRESS_LEVELS = [
  { level: 3, label: "Fast", hint: "Finishes quickest, but saves the least space." },
  { level: 18, label: "Standard", hint: "A good balance of time and space. What nsz uses." },
  { level: 22, label: "Smallest", hint: "Slowest, and only a little smaller than Standard." },
] as const;

export function levelLabel(level: number): string {
  return COMPRESS_LEVELS.find((option) => option.level === level)?.label ?? `Level ${level}`;
}

/** NSZ files usually come out 30 to 60% smaller than the NSP. */
const TYPICAL_SAVING = [0.3, 0.6] as const;

/** "about 1.2 GB to 2.4 GB", the space compressing `bytes` of NSP usually frees. */
export function estimatedSavingText(bytes: number): string {
  return `about ${formatBytes(bytes * TYPICAL_SAVING[0])} to ${formatBytes(bytes * TYPICAL_SAVING[1])}`;
}

function percentOf(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
}

/** Progress through the current step, 0 to 100, or null while there's nothing to measure. */
export function stepPercent(task: CompressTask): number | null {
  if (task.state !== "running" || task.phase === "finishing" || task.bytesTotal <= 0) return null;
  return percentOf(task.bytesDone, task.bytesTotal);
}

/** Which of the two long steps is running, in words. */
export function stepLabel(task: CompressTask): string {
  if (task.state === "queued") return "Waiting its turn";
  switch (task.phase) {
    case "checking":
      return "Step 2 of 2: checking the NSZ matches the original";
    case "finishing":
      return "Saving the NSZ";
    default:
      return "Step 1 of 2: compressing";
  }
}

/** Short status line for a queued or running compression. */
export function compressProgressText(task: CompressTask): string {
  if (task.state === "queued") return "Waiting to compress…";
  switch (task.phase) {
    case "checking":
      return `Checking ${percentOf(task.bytesDone, task.bytesTotal)}%`;
    case "finishing":
      return "Finishing…";
    default:
      return `Compressing ${percentOf(task.bytesDone, task.bytesTotal)}%`;
  }
}

function durationText(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return "less than a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/**
 * "About 4 min left in this step, 85 MB/s", from the step's average speed so far. Null until
 * there's enough to go on.
 */
export function timeLeftText(task: CompressTask, now = Date.now()): string | null {
  if (task.state !== "running" || task.phaseStartedAt === null || task.phase === "finishing") {
    return null;
  }
  const elapsed = now - task.phaseStartedAt;
  if (elapsed < 3000 || task.bytesDone <= 0 || task.bytesTotal <= 0) return null;
  const rate = task.bytesDone / elapsed;
  const left = (task.bytesTotal - task.bytesDone) / rate;
  const speed = `${formatBytes(rate * 1000)}/s`;
  return left < 60_000
    ? `Less than a minute left in this step, ${speed}`
    : `About ${durationText(left)} left in this step, ${speed}`;
}

function shareText(result: Pick<CompressResult, "savedBytes" | "sourceSize">): string {
  const share =
    result.sourceSize > 0 ? Math.round((result.savedBytes / result.sourceSize) * 100) : 0;
  return `${formatBytes(result.savedBytes)} (${share}%)`;
}

/**
 * The headline for a finished compression. Space is only saved once the NSP is gone, so until
 * then it says how much smaller the NSZ is.
 */
export function savedText(
  result: Pick<CompressResult, "savedBytes" | "sourceSize" | "originalRemoved">,
): string {
  if (result.savedBytes <= 0) return "The NSZ isn't any smaller";
  return result.originalRemoved ? `Saved ${shareText(result)}` : `${shareText(result)} smaller`;
}

/** The file name of a server path, whichever separator it uses. */
export function outputFileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** The folder part of a server path. */
export function outputFolder(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
}

/**
 * Space the finished compressions have saved (their NSP is gone), and what deleting the NSPs
 * still on disk would save. Until an NSP is deleted, both copies take up space.
 */
export function savingsSummary(tasks: CompressTask[]): {
  files: number;
  freed: number;
  pending: number;
} {
  const done = tasks.filter((task) => task.state === "done" && task.result);
  let freed = 0;
  let pending = 0;
  for (const task of done) {
    const result = task.result;
    if (!result) continue;
    if (result.originalRemoved) freed += Math.max(0, result.savedBytes);
    else pending += Math.max(0, result.savedBytes);
  }
  return { files: done.length, freed, pending };
}
