import type { CompressResult, CompressTask } from "@nslib/shared";
import { formatBytes } from "./format";

/** zstd levels offered in Settings. The server accepts 1–22. */
export const COMPRESS_LEVELS = [
  { level: 3, label: "Fast", hint: "Quick, but saves the least." },
  { level: 18, label: "Standard", hint: "What nsz uses. A good balance of time and space." },
  { level: 22, label: "Smallest", hint: "Slowest, and only a little smaller than Standard." },
] as const;

function percent(done: number, total: number): string {
  return `${total > 0 ? Math.floor((done / total) * 100) : 0}%`;
}

/** Status line for a queued or running compression. */
export function compressProgressText(task: CompressTask): string {
  if (task.state === "queued") return "Waiting to compress…";
  switch (task.phase) {
    case "checking":
      return `Checking ${percent(task.bytesDone, task.bytesTotal)}`;
    case "finishing":
      return "Finishing…";
    default:
      return `Compressing ${percent(task.bytesDone, task.bytesTotal)}`;
  }
}

/** "Saved 1.2 GB (38%)", or a note when compression didn't help. */
export function savedText(result: Pick<CompressResult, "savedBytes" | "sourceSize">): string {
  if (result.savedBytes <= 0) return "No space saved";
  const share =
    result.sourceSize > 0 ? Math.round((result.savedBytes / result.sourceSize) * 100) : 0;
  return `Saved ${formatBytes(result.savedBytes)} (${share}%)`;
}

/** The file name of a server path, whichever separator it uses. */
export function outputFileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** Space saved by the compressions that finished, for a running total. */
export function totalSaved(tasks: CompressTask[]): { files: number; bytes: number } {
  const done = tasks.filter((task) => task.state === "done" && task.result);
  return {
    files: done.length,
    bytes: done.reduce((sum, task) => sum + Math.max(0, task.result?.savedBytes ?? 0), 0),
  };
}
