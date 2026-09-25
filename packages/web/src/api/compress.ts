import type {
  CompressCandidate,
  CompressSettings,
  CompressSettingsPatch,
  CompressStartResponse,
  CompressTask,
} from "@nslib/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "./client";
import { queryKeys } from "./keys";

/** Puts a task in the cached list, replacing that file's previous one. */
export function upsertCompressTask(
  tasks: CompressTask[] | undefined,
  task: CompressTask,
): CompressTask[] {
  return [task, ...(tasks ?? []).filter((existing) => existing.fileId !== task.fileId)];
}

export function isCompressActive(task: CompressTask | null | undefined): boolean {
  return task?.state === "queued" || task?.state === "running";
}

/** Background compressions, newest first; kept current by `compress.updated` events. */
export function useCompressTasks() {
  return useQuery({
    queryKey: queryKeys.compress,
    queryFn: () => request<CompressTask[]>("GET", "/compress"),
  });
}

/** The latest compression of a file, if any. All rows share one request. */
export function useCompressTask(fileId: number) {
  return useQuery({
    queryKey: queryKeys.compress,
    queryFn: () => request<CompressTask[]>("GET", "/compress"),
    select: (tasks) => tasks.find((task) => task.fileId === fileId) ?? null,
  });
}

export function useCompressSettings() {
  return useQuery({
    queryKey: queryKeys.compressSettings,
    queryFn: () => request<CompressSettings>("GET", "/compress/settings"),
  });
}

export function usePutCompressSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: CompressSettingsPatch) =>
      request<CompressSettings>("PUT", "/compress/settings", patch),
    onSuccess: (settings) => client.setQueryData(queryKeys.compressSettings, settings),
    meta: { inlineError: true },
  });
}

export function useCompressCandidates() {
  return useQuery({
    queryKey: queryKeys.compressCandidates,
    queryFn: () => request<CompressCandidate[]>("GET", "/compress/candidates"),
  });
}

export function useStartCompress() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (fileId: number) => request<CompressTask>("POST", `/files/${fileId}/compress`),
    onSuccess: (task) =>
      client.setQueryData<CompressTask[]>(queryKeys.compress, (tasks) =>
        upsertCompressTask(tasks, task),
      ),
    meta: { inlineError: true },
  });
}

export function useStartCompressMany() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (fileIds: number[]) =>
      request<CompressStartResponse>("POST", "/compress", { fileIds }),
    onSuccess: (response) =>
      client.setQueryData<CompressTask[]>(queryKeys.compress, (tasks) =>
        response.tasks.reduceRight(upsertCompressTask, tasks ?? []),
      ),
    meta: { inlineError: true },
  });
}

export function useCancelCompress() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (fileId: number) =>
      request<CompressTask>("POST", `/files/${fileId}/compress/cancel`),
    onSuccess: (task) =>
      client.setQueryData<CompressTask[]>(queryKeys.compress, (tasks) =>
        upsertCompressTask(tasks, task),
      ),
    meta: { inlineError: true },
  });
}
