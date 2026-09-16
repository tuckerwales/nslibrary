import type {
  AppDetail,
  AppFlag,
  AppSummary,
  AuthStatus,
  CreateJobsRequest,
  CreateRootRequest,
  DeviceDetail,
  DeviceSummary,
  HomebrewItem,
  KeyStatus,
  LibraryRoot,
  LibraryStats,
  LoginRequest,
  PairingCode,
  ProblemsReport,
  ServerSettings,
  SetupRequest,
  TitledbStatus,
  UpdateRootRequest,
  VerifyMode,
  VerifyResult,
  WebJob,
} from "@nslib/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const API_BASE = "/api/v1";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError(
      0,
      "NETWORK",
      "Can't reach the server. Check your connection and try again.",
    );
  }
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      data?.error?.code ?? "INTERNAL",
      data?.error?.msg ?? `The server returned an error (${response.status})`,
    );
  }
  return data as T;
}

/** Queries that depend on library contents; refreshed together when the library changes. */
export const LIBRARY_QUERY_KEYS = [
  ["apps"],
  ["app"],
  ["stats"],
  ["problems"],
  ["homebrew"],
  ["roots"],
  ["keys"],
  ["titledb"],
  ["devices"],
  ["jobs"],
];

export function useAuthStatus() {
  return useQuery({
    queryKey: ["auth"],
    queryFn: () => request<AuthStatus>("GET", "/auth/status"),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export function useSetup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SetupRequest) => request<AuthStatus>("POST", "/auth/setup", body),
    onSuccess: (status) => client.setQueryData(["auth"], status),
  });
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => request<AuthStatus>("POST", "/auth/login", body),
    onSuccess: (status) => client.setQueryData(["auth"], status),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<AuthStatus>("POST", "/auth/logout"),
    onSuccess: (status) => {
      client.removeQueries();
      client.setQueryData(["auth"], status);
    },
  });
}

export function useStats() {
  return useQuery({ queryKey: ["stats"], queryFn: () => request<LibraryStats>("GET", "/stats") });
}

export function useApps(q: string, flag: AppFlag | null) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (flag) params.set("flag", flag);
  const query = params.size > 0 ? `?${params}` : "";
  return useQuery({
    queryKey: ["apps", q, flag],
    queryFn: () => request<AppSummary[]>("GET", `/apps${query}`),
    placeholderData: keepPreviousData,
  });
}

export function useApp(applicationId: string) {
  return useQuery({
    queryKey: ["app", applicationId],
    queryFn: () => request<AppDetail>("GET", `/apps/${encodeURIComponent(applicationId)}`),
  });
}

export function useHomebrew() {
  return useQuery({
    queryKey: ["homebrew"],
    queryFn: () => request<HomebrewItem[]>("GET", "/homebrew"),
  });
}

export function useProblems() {
  return useQuery({
    queryKey: ["problems"],
    queryFn: () => request<ProblemsReport>("GET", "/problems"),
  });
}

export function useRoots() {
  return useQuery({ queryKey: ["roots"], queryFn: () => request<LibraryRoot[]>("GET", "/roots") });
}

function useInvalidateLibrary() {
  const client = useQueryClient();
  return () =>
    Promise.all(LIBRARY_QUERY_KEYS.map((queryKey) => client.invalidateQueries({ queryKey })));
}

export function useAddRoot() {
  const invalidate = useInvalidateLibrary();
  return useMutation({
    mutationFn: (body: CreateRootRequest) => request<LibraryRoot>("POST", "/roots", body),
    onSuccess: invalidate,
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
    onSuccess: () => client.invalidateQueries({ queryKey: ["roots"] }),
  });
}

export function useKeysStatus() {
  return useQuery({
    queryKey: ["keys"],
    queryFn: () => request<KeyStatus>("GET", "/keys/status"),
  });
}

export function usePutKeys() {
  const invalidate = useInvalidateLibrary();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (contents: string) => request<KeyStatus>("PUT", "/keys", { contents }),
    onSuccess: (status) => {
      client.setQueryData(["keys"], status);
      return invalidate();
    },
  });
}

export function useTitledb() {
  return useQuery({
    queryKey: ["titledb"],
    queryFn: () => request<TitledbStatus>("GET", "/titledb"),
  });
}

export function usePutTitledb() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { source: string | null }) =>
      request<TitledbStatus>("PUT", "/titledb", body),
    onSuccess: (status) => client.setQueryData(["titledb"], status),
  });
}

export function useRefreshTitledb() {
  const invalidate = useInvalidateLibrary();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<TitledbStatus>("POST", "/titledb/refresh"),
    onSuccess: (status) => {
      client.setQueryData(["titledb"], status);
      return invalidate();
    },
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

export function useDevices() {
  return useQuery({
    queryKey: ["devices"],
    queryFn: () => request<DeviceSummary[]>("GET", "/devices"),
  });
}

/** Pairing code currently shown in the UI; cleared when a Switch consumes it. */
export function useDisplayedPairingCode() {
  return useQuery({
    queryKey: ["pairing-code"],
    queryFn: async (): Promise<PairingCode | null> => null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

export function useDevice(id: number | null) {
  return useQuery({
    queryKey: ["devices", id],
    queryFn: () => request<DeviceDetail>("GET", `/devices/${id}`),
    enabled: id !== null,
  });
}

export function usePairingCode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<PairingCode>("POST", "/devices/pairing-code"),
    onSuccess: (code) => client.setQueryData(["pairing-code"], code),
  });
}

export function useRenameDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      request<DeviceDetail>("PATCH", `/devices/${id}`, { name }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["devices"] }),
  });
}

export function useRevokeDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => request<DeviceDetail>("POST", `/devices/${id}/revoke`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["devices"] });
      void client.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
}

export function useJobs(deviceId?: number) {
  const query = deviceId ? `?deviceId=${deviceId}` : "";
  return useQuery({
    queryKey: ["jobs", deviceId ?? "all"],
    queryFn: () => request<WebJob[]>("GET", `/jobs${query}`),
  });
}

export function useCreateJobs() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateJobsRequest) => request<WebJob[]>("POST", "/jobs", body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["jobs"] });
      void client.invalidateQueries({ queryKey: ["devices"] });
    },
  });
}

export function useCancelJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => request<WebJob>("POST", `/jobs/${id}/cancel`),
    onSuccess: () => client.invalidateQueries({ queryKey: ["jobs"] }),
  });
}

export function useServerSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => request<ServerSettings>("GET", "/settings"),
  });
}

export function usePutSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<ServerSettings>) =>
      request<ServerSettings>("PUT", "/settings", body),
    onSuccess: (settings) => client.setQueryData(["settings"], settings),
  });
}
