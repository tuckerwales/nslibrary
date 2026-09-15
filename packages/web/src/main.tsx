import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { ApiRequestError } from "./api";
import "./styles.css";

function handleError(err: unknown) {
  // An expired session sends every page back to sign-in.
  if (err instanceof ApiRequestError && err.status === 401) {
    void queryClient.invalidateQueries({ queryKey: ["auth"] });
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleError }),
  mutationCache: new MutationCache({ onError: handleError }),
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (failures, err) =>
        !(err instanceof ApiRequestError && err.status < 500) && failures < 2,
    },
  },
});

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
