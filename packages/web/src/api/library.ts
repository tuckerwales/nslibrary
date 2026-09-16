import type {
  AppDetail,
  AppFlag,
  AppSummary,
  CreateRootRequest,
  HomebrewItem,
  LibraryRoot,
  LibraryStats,
  ProblemsReport,
  UpdateRootRequest,
  VerifyMode,
  VerifyResult,
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

export function useApps(q: string, flag: AppFlag | null) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (flag) params.set("flag", flag);
  const query = params.size > 0 ? `?${params}` : "";
  return useQuery({
    queryKey: queryKeys.appList(q, flag),
    queryFn: () => request<AppSummary[]>("GET", `/apps${query}`),
    placeholderData: keepPreviousData,
  });
}

export function useApp(applicationId: string) {
  return useQuery({
    queryKey: queryKeys.appDetail(applicationId),
    queryFn: () => request<AppDetail>("GET", `/apps/${encodeURIComponent(applicationId)}`),
  });
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

export function useVerifyFile() {
  const invalidate = useInvalidateLibrary();
  return useMutation({
    mutationFn: ({ id, mode }: { id: number; mode?: VerifyMode }) =>
      request<VerifyResult>("POST", `/files/${id}/verify`, { mode: mode ?? "full" }),
    onSuccess: invalidate,
  });
}
