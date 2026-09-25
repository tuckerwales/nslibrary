import type {
  CompressTask,
  JobStatus,
  LibraryRoot,
  ServerEvent,
  VerifyTask,
  WebJob,
} from "@nslib/shared";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import {
  isCompressActive,
  LIBRARY_QUERY_KEYS,
  queryKeys,
  upsertCompressTask,
  upsertVerifyTask,
} from "./api";
import { savedText } from "./compress";
import { isActiveJobStatus } from "./jobs";
import { showToast } from "./toast";

const MAX_RETRY_DELAY_MS = 30_000;

export type ConnectionState = "connecting" | "open" | "reconnecting";

let connectionState: ConnectionState = "connecting";
const listeners = new Set<() => void>();

function setConnectionState(next: ConnectionState) {
  if (next === connectionState) return;
  connectionState = next;
  for (const listener of listeners) listener();
}

/** Whether the live event stream is connected. */
export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => connectionState,
  );
}

function invalidateLibrary(client: QueryClient) {
  for (const queryKey of LIBRARY_QUERY_KEYS) void client.invalidateQueries({ queryKey });
}

function sortJobs(jobs: WebJob[]): WebJob[] {
  return jobs.sort((a, b) => a.position - b.position || a.id - b.id);
}

/** Last status seen per job, so progress-only updates can be told apart from status changes. */
const jobStatuses = new WeakMap<QueryClient, Map<number, JobStatus>>();

/** Applies a job update to every cached job list. Returns true if the job's status changed. */
function patchJob(client: QueryClient, job: WebJob): boolean {
  for (const [queryKey, jobs] of client.getQueriesData<WebJob[]>({ queryKey: queryKeys.jobs })) {
    if (!jobs) continue;
    const index = jobs.findIndex((existing) => existing.id === job.id);
    const next = index === -1 ? sortJobs([...jobs, job]) : jobs.with(index, job);
    client.setQueryData(queryKey, next);
  }
  let statuses = jobStatuses.get(client);
  if (!statuses) {
    statuses = new Map();
    jobStatuses.set(client, statuses);
  }
  const previous = statuses.get(job.id);
  statuses.set(job.id, job.status);
  return previous !== job.status;
}

/**
 * A compression can take a long time, so its end is announced wherever you are. Only a task seen
 * running is announced: a finished one arriving again (say, after a reconnect) isn't news.
 */
function announceCompression(previous: CompressTask | undefined, task: CompressTask) {
  if (!previous || !isCompressActive(previous) || isCompressActive(task)) return;
  if (task.state === "done" && task.result) {
    showToast(`${task.name} is compressed: ${savedText(task.result)}.`, "success");
  } else if (task.state === "failed") {
    showToast(`Couldn't compress ${task.name}. ${task.error ?? ""}`.trim());
  }
}

/** Updates the query cache for one event from the server's stream. */
export function applyServerEvent(client: QueryClient, event: ServerEvent) {
  switch (event.type) {
    case "library.changed":
      invalidateLibrary(client);
      break;
    case "roots.changed":
      void client.invalidateQueries({ queryKey: queryKeys.roots });
      void client.invalidateQueries({ queryKey: queryKeys.stats });
      break;
    case "scan.progress":
      client.setQueryData<LibraryRoot[]>(queryKeys.roots, (roots) =>
        roots?.map((root) => (root.id === event.rootId ? { ...root, scan: event.scan } : root)),
      );
      break;
    case "device.paired":
      client.setQueryData(queryKeys.pairingCode, null);
      void client.invalidateQueries({ queryKey: queryKeys.devices });
      break;
    case "device.online":
    case "device.offline":
      void client.invalidateQueries({ queryKey: queryKeys.devices });
      void client.invalidateQueries({ queryKey: queryKeys.deviceDetail(event.deviceId) });
      break;
    case "verify.updated":
      // Only patch a list that's already loaded; otherwise the next fetch has it anyway.
      if (client.getQueryData(queryKeys.verify)) {
        client.setQueryData<VerifyTask[]>(queryKeys.verify, (tasks) =>
          upsertVerifyTask(tasks, event.task),
        );
      }
      break;
    case "compress.updated": {
      const tasks = client.getQueryData<CompressTask[]>(queryKeys.compress);
      if (tasks) {
        const previous = tasks.find((task) => task.fileId === event.task.fileId);
        announceCompression(previous, event.task);
        client.setQueryData<CompressTask[]>(queryKeys.compress, (tasks) =>
          upsertCompressTask(tasks, event.task),
        );
      }
      // A finished compression changes which files are left to compress.
      if (event.task.state === "done") {
        void client.invalidateQueries({ queryKey: queryKeys.compressCandidates });
      }
      break;
    }
    case "job.updated": {
      // Progress arrives every half second; only status changes need anything refetched.
      if (!patchJob(client, event.job)) break;
      void client.invalidateQueries({ queryKey: queryKeys.devices });
      if (!isActiveJobStatus(event.job.status)) {
        void client.invalidateQueries({ queryKey: queryKeys.deviceDetail(event.job.deviceId) });
      }
      break;
    }
  }
}

/** Keeps queries fresh from the server's event stream, reconnecting with backoff. */
export function useLiveUpdates(enabled: boolean) {
  const client = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let stopped = false;

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/v1/ws`);
      socket.onopen = () => {
        // Anything could have changed while disconnected.
        if (attempts > 0) {
          invalidateLibrary(client);
          void client.invalidateQueries({ queryKey: queryKeys.devices });
          void client.invalidateQueries({ queryKey: queryKeys.device });
          void client.invalidateQueries({ queryKey: queryKeys.jobs });
          void client.invalidateQueries({ queryKey: queryKeys.verify });
          void client.invalidateQueries({ queryKey: queryKeys.compress });
        }
        attempts = 0;
        setConnectionState("open");
      };
      socket.onmessage = (message) => {
        try {
          applyServerEvent(client, JSON.parse(String(message.data)) as ServerEvent);
        } catch {
          // Ignore malformed events.
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        setConnectionState("reconnecting");
        // A socket can't report why it was refused; an expired session shows up here.
        void client.invalidateQueries({ queryKey: queryKeys.auth });
        const delay = Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** attempts);
        attempts++;
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      socket?.close();
      setConnectionState("connecting");
    };
  }, [enabled, client]);
}
