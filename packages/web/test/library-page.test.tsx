import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryPage } from "../src/pages/LibraryPage";
import { app } from "./fixtures";
import { renderWithApp, stubApi } from "./render";

afterEach(() => vi.unstubAllGlobals());

function setUp(url = "/") {
  const fetch = stubApi({
    "/apps": [app()],
    "/stats": {
      applications: 1,
      files: 1,
      totalSize: 1,
      homebrew: 0,
      problems: 0,
      keysConfigured: true,
      catalogRev: 1,
    },
    "/roots": [],
  });
  renderWithApp(<LibraryPage />, { url });
  return {
    /** The query strings of every /apps request so far. */
    appRequests: () =>
      fetch.mock.calls
        .map(([input]) => new URL(String(input), "http://localhost"))
        .filter((url) => url.pathname.endsWith("/apps"))
        .map((url) => url.search),
    sort: () => screen.getByRole<HTMLSelectElement>("combobox", { name: /sort/i }),
    search: () => screen.getByRole<HTMLInputElement>("searchbox"),
    location: () => screen.getByTestId("location").textContent,
  };
}

describe("LibraryPage search", () => {
  it("writes the search to the URL after a pause", async () => {
    const page = setUp();
    fireEvent.change(page.search(), { target: { value: "zelda" } });
    await waitFor(() => expect(page.location()).toBe("/?q=zelda"));
  });

  it("clears the box when navigation removes the search, instead of restoring it", async () => {
    const page = setUp("/?q=zelda");
    expect(page.search().value).toBe("zelda");

    fireEvent.click(screen.getByRole("link", { name: "Library" }));
    await waitFor(() => expect(page.search().value).toBe(""));
    // Give the old debounce time to fire, had it not been cancelled.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(page.location()).toBe("/");
  });
});

describe("LibraryPage layout", () => {
  afterEach(() => localStorage.clear());

  it("switches to cards and remembers the choice", async () => {
    setUp();
    await screen.findByText("Example");
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Grid" }));
    expect(screen.getByRole("button", { name: "Grid" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("list").className).toContain("grid-cols");
    expect(localStorage.getItem("nslib.libraryLayout")).toBe("grid");
  });

  it("opens in the layout chosen last time", async () => {
    localStorage.setItem("nslib.libraryLayout", "grid");
    setUp();
    await screen.findByText("Example");
    expect(screen.getByRole("button", { name: "Grid" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("LibraryPage sort", () => {
  afterEach(() => localStorage.clear());

  it("sorts by date added, in the URL and the request, and remembers the choice", async () => {
    const page = setUp();
    await screen.findByText("Example");
    expect(page.sort().value).toBe("name");
    // Name order is the server's default, so it sends no sort parameters.
    expect(page.appRequests()).toEqual([""]);
    expect(screen.queryByText(/^Added/)).toBeNull();

    fireEvent.change(page.sort(), { target: { value: "added-desc" } });
    await waitFor(() => expect(page.location()).toBe("/?sort=added-desc"));
    await waitFor(() => expect(page.appRequests()).toContain("?sort=added&order=desc"));
    expect(localStorage.getItem("nslib.librarySort")).toBe("added-desc");
    expect(await screen.findByText(/^Added/)).toBeTruthy();

    fireEvent.change(page.sort(), { target: { value: "name" } });
    await waitFor(() => expect(page.location()).toBe("/"));
    expect(localStorage.getItem("nslib.librarySort")).toBe("name");
  });

  it("opens in the order chosen last time, unless the URL names one", async () => {
    localStorage.setItem("nslib.librarySort", "added-asc");
    const page = setUp();
    await screen.findByText("Example");
    expect(page.sort().value).toBe("added-asc");
    expect(page.appRequests()).toEqual(["?sort=added&order=asc"]);
  });

  it("prefers the URL's order to the remembered one", async () => {
    localStorage.setItem("nslib.librarySort", "added-asc");
    const page = setUp("/?sort=added-desc");
    await screen.findByText("Example");
    expect(page.sort().value).toBe("added-desc");
    expect(page.appRequests()).toEqual(["?sort=added&order=desc"]);
  });

  it("ignores an unknown order in the URL", async () => {
    const page = setUp("/?sort=bogus");
    await screen.findByText("Example");
    expect(page.sort().value).toBe("name");
    expect(page.appRequests()).toEqual([""]);
  });
});
