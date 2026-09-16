import type { ForwarderStatus, KeyStatus, ServerSettings, TitledbStatus } from "@nslib/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { downloadFile, request } from "./client";
import { queryKeys } from "./keys";
import { useInvalidateLibrary } from "./library";

export function useKeysStatus() {
  return useQuery({
    queryKey: queryKeys.keys,
    queryFn: () => request<KeyStatus>("GET", "/keys/status"),
  });
}

export function usePutKeys() {
  const invalidate = useInvalidateLibrary();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (contents: string) => request<KeyStatus>("PUT", "/keys", { contents }),
    onSuccess: (status) => {
      client.setQueryData(queryKeys.keys, status);
      return invalidate();
    },
    meta: { inlineError: true },
  });
}

export function useTitledb() {
  return useQuery({
    queryKey: queryKeys.titledb,
    queryFn: () => request<TitledbStatus>("GET", "/titledb"),
  });
}

/** Saves the title database source, then refreshes from it. */
export function useSaveTitledb() {
  const invalidate = useInvalidateLibrary();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (source: string | null) => {
      await request<TitledbStatus>("PUT", "/titledb", { source });
      return request<TitledbStatus>("POST", "/titledb/refresh");
    },
    onSuccess: (status) => {
      client.setQueryData(queryKeys.titledb, status);
      return invalidate();
    },
    onError: () => client.invalidateQueries({ queryKey: queryKeys.titledb }),
    meta: { inlineError: true },
  });
}

export function useForwarderStatus() {
  return useQuery({
    queryKey: queryKeys.forwarder,
    queryFn: () => request<ForwarderStatus>("GET", "/forwarder"),
  });
}

export function useDownloadForwarder() {
  return useMutation({
    mutationFn: (body?: { titleId?: string; name?: string }) =>
      downloadFile("/forwarder", body ?? {}, "NSLibrary.nsp"),
    meta: { inlineError: true },
  });
}

export function useServerSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => request<ServerSettings>("GET", "/settings"),
  });
}

export function usePutSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<ServerSettings>) =>
      request<ServerSettings>("PUT", "/settings", body),
    onSuccess: (settings) => client.setQueryData(queryKeys.settings, settings),
  });
}
