import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiRequestError, NETWORK_ERROR_STATUS, queryKeys } from "./api";
import { showToast } from "./toast";

function isSessionExpired(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 401;
}

/** Client errors won't change on retry; server and network errors might. */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof ApiRequestError)) return true;
  return err.status === NETWORK_ERROR_STATUS || err.status >= 500;
}

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: handleSessionExpiry }),
    mutationCache: new MutationCache({
      onError: (err, _variables, _context, mutation) => {
        handleSessionExpiry(err);
        if (!isSessionExpired(err) && !mutation.meta?.inlineError) showToast(err.message);
      },
    }),
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: (failures, err) => isRetryable(err) && failures < 2,
      },
    },
  });

  function handleSessionExpiry(err: unknown) {
    // An expired session sends every page back to sign-in.
    if (isSessionExpired(err)) void client.invalidateQueries({ queryKey: queryKeys.auth });
  }

  return client;
}
