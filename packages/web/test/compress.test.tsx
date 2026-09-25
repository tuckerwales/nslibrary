import type {
  CompressCandidate,
  CompressFolderOption,
  CompressSettings,
  CompressTask,
  LibraryFileInfo,
} from "@nslib/shared";
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../src/api";
import {
  compressProgressText,
  estimatedSavingText,
  outputFileName,
  savedText,
  savingsSummary,
  stepLabel,
  timeLeftText,
} from "../src/compress";
import { applyServerEvent } from "../src/live";
import { CompressionPage } from "../src/pages/CompressionPage";
import { showToast } from "../src/toast";
import { renderWithApp, stubApi } from "./render";

vi.mock("../src/toast", () => ({ showToast: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(showToast).mockClear();
});

function task(fileId: number, patch: Partial<CompressTask> = {}): CompressTask {
  return {
    fileId,
    relPath: `Game ${fileId}.nsp`,
    name: `Game ${fileId}`,
    state: "running",
    phase: "compressing",
    phaseStartedAt: 0,
    bytesDone: 0,
    bytesTotal: 100,
    result: null,
    error: null,
    startedAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function file(id: number): LibraryFileInfo {
  return {
    id,
    rootId: 1,
    relPath: `Game ${id}.nsp`,
    format: "nsp",
    size: 4 * 1024 ** 3,
    parseStatus: "ok",
    parseError: null,
    metadataSource: "nacp",
    verifyStatus: "unverified",
    missingSince: null,
  };
}

const done = (fileId: number, savedBytes: number, originalRemoved = false) =>
  task(fileId, {
    state: "done",
    phase: null,
    phaseStartedAt: null,
    result: {
      outputPath: `/library/games/NSZ/Game ${fileId}.nsz`,
      sourceSize: 1000,
      outputSize: 1000 - savedBytes,
      savedBytes,
      items: [],
      inLibrary: true,
      originalRemoved,
      warnings: [],
    },
  });

describe("compression text", () => {
  it("describes each step", () => {
    expect(stepLabel(task(1, { state: "queued", phase: null }))).toBe("Waiting its turn");
    expect(stepLabel(task(1))).toBe("Step 1 of 2: compressing");
    expect(stepLabel(task(1, { phase: "checking" }))).toMatch(/^Step 2 of 2/);
    expect(compressProgressText(task(1, { bytesDone: 425, bytesTotal: 1000 }))).toBe(
      "Compressing 42%",
    );
    expect(compressProgressText(task(1, { phase: "finishing" }))).toBe("Finishing…");
  });

  it("estimates the time left from the step's speed", () => {
    const running = task(1, {
      phaseStartedAt: 0,
      bytesDone: 100 * 1024 ** 2,
      bytesTotal: 400 * 1024 ** 2,
    });
    // 100 MB in 10 s leaves 300 MB at 10 MB/s: 30 s.
    expect(timeLeftText(running, 10_000)).toBe("Less than a minute left in this step, 10.0 MB/s");
    expect(timeLeftText({ ...running, bytesTotal: 100 * 1024 ** 2 * 61 }, 10_000)).toBe(
      "About 10 min left in this step, 10.0 MB/s",
    );
    // Too early to tell.
    expect(timeLeftText(running, 1000)).toBeNull();
  });

  it("only calls it saved once the NSP is gone", () => {
    const result = { savedBytes: 380 * 1024 ** 2, sourceSize: 1024 ** 3 };
    expect(savedText({ ...result, originalRemoved: false })).toBe("380 MB (37%) smaller");
    expect(savedText({ ...result, originalRemoved: true })).toBe("Saved 380 MB (37%)");
    expect(savedText({ savedBytes: -10, sourceSize: 1000, originalRemoved: false })).toBe(
      "The NSZ isn't any smaller",
    );
    expect(estimatedSavingText(10 * 1024 ** 3)).toBe("about 3.0 GB to 6.0 GB");
    expect(outputFileName("D:\\nsz\\Game.nsz")).toBe("Game.nsz");
    expect(savingsSummary([done(1, 300, true), done(2, 200), task(3)])).toEqual({
      files: 2,
      freed: 300,
      pending: 200,
    });
  });
});

describe("compress.updated events", () => {
  it("keeps the latest task per file and announces ones seen running when they finish", () => {
    const client = new QueryClient();
    client.setQueryData<CompressTask[]>(queryKeys.compress, [task(1), task(2)]);
    client.setQueryData(queryKeys.compressCandidates, []);
    applyServerEvent(client, { type: "compress.updated", task: task(2, { bytesDone: 60 }) });
    expect(client.getQueryState(queryKeys.compressCandidates)?.isInvalidated).toBe(false);
    expect(showToast).not.toHaveBeenCalled();

    applyServerEvent(client, { type: "compress.updated", task: done(1, 10) });
    expect(
      client.getQueryData<CompressTask[]>(queryKeys.compress)?.map((t) => [t.fileId, t.state]),
    ).toEqual([
      [1, "done"],
      [2, "running"],
    ]);
    expect(client.getQueryState(queryKeys.compressCandidates)?.isInvalidated).toBe(true);
    expect(showToast).toHaveBeenCalledWith("Game 1 is compressed: 10 B (1%) smaller.", "success");

    // The same result again (say, after reconnecting) isn't news.
    applyServerEvent(client, { type: "compress.updated", task: done(1, 10) });
    applyServerEvent(client, {
      type: "compress.updated",
      task: task(2, { state: "failed", error: "The original is damaged." }),
    });
    expect(showToast).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenLastCalledWith(
      "Couldn't compress Game 2. The original is damaged.",
    );
  });
});

describe("CompressionPage", () => {
  const ready: CompressSettings = {
    outputDir: "/library/games/NSZ",
    keysReady: true,
    level: 18,
    removeOriginal: false,
    outputInLibrary: true,
    problem: null,
  };
  const folders: CompressFolderOption[] = [
    { path: "/library/games/NSZ", rootPath: "/library/games", exists: false, writable: true },
    { path: "/library/games", rootPath: "/library/games", exists: true, writable: true },
    { path: "/library/old/NSZ", rootPath: "/library/old", exists: false, writable: false },
  ];
  const candidates: CompressCandidate[] = [
    { file: file(1), name: "Harbor Watch", type: "application", version: 0 },
    { file: file(2), name: "Harbor Watch", type: "patch", version: 65536 },
  ];
  const calls = (fetch: ReturnType<typeof stubApi>, path: string) =>
    fetch.mock.calls.filter(
      ([input, init]) => String(input).endsWith(path) && init?.method === "POST",
    );

  it("walks through setup and creates the recommended folder", async () => {
    const fetch = stubApi({
      "/compress/settings": {
        ...ready,
        outputDir: null,
        problem: "Choose where to save NSZ files first.",
      },
      "/compress/folders": folders,
      "/compress/candidates": candidates,
      "/compress": [],
      "/roots": [],
    });
    renderWithApp(<CompressionPage />);
    expect(await screen.findByText("Get set up")).toBeTruthy();
    expect(screen.getByText("Your prod.keys are loaded.")).toBeTruthy();
    expect(await screen.findByText("Finish the setup above to start.")).toBeTruthy();
    expect(screen.getByText(/usually saves about 2\.4 GB to 4\.8 GB/)).toBeTruthy();
    const recommended = (await screen.findAllByRole("radio"))[0] as HTMLInputElement;
    expect(recommended.checked).toBe(true);
    expect(screen.getByText("It will be created.")).toBeTruthy();
    expect((screen.getAllByRole("radio")[2] as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Save NSZ files here" }));
    await waitFor(() => {
      const put = fetch.mock.calls.find(
        ([input, init]) => String(input).endsWith("/compress/settings") && init?.method === "PUT",
      );
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({
        outputDir: "/library/games/NSZ",
        createOutputDir: true,
      });
    });
  });

  it("points at Settings when the keys are missing", async () => {
    stubApi({
      "/compress/settings": {
        ...ready,
        keysReady: false,
        problem: "Compressing needs your prod.keys.",
      },
      "/compress/folders": folders,
      "/compress/candidates": [],
      "/compress": [],
      "/roots": [],
    });
    renderWithApp(<CompressionPage />);
    expect(await screen.findByRole("link", { name: "Add prod.keys in Settings" })).toBeTruthy();
  });

  it("shows progress, results, and queues what's left", async () => {
    const fetch = stubApi({
      "/compress/settings": ready,
      "/compress/candidates": candidates,
      "/compress": [done(3, 400), task(2, { bytesDone: 50, bytesTotal: 100 })],
      "/roots": [],
      "/files/3/compress/remove-original": done(3, 400, true),
    });
    renderWithApp(<CompressionPage />);
    expect(await screen.findByText("Ready to compress")).toBeTruthy();
    expect(screen.getByText("Step 1 of 2: compressing, 50%")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByText("400 B (40%) smaller")).toBeTruthy();
    expect(screen.getByText(/would save 400 B more/)).toBeTruthy();

    // File 2 is already compressing, so only file 1 is offered and queued.
    fireEvent.click(await screen.findByRole("button", { name: "Compress it" }));
    await waitFor(() => expect(calls(fetch, "/compress")).toHaveLength(1));
    expect(JSON.parse(String(calls(fetch, "/compress")[0]?.[1]?.body))).toEqual({ fileIds: [1] });

    fireEvent.click(screen.getByRole("button", { name: "Delete the NSP" }));
    expect(screen.getByText(/nothing is lost/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Delete the NSP" }).at(-1)!);
    await waitFor(() => expect(calls(fetch, "/files/3/compress/remove-original")).toHaveLength(1));
    expect(await screen.findByText("Saved 400 B (40%)")).toBeTruthy();
    expect(screen.getByText("The NSP was deleted.")).toBeTruthy();
  });
});
