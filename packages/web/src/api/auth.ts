import type { AuthStatus, ChangePasswordRequest, LoginRequest, SetupRequest } from "@nslib/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "./client";
import { queryKeys } from "./keys";

export function useAuthStatus() {
  return useQuery({
    queryKey: queryKeys.auth,
    queryFn: () => request<AuthStatus>("GET", "/auth/status"),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export function useSetup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SetupRequest) => request<AuthStatus>("POST", "/auth/setup", body),
    onSuccess: (status) => client.setQueryData(queryKeys.auth, status),
    meta: { inlineError: true },
  });
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => request<AuthStatus>("POST", "/auth/login", body),
    onSuccess: (status) => client.setQueryData(queryKeys.auth, status),
    meta: { inlineError: true },
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<AuthStatus>("POST", "/auth/logout"),
    onSuccess: (status) => {
      client.removeQueries();
      client.setQueryData(queryKeys.auth, status);
    },
  });
}

/** Other sessions are signed out; this one stays signed in. */
export function useChangePassword() {
  return useMutation({
    mutationFn: (body: ChangePasswordRequest) => request<void>("POST", "/auth/password", body),
    meta: { inlineError: true },
  });
}
