import type { JobStatus, WebJob } from "@nslib/shared";
import { formatBytes, updateLabel } from "./format";

/**
 * Jobs waiting for or holding a Switch. Mirrors the shared helper, which isn't imported so the
 * shared package's runtime (and zod) stays out of the browser bundle.
 */
export function isActiveJobStatus(status: JobStatus): boolean {
  return status === "queued" || status === "claimed" || status === "running";
}

export function jobTitle(job: WebJob): string {
  if (job.type === "patch") return `${job.name} · ${updateLabel(job.version)}`;
  return job.name;
}

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  claimed: "Starting",
  running: "Installing",
  done: "Installed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function jobStatusLabel(job: WebJob): string {
  const label = STATUS_LABEL[job.status];
  if (job.status === "running" && job.size > 0) {
    return `${label} · ${formatBytes(job.bytesDone)} of ${formatBytes(job.size)}`;
  }
  return label;
}

/** Active jobs: running ones first, then the queue in install order. */
export function activeJobs(jobs: WebJob[]): WebJob[] {
  return jobs
    .filter((job) => isActiveJobStatus(job.status))
    .sort(
      (a, b) =>
        Number(a.status === "queued") - Number(b.status === "queued") ||
        a.position - b.position ||
        a.id - b.id,
    );
}

/** Finished jobs, most recently finished first. */
export function finishedJobs(jobs: WebJob[]): WebJob[] {
  const finishedAt = (job: WebJob) => job.completedAt ?? job.updatedAt;
  return jobs
    .filter((job) => !isActiveJobStatus(job.status))
    .sort((a, b) => finishedAt(b) - finishedAt(a) || b.id - a.id);
}
