import type { DeviceSummary, WebJob } from "@nslib/shared";
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
});
