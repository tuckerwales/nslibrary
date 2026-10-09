import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryPage } from "../src/pages/LibraryPage";
import { app, device } from "./fixtures";
import { renderWithApp, stubApi } from "./render";

afterEach(() => vi.unstubAllGlobals());

function setUp(url = "/", apps = [app()], devices = [device()]) {
  const fetch = stubApi({
    "/apps": apps,
    "/devices": devices,
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
    installedOn: () => screen.getByRole<HTMLSelectElement>("combobox", { name: /installed on/i }),
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

  it("shows what each order sorts by under the name", async () => {
    setUp("/?sort=released-desc", [
      app({ releaseDate: 20170303, requiredSystemVersion: 0x0c100000, publisher: "Acme" }),
    ]);
    expect(await screen.findByText(/^Released .*2017/)).toBeTruthy();
    cleanup();
    setUp("/?sort=firmware-desc", [app({ requiredSystemVersion: 0x0c100000 })]);
    expect(await screen.findByText("Needs firmware 3.1.0")).toBeTruthy();
    cleanup();
    setUp("/?sort=publisher", [app({ publisher: null })]);
    expect(await screen.findByText("Publisher unknown")).toBeTruthy();
    cleanup();
    setUp("/?sort=updated-desc", [app({ lastUpdateDate: 20190101 })]);
    expect(await screen.findByText(/^Updated .*2019/)).toBeTruthy();
    cleanup();
    setUp("/?sort=players-desc", [app({ players: 4 })]);
    expect(await screen.findByText("Up to 4 players")).toBeTruthy();
    cleanup();
    setUp("/?sort=rating-asc", [app({ rating: 12 })]);
    expect(await screen.findByText("Rated 12+")).toBeTruthy();
  });

  it("asks the server for the new orders", async () => {
    const page = setUp("/?sort=size-desc");
    await screen.findByText("Example");
    expect(page.appRequests()).toEqual(["?sort=size&order=desc"]);
  });

  it("ignores an unknown order in the URL", async () => {
    const page = setUp("/?sort=bogus");
    await screen.findByText("Example");
    expect(page.sort().value).toBe("name");
    expect(page.appRequests()).toEqual([""]);
  });
});

describe("LibraryPage Switch filter", () => {
  it("filters by what a Switch has installed, in the URL and the request", async () => {
    const page = setUp();
    await screen.findByText("Example");
    expect(page.installedOn().value).toBe("");

    fireEvent.change(page.installedOn(), { target: { value: "not-on:1" } });
    await waitFor(() => expect(page.location()).toBe("/?not-on=1"));
    await waitFor(() => expect(page.appRequests()).toContain("?device=1&installed=false"));

    fireEvent.change(page.installedOn(), { target: { value: "on:1" } });
    await waitFor(() => expect(page.location()).toBe("/?on=1"));
    await waitFor(() => expect(page.appRequests()).toContain("?device=1&installed=true"));

    fireEvent.click(await screen.findByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(page.location()).toBe("/"));
  });

  it("is hidden until a Switch is paired", async () => {
    setUp("/", [app()], []);
    await screen.findByText("Example");
    expect(screen.queryByRole("combobox", { name: /installed on/i })).toBeNull();
  });
});

describe("LibraryPage more filters", () => {
  const library = [
    app({
      applicationId: "0100000000010000",
      name: "Alpha",
      publisher: "Acme",
      languages: ["en", "ja"],
      regions: ["US"],
      rating: 12,
      players: 4,
      releaseDate: 20170303,
      lastUpdateDate: 20190101,
      requiredSystemVersion: 0x0c100000,
    }),
    app({ applicationId: "0100000000020000", name: "Beta", publisher: "acme", rating: 3 }),
  ];
  const panel = () => screen.getByRole("group", { name: "More filters" });
  const field = (name: string) =>
    within(panel()).getByRole<HTMLSelectElement>("combobox", { name });

  it("offers what the library holds, and puts the choice in the URL and the request", async () => {
    const page = setUp("/", library);
    await screen.findByText("Alpha");
    expect(screen.queryByRole("group", { name: "More filters" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));

    const options = (name: string) => [...field(name).options].map((option) => option.text);
    // Publishers that differ only in case are one choice.
    expect(options("Publisher")).toEqual(["Any", "Acme"]);
    expect(options("Language")).toEqual(["Any", "English", "Japanese"]);
    expect(options("Players")).toEqual(["Any", "2 or more", "3 or more", "4 or more"]);
    expect(options("Age rating")).toEqual(["Any", "3 or under", "12 or under"]);
    expect(options("Needs firmware")).toEqual(["Any", "3.1.0 or older"]);
    expect(options("Released from")).toEqual(["Any", "2017"]);

    fireEvent.change(field("Language"), { target: { value: "ja" } });
    await waitFor(() => expect(page.location()).toBe("/?language=ja"));
    await waitFor(() => expect(page.appRequests()).toContain("?language=ja"));

    fireEvent.change(field("Released from"), { target: { value: "2017" } });
    await waitFor(() => expect(page.location()).toBe("/?language=ja&releasedFrom=20170101"));

    fireEvent.change(field("Size"), { target: { value: `${1024 ** 3}-${4 * 1024 ** 3}` } });
    await waitFor(() =>
      expect(page.appRequests()).toContain(
        `?language=ja&minSize=${1024 ** 3}&maxSize=${4 * 1024 ** 3}&releasedFrom=20170101`,
      ),
    );
    expect(screen.getByRole("button", { name: /More filters/ }).textContent).toBe("More filters3");

    fireEvent.change(field("Size"), { target: { value: "" } });
    await waitFor(() => expect(page.location()).toBe("/?language=ja&releasedFrom=20170101"));

    fireEvent.click(await screen.findByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(page.location()).toBe("/"));
  });

  it("opens with the filters from the URL, leaving out ones the server would reject", async () => {
    const page = setUp("/?maxRating=7&minPlayers=lots&publisher=Gone", library);
    await screen.findByText("Alpha");
    expect(field("Age rating").value).toBe("7");
    // Not in the library any more, but still shown so it can be cleared.
    expect(field("Publisher").value).toBe("Gone");
    expect(field("Players").value).toBe("");
    expect(page.appRequests()).toContain("?publisher=Gone&maxRating=7");
  });
});

describe("LibraryPage filters", () => {
  it("counts each filter and hides the ones with nothing in them", async () => {
    setUp("/", [
      app({ applicationId: "0100000000010000", flags: ["duplicate"] }),
      app({ applicationId: "0100000000020000", name: "Other", flags: ["duplicate", "no-base"] }),
    ]);
    const duplicates = await screen.findByRole("button", { name: /^Duplicates/ });
    expect(duplicates.textContent).toBe("Duplicates2");
    expect(screen.getByRole("button", { name: /^All/ }).textContent).toBe("All2");
    expect(screen.queryByRole("button", { name: /Older updates/ })).toBeNull();
  });

  it("offers to clear a search that matches nothing", async () => {
    const page = setUp("/?q=zzz", []);
    fireEvent.click(await screen.findByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(page.location()).toBe("/"));
    expect(page.search().value).toBe("");
  });

  it("jumps to the search box on /", async () => {
    const page = setUp();
    await screen.findByText("Example");
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(page.search());
  });
});
