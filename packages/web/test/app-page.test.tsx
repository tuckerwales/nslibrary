import type { AppContent, AppDetail, LibraryFileInfo } from "@nslib/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkSendBar, titleInstallItems } from "../src/components/BulkSend";
import { FileName } from "../src/components/FileName";
import { AppPage } from "../src/pages/AppPage";
import { app, device } from "./fixtures";
import { renderWithApp, stubApi } from "./render";

afterEach(() => vi.unstubAllGlobals());

function file(id: number, relPath: string): LibraryFileInfo {
  return {
    id,
    rootId: 1,
    relPath,
    format: "nsp",
    size: 100,
    parseStatus: "ok",
    parseError: null,
    metadataSource: "cnmt",
    verifyStatus: "unverified",
    missingSince: null,
  };
}

function content(
  contentMetaId: number,
  type: AppContent["type"],
  version: number | null,
  files: LibraryFileInfo[],
): AppContent {
  return {
    contentMetaId,
    titleId: "0100000000010000",
    type,
    version,
    name: type === "addon" ? `DLC ${contentMetaId}` : "Example",
    applicationIdSource: "exact",
    keyGeneration: null,
    requiredSystemVersion: null,
    installSize: null,
    files,
  };
}

function detail(): AppDetail {
  return {
    ...app({ flags: ["duplicate", "superseded-updates"] }),
    contents: [
      content(1, "application", 0, [file(1, "games/Example.nsp"), file(2, "backup/Example.nsp")]),
      content(2, "patch", 65536, [file(3, "updates/v1.nsp")]),
      content(3, "patch", 131072, [file(4, "updates/v2.nsp")]),
      content(4, "addon", 0, [file(5, "dlc/dlc.nsp")]),
    ],
  };
}

describe("titleInstallItems", () => {
  it("sends the base game, only the newest update, and every DLC", () => {
    expect(titleInstallItems(detail())).toEqual([1, 3, 4]);
  });
});

describe("FileName", () => {
  it("shows the folder relative to its library folder, with the full path on hover", () => {
    render(<FileName file={{ relPath: "updates/Game [v1].nsp" }} rootPath="/mnt/library/games" />);
    expect(screen.getByText("games/updates")).toBeTruthy();
    expect(screen.getByText("Game [v1].nsp").parentElement?.getAttribute("title")).toBe(
      "/mnt/library/games/updates/Game [v1].nsp",
    );
  });
});

describe("AppPage", () => {
  function renderAt(state: unknown) {
    stubApi({
      "/apps/0100000000010000": detail(),
      "/roots": [],
      "/devices": [],
      "/verify": [],
      "/compress": [],
      "/compress/settings": null,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[{ pathname: "/apps/0100000000010000", state }]}>
          <Routes>
            <Route path="/apps/:applicationId" element={<AppPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("marks duplicate copies and older updates", async () => {
    renderAt(null);
    expect(await screen.findAllByText("Duplicate")).toHaveLength(2);
    expect(screen.getAllByText("Older update")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Show" })).toHaveLength(2);
  });

  it("goes back to the list it was opened from, search and all", async () => {
    renderAt({ back: "/?flag=duplicate" });
    const link = await screen.findByRole("link", { name: /Back to library/ });
    expect(link.getAttribute("href")).toBe("/?flag=duplicate");
  });

  it("names the page it goes back to", async () => {
    renderAt({ back: "/switch?device=2" });
    expect(await screen.findByRole("link", { name: /Back to On this Switch/ })).toBeTruthy();
  });
});

describe("BulkSendBar", () => {
  it("queues each selected title's installs on the chosen Switch", async () => {
    const fetch = stubApi({
      "/devices": [device({ id: 7, name: "Lite" })],
      "/apps/0100000000010000": detail(),
      "/jobs": [{ id: 1 }, { id: 2 }, { id: 3 }],
    });
    const onDone = vi.fn();
    renderWithApp(
      <BulkSendBar selected={["0100000000010000"]} onClear={() => {}} onDone={onDone} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Send to Switch" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      deviceId: 7,
      items: [1, 3, 4],
      target: "auto",
    });
  });
});
