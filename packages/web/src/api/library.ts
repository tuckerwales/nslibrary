import type {
  AppDetail,
  AppFlag,
  AppSort,
  AppSummary,
  CreateRootRequest,
  HomebrewItem,
  LibraryRoot,
  LibraryStats,
  ProblemsReport,
  SortOrder,
  UpdateRootRequest,
  VerifyMode,
  VerifyTask,
} from "@nslib/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { request } from "./client";
import { LIBRARY_QUERY_KEYS, queryKeys } from "./keys";

export function useInvalidateLibrary() {
  const client = useQueryClient();
  return () =>
    Promise.all(LIBRARY_QUERY_KEYS.map((queryKey) => client.invalidateQueries({ queryKey })));
}

export function useStats() {
  return useQuery({
    queryKey: queryKeys.stats,
    queryFn: () => request<LibraryStats>("GET", "/stats"),
  });
}

/** The library orderings the web UI offers, as they appear in `?sort=`. */
export const LIBRARY_SORTS = {
  name: { sort: "name", order: "asc" },
  "added-desc": { sort: "added", order: "desc" },
  "added-asc": { sort: "added", order: "asc" },
} as const satisfies Record<string, { sort: AppSort; order: SortOrder }>;

export type LibrarySort = keyof typeof LIBRARY_SORTS;

export function isLibrarySort(value: string | null): value is LibrarySort {
  return value !== null && Object.hasOwn(LIBRARY_SORTS, value);
}

export function useApps(q: string, flag: AppFlag | null, librarySort: LibrarySort = "name") {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (flag) params.set("flag", flag);
  // The server's default is name order, so only other orders go on the wire.
  if (librarySort !== "name") {
    const { sort, order } = LIBRARY_SORTS[librarySort];
    params.set("sort", sort);
    params.set("order", order);
  }
  const query = params.size > 0 ? `?${params}` : "";
  return useQuery({
    queryKey: queryKeys.appList(q, flag, librarySort),
    queryFn: () => request<AppSummary[]>("GET", `/apps${query}`),
    placeholderData: keepPreviousData,
  });
}

/** One title's details, as query options so several can be fetched at once. */
export function appDetailQuery(applicationId: string) {
  return {
    queryKey: queryKeys.appDetail(applicationId),
    queryFn: () => request<AppDetail>("GET", `/apps/${encodeURIComponent(applicationId)}`),
  };
}

export function useApp(applicationId: string) {
  return useQuery(appDetailQuery(applicationId));
}

export function useHomebrew() {
  return useQuery({
    queryKey: queryKeys.homebrew,
    queryFn: () => request<HomebrewItem[]>("GET", "/homebrew"),
  });
}

export function useProblems() {
  return useQuery({
    queryKey: queryKeys.problems,
    queryFn: () => request<ProblemsReport>("GET", "/problems"),
  });
}

export function useRoots() {
  return useQuery({
    queryKey: queryKeys.roots,
    queryFn: () => request<LibraryRoot[]>("GET", "/roots"),
  });
}

/** Library folder paths by root ID, for showing where a file lives. */
export function useRootPaths(): Map<number, string> {
  const roots = useRoots().data;
  return useMemo(() => new Map((roots ?? []).map((root) => [root.id, root.path])), [roots]);
}

export function useAddRoot() {
  const invalidate = useInvalidateLibrary();
  return useMutation({
    mutationFn: (body: CreateRootRequest) => request<LibraryRoot>("POST", "/roots", body),
    onSuccess: invalidate,
    meta: { inlineError: true },
  });
}

export function useUpdateRoot() {
  const invalidate = useInvalidateLibrary();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: UpdateRootRequest }) =>
      request<LibraryRoot>("PATCH", `/roots/${id}`, patch),
    onSuccess: invalidate,
  });
}

export function useRemoveRoot() {
  const invalidate = useInvalidateLibrary();
  return useMutation({
    mutationFn: (id: number) => request<void>("DELETE", `/roots/${id}`),
    onSuccess: invalidate,
  });
}

export function useScanRoot() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => request<LibraryRoot>("POST", `/roots/${id}/scan`),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.roots }),
  });
}

/** Puts a task in the cached list, replacing that file's previous one. */
export function upsertVerifyTask(tasks: VerifyTask[] | undefined, task: VerifyTask): VerifyTask[] {
  return [task, ...(tasks ?? []).filter((existing) => existing.fileId !== task.fileId)];
}

/** Every recent background verify. */
export function useVerifyTasks() {
  return useQuery({
    queryKey: queryKeys.verify,
    queryFn: () => request<VerifyTask[]>("GET", "/verify"),
  });
}

/** The latest background verify for a file, if any. All rows share one request. */
export function useVerifyTask(fileId: number) {
  return useQuery({
    queryKey: queryKeys.verify,
    queryFn: () => request<VerifyTask[]>("GET", "/verify"),
    select: (tasks) => tasks.find((task) => task.fileId === fileId) ?? null,
  });
}

export function useStartVerify() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, mode }: { id: number; mode?: VerifyMode }) =>
      request<VerifyTask>("POST", `/files/${id}/verify`, { mode: mode ?? "full" }),
    onSuccess: (task) =>
      client.setQueryData<VerifyTask[]>(queryKeys.verify, (tasks) => upsertVerifyTask(tasks, task)),
  });
}

export function useCancelVerify() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => request<VerifyTask>("POST", `/files/${id}/verify/cancel`),
    onSuccess: (task) =>
      client.setQueryData<VerifyTask[]>(queryKeys.verify, (tasks) => upsertVerifyTask(tasks, task)),
  });
}
