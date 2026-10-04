import type { SaveBackup, UpdateSaveBackupRequest } from "@nslib/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE, request } from "./client";
import { queryKeys } from "./keys";

/** Every save backup, newest first. Kept current by `saves.changed` events. */
export function useSaveBackups() {
  return useQuery({
    queryKey: queryKeys.saves,
    queryFn: () => request<SaveBackup[]>("GET", "/saves"),
  });
}

/** A plain link: the browser downloads the archive itself, with the session cookie. */
export function saveDownloadUrl(id: number): string {
  return `${API_BASE}/saves/${id}/download`;
}

export function useUpdateSaveBackup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateSaveBackupRequest & { id: number }) =>
      request<SaveBackup>("PATCH", `/saves/${id}`, body),
    onSuccess: (backup) => {
      client.setQueryData<SaveBackup[]>(queryKeys.saves, (list) =>
        list?.map((existing) => (existing.id === backup.id ? backup : existing)),
      );
    },
  });
}

export function useDeleteSaveBackup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => request<void>("DELETE", `/saves/${id}`),
    onSuccess: (_result, id) => {
      client.setQueryData<SaveBackup[]>(queryKeys.saves, (list) =>
        list?.filter((existing) => existing.id !== id),
      );
    },
  });
}
