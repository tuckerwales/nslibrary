import type { DeviceSummary, VerifyTask, WebJob } from "@nslib/shared";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { queryKeys } from "../src/api";
import { applyServerEvent } from "../src/live";
import { job } from "./fixtures";

function setUp() {
  const client = new QueryClient();
  client.setQueryData<WebJob[]>(queryKeys.jobList(50), [job({ id: 1, status: "queued" })]);
  client.setQueryData<DeviceSummary[]>(queryKeys.devices, []);
  client.setQueryData(queryKeys.deviceDetail(1), {});
  return client;
}

const isInvalidated = (client: QueryClient, queryKey: readonly unknown[]) =>
  client.getQueryState(queryKey)?.isInvalidated ?? false;

describe("applyServerEvent", () => {
  it("keeps the latest verify task per file", () => {
    const client = new QueryClient();
    const task = (fileId: number, patch: Partial<VerifyTask> = {}): VerifyTask => ({
      fileId,
      mode: "full",
      state: "running",
      bytesDone: 0,
      bytesTotal: 100,
      result: null,
      error: null,
      startedAt: 0,
      updatedAt: 0,
      ...patch,
    });
    // Nothing is cached yet, so there's nothing to patch.
    applyServerEvent(client, { type: "verify.updated", task: task(1) });
    expect(client.getQueryData(queryKeys.verify)).toBeUndefined();

    client.setQueryData<VerifyTask[]>(queryKeys.verify, [task(1), task(2)]);
    applyServerEvent(client, { type: "verify.updated", task: task(2, { bytesDone: 60 }) });
    applyServerEvent(client, { type: "verify.updated", task: task(3, { state: "queued" }) });
    const tasks = client.getQueryData<VerifyTask[]>(queryKeys.verify);
    expect(tasks?.map((t) => [t.fileId, t.bytesDone])).toEqual([
      [3, 0],
      [2, 60],
      [1, 0],
    ]);
  });

  it("patches job progress into the cache without refetching", () => {
    const client = setUp();
    applyServerEvent(client, { type: "job.updated", job: job({ id: 1, status: "running" }) });
    for (const done of [10, 20]) {
      client.setQueryData(queryKeys.devices, []); // clears the invalidation from the status change
      applyServerEvent(client, {
        type: "job.updated",
        job: job({ id: 1, status: "running", bytesDone: done }),
      });
      expect(isInvalidated(client, queryKeys.devices)).toBe(false);
    }
    expect(client.getQueryData<WebJob[]>(queryKeys.jobList(50))?.[0]?.bytesDone).toBe(20);
    expect(isInvalidated(client, queryKeys.jobList(50))).toBe(false);
  });

  it("refreshes devices when a job's status changes, and installed titles when it finishes", () => {
    const client = setUp();
    applyServerEvent(client, { type: "job.updated", job: job({ id: 1, status: "running" }) });
    expect(isInvalidated(client, queryKeys.devices)).toBe(true);
    expect(isInvalidated(client, queryKeys.deviceDetail(1))).toBe(false);

    applyServerEvent(client, { type: "job.updated", job: job({ id: 1, status: "done" }) });
    expect(isInvalidated(client, queryKeys.deviceDetail(1))).toBe(true);
  });

  it("adds jobs it hasn't seen, such as ones started on a Switch", () => {
    const client = setUp();
    applyServerEvent(client, {
      type: "job.updated",
      job: job({ id: 2, status: "queued", source: "switch", position: 0 }),
    });
    expect(client.getQueryData<WebJob[]>(queryKeys.jobList(50))?.map((j) => j.id)).toEqual([2, 1]);
  });

  it("doesn't refetch devices or jobs when the library changes", () => {
    const client = setUp();
    client.setQueryData(queryKeys.appList("", null), []);
    applyServerEvent(client, { type: "library.changed", rev: 2 });
    expect(isInvalidated(client, queryKeys.appList("", null))).toBe(true);
    expect(isInvalidated(client, queryKeys.devices)).toBe(false);
    expect(isInvalidated(client, queryKeys.jobList(50))).toBe(false);
  });

  it("refetches save backups when they change", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.saves, []);
    applyServerEvent(client, { type: "saves.changed" });
    expect(isInvalidated(client, queryKeys.saves)).toBe(true);
  });
});
