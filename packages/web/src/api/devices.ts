import type {
  CreateJobsRequest,
  DeviceDetail,
  DeviceSummary,
  PairingCode,
  WebJob,
} from "@nslib/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "./client";
import { queryKeys } from "./keys";

/** Finished jobs fetched by default; History asks for more on demand. */
export const DEFAULT_JOB_LIMIT = 50;

export function useDevices() {
  return useQuery({
    queryKey: queryKeys.devices,
    queryFn: () => request<DeviceSummary[]>("GET", "/devices"),
  });
}

export function useDevice(id: number | null) {
  return useQuery({
    queryKey: queryKeys.deviceDetail(id ?? 0),
    queryFn: () => request<DeviceDetail>("GET", `/devices/${id}`),
    enabled: id !== null,
  });
}

/** Pairing code currently shown in the UI; cleared when a Switch consumes it. */
export function useDisplayedPairingCode() {
  return useQuery({
    queryKey: queryKeys.pairingCode,
    queryFn: async (): Promise<PairingCode | null> => null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

export function usePairingCode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<PairingCode>("POST", "/devices/pairing-code"),
    onSuccess: (code) => client.setQueryData(queryKeys.pairingCode, code),
    meta: { inlineError: true },
  });
}

function useInvalidateDevicesAndJobs() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.devices }),
      client.invalidateQueries({ queryKey: queryKeys.jobs }),
    ]);
}

export function useRenameDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      request<DeviceDetail>("PATCH", `/devices/${id}`, { name }),
    onSuccess: (device) => {
      client.setQueryData(queryKeys.deviceDetail(device.id), device);
      return client.invalidateQueries({ queryKey: queryKeys.devices });
    },
  });
}

export function useRevokeDevice() {
  const invalidate = useInvalidateDevicesAndJobs();
  return useMutation({
    mutationFn: (id: number) => request<DeviceDetail>("POST", `/devices/${id}/revoke`),
    onSuccess: invalidate,
  });
}

/**
 * Active jobs plus up to `limit` recently finished ones. The server is asked for one extra
 * finished job so `hasMore` can tell whether older ones exist.
 */
export function useJobs(limit = DEFAULT_JOB_LIMIT) {
  return useQuery({
    queryKey: queryKeys.jobList(limit),
    queryFn: () => request<WebJob[]>("GET", `/jobs?limit=${limit + 1}`),
    // Asking for more keeps the current list on screen until the longer one arrives.
    placeholderData: keepPreviousData,
  });
}

export function useCreateJobs() {
  const invalidate = useInvalidateDevicesAndJobs();
  return useMutation({
    mutationFn: (body: CreateJobsRequest) => request<WebJob[]>("POST", "/jobs", body),
    onSuccess: invalidate,
    meta: { inlineError: true },
  });
}

export function useCancelJob() {
  const invalidate = useInvalidateDevicesAndJobs();
  return useMutation({
    mutationFn: (id: number) => request<WebJob>("POST", `/jobs/${id}/cancel`),
    onSuccess: invalidate,
  });
}

export function useResumeJob() {
  const invalidate = useInvalidateDevicesAndJobs();
  return useMutation({
    mutationFn: (id: number) => request<WebJob>("POST", `/jobs/${id}/resume`),
    onSuccess: invalidate,
  });
}

export function useReorderJobs() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { deviceId: number; ids: number[] }) =>
      request<WebJob[]>("PUT", "/jobs/order", body),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.jobs }),
  });
}
