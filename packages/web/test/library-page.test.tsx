import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryPage } from "../src/pages/LibraryPage";
import { app } from "./fixtures";
import { renderWithApp, stubApi } from "./render";

afterEach(() => vi.unstubAllGlobals());

function setUp(url = "/") {
  stubApi({
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
