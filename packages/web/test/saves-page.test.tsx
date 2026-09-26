import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupSaves, SavesPage } from "../src/pages/SavesPage";
import { SettingsPage } from "../src/pages/SettingsPage";
import { saveBackup } from "./fixtures";
import { renderWithApp, stubApi } from "./render";

afterEach(() => vi.unstubAllGlobals());

const DAY = 24 * 60 * 60 * 1000;

const backups = [
  saveBackup({ id: 5, createdAt: Date.now() - 1 * DAY, note: "Before the boss", pinned: true }),
  saveBackup({
    id: 4,
    applicationId: "0100000000020000",
    name: "Harbor Watch",
    inLibrary: false,
    type: "device",
    userId: null,
    userName: null,
    createdAt: Date.now() - 2 * DAY,
  }),
  saveBackup({ id: 3, createdAt: Date.now() - 3 * DAY, origin: "pre-restore" }),
  saveBackup({
    id: 2,
    userId: "FFFFFFFFFFFFFFFF0000000000000001",
    userName: "Guest",
    deviceId: 2,
    deviceName: "Travel",
    createdAt: Date.now() - 4 * DAY,
  }),
];

const calls = (fetch: ReturnType<typeof stubApi>, method: string) =>
  fetch.mock.calls.filter(([, init]) => (init?.method ?? "GET") === method);

describe("groupSaves", () => {
  it("groups by game, then by user and console, keeping the newest first", () => {
    const games = groupSaves(backups);
    expect(games.map((g) => g.name)).toEqual(["Example", "Harbor Watch"]);
    expect(games[0]?.saves.map((s) => [s.label, s.backups.map((b) => b.id)])).toEqual([
      ["Player on Living room", [5, 3]],
      ["Guest on Travel", [2]],
    ]);
    expect(games[1]?.saves[0]?.label).toBe("Device save on Living room");
  });
});

describe("SavesPage", () => {
  it("explains how to make a backup when there are none", async () => {
    stubApi({ "/saves": [] });
    renderWithApp(<SavesPage />, { url: "/saves" });
    expect(await screen.findByText(/No backups yet/)).toBeTruthy();
  });

  it("lists backups with their details and download links", async () => {
    stubApi({ "/saves": backups });
    renderWithApp(<SavesPage />, { url: "/saves" });
    expect(await screen.findByRole("heading", { name: "Example" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Example" }).getAttribute("href")).toBe(
      "/apps/0100000000010000",
    );
    // Not in the library: no page to link to.
    expect(screen.getByRole("heading", { name: "Harbor Watch" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Harbor Watch" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Guest on Travel" })).toBeTruthy();
    expect(screen.getByText("Before the boss")).toBeTruthy();
    expect(screen.getByText("Pinned")).toBeTruthy();
    expect(screen.getByText("Before a restore")).toBeTruthy();
    expect(screen.getAllByText("3 files · 5.0 KB")).toHaveLength(4);
    const downloads = screen.getAllByRole("link", { name: /^Download the/ });
    expect(downloads.map((a) => a.getAttribute("href"))).toEqual([
      "/api/v1/saves/5/download",
      "/api/v1/saves/3/download",
      "/api/v1/saves/2/download",
      "/api/v1/saves/4/download",
    ]);
  });

  it("filters by search and by the game in the address", async () => {
    stubApi({ "/saves": backups });
    renderWithApp(<SavesPage />, { url: "/saves" });
    fireEvent.change(await screen.findByLabelText("Search saves"), {
      target: { value: "harbor" },
    });
    expect(screen.queryByRole("heading", { name: "Example" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Harbor Watch" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search saves"), { target: { value: "zelda" } });
    expect(screen.getByText("No saves match.")).toBeTruthy();
  });

  it("shows one game when linked from its page, and can show them all again", async () => {
    stubApi({ "/saves": backups });
    renderWithApp(<SavesPage />, { url: "/saves?app=0100000000020000" });
    expect(await screen.findByText(/Showing Harbor Watch/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Example" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show every game" }));
    expect(await screen.findByRole("heading", { name: "Example" })).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/saves");
  });

  it("pins and unpins a backup", async () => {
    const fetch = stubApi({
      "/saves": backups,
      "/saves/3": { ...backups[2], pinned: true },
      "/saves/5": { ...backups[0], pinned: false },
    });
    renderWithApp(<SavesPage />, { url: "/saves" });
    const pins = await screen.findAllByRole("button", { name: /^Pin the Example backup/ });
    fireEvent.click(pins[0] as HTMLElement);
    await waitFor(() => expect(calls(fetch, "PATCH")).toHaveLength(1));
    const [url, init] = calls(fetch, "PATCH")[0] ?? [];
    expect(String(url)).toBe("/api/v1/saves/3");
    expect(JSON.parse(String(init?.body))).toEqual({ pinned: true });

    // Backup 5 was pinned all along and is listed first.
    const unpins = await screen.findAllByRole("button", { name: /^Unpin the Example backup/ });
    expect(unpins).toHaveLength(2);
    fireEvent.click(unpins[0] as HTMLElement);
    await waitFor(() => expect(calls(fetch, "PATCH")).toHaveLength(2));
    expect(String(calls(fetch, "PATCH")[1]?.[0])).toBe("/api/v1/saves/5");
    expect(JSON.parse(String(calls(fetch, "PATCH")[1]?.[1]?.body))).toEqual({ pinned: false });
  });

  it("adds a note", async () => {
    const fetch = stubApi({ "/saves": backups, "/saves/3": { ...backups[2], note: "Chapter 4" } });
    renderWithApp(<SavesPage />, { url: "/saves" });
    const add = await screen.findAllByRole("button", { name: /^Add a note to the Example/ });
    fireEvent.click(add[0] as HTMLElement);
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "  Chapter 4 " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Chapter 4")).toBeTruthy();
    expect(JSON.parse(String(calls(fetch, "PATCH")[0]?.[1]?.body))).toEqual({ note: "Chapter 4" });
    expect(screen.queryByLabelText("Note")).toBeNull();
  });

  it("deletes a backup only after confirming", async () => {
    const fetch = stubApi({ "/saves": backups, "/saves/2": null });
    renderWithApp(<SavesPage />, { url: "/saves" });
    const first = await screen.findAllByRole("button", { name: /^Delete the Example backup/ });
    fireEvent.click(first[0] as HTMLElement);
    const dialog = screen.getByRole("alertdialog", { name: "Delete this backup?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls(fetch, "DELETE")).toHaveLength(0);

    const deletes = screen.getAllByRole("button", { name: /^Delete the Example backup/ });
    fireEvent.click(deletes[2] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete backup" }));
    await waitFor(() => expect(calls(fetch, "DELETE")).toHaveLength(1));
    expect(String(calls(fetch, "DELETE")[0]?.[0])).toBe("/api/v1/saves/2");
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Guest on Travel" })).toBeNull(),
    );
  });
});

describe("SettingsPage save backups", () => {
  const settings = {
    preferNsz: true,
    serverName: "NSLibrary",
    requireUsbPairing: false,
    saveBackupsKeep: 10,
  };

  it("changes how many backups each save keeps", async () => {
    const fetch = stubApi({ "/settings": settings });
    renderWithApp(<SettingsPage />);
    const input = await screen.findByLabelText<HTMLInputElement>("Backups to keep per save");
    expect(input.value).toBe("10");
    const section = input.closest("section") as HTMLElement;
    const save = within(section).getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(true);

    fireEvent.change(input, { target: { value: "2.5" } });
    expect(within(section).getByText("Enter a whole number from 0 to 1000.")).toBeTruthy();
    expect(save.hasAttribute("disabled")).toBe(true);

    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(save);
    await waitFor(() => expect(calls(fetch, "PUT")).toHaveLength(1));
    expect(JSON.parse(String(calls(fetch, "PUT")[0]?.[1]?.body))).toEqual({ saveBackupsKeep: 0 });
  });
});
