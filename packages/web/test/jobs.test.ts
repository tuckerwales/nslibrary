import { describe, expect, it } from "vitest";
import { activeJobs, finishedJobs, jobStatusLabel } from "../src/jobs";
import { job } from "./fixtures";

describe("job helpers", () => {
  it("orders finished jobs by when they finished, not queue position", () => {
    const jobs = [
      job({ id: 1, position: 1, status: "done", completedAt: 3000 }),
      job({ id: 2, position: 2, status: "failed", completedAt: 5000 }),
      job({ id: 3, position: 3, status: "cancelled", completedAt: null, updatedAt: 4000 }),
      job({ id: 4, position: 4, status: "queued" }),
    ];
    expect(finishedJobs(jobs).map((j) => j.id)).toEqual([2, 3, 1]);
  });

  it("puts running jobs before the queue, then follows queue position", () => {
    const jobs = [
      job({ id: 1, position: 2, status: "queued" }),
      job({ id: 2, position: 3, status: "running" }),
      job({ id: 3, position: 1, status: "queued" }),
      job({ id: 4, position: 4, status: "done" }),
    ];
    expect(activeJobs(jobs).map((j) => j.id)).toEqual([2, 3, 1]);
  });

  it("shows byte progress for running installs", () => {
    expect(jobStatusLabel(job({ status: "running", size: 2048, bytesDone: 1024 }))).toBe(
      "Installing · 1.0 KB of 2.0 KB",
    );
  });
});
