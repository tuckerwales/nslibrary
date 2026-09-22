import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { Link, MemoryRouter, useLocation } from "react-router";
import { vi } from "vitest";

/** Answers API requests from a map of path (without /api/v1) to JSON body. */
export function stubApi(routes: Record<string, unknown>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (!(path in routes)) {
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND", msg: "Not found" } }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(routes[path]), {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function LocationDisplay() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

export function renderWithApp(
  ui: ReactNode,
  { url = "/", client = new QueryClient({ defaultOptions: { queries: { retry: false } } }) } = {},
) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <nav>
          <Link to="/">Library</Link>
        </nav>
        {ui}
        <LocationDisplay />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
