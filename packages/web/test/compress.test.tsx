import type {
  CompressCandidate,
  CompressSettings,
  CompressTask,
  LibraryFileInfo,
} from "@nslib/shared";
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../src/api";
import { compressProgressText, outputFileName, savedText, totalSaved } from "../src/compress";
import { applyServerEvent } from "../src/live";
import { CompressionPage } from "../src/pages/CompressionPage";
import { renderWithApp, stubApi } from "./render";

afterEach(() => vi.unstubAllGlobals());

function task(fileId: number, patch: Partial<CompressTask> = {}): CompressTask {
  return {
    fileId,
    relPath: `Game ${fileId}.nsp`,
    state: "running",
    phase: "compressing",
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

const done = (fileId: number, savedBytes: number) =>
  task(fileId, {
    state: "done",
    phase: null,
    result: {
      outputPath: `/library/nsz/Game ${fileId}.nsz`,
      sourceSize: 1000,
      outputSize: 1000 - savedBytes,
      savedBytes,
      items: [],
      inLibrary: true,
      originalRemoved: false,
      warnings: [],
    },
  });

describe("compression text", () => {
  it("describes each phase", () => {
    expect(compressProgressText(task(1, { state: "queued", phase: null }))).toBe(
      "Waiting to compress…",
    );
    expect(compressProgressText(task(1, { bytesDone: 425, bytesTotal: 1000 }))).toBe(
      "Compressing 42%",
    );
    expect(compressProgressText(task(1, { phase: "checking", bytesDone: 1, bytesTotal: 1 }))).toBe(
      "Checking 100%",
    );
    expect(compressProgressText(task(1, { phase: "finishing" }))).toBe("Finishing…");
  });

  it("reports the saving", () => {
    expect(savedText({ savedBytes: 380 * 1024 ** 2, sourceSize: 1024 ** 3 })).toBe(
      "Saved 380 MB (37%)",
    );
    expect(savedText({ savedBytes: -10, sourceSize: 1000 })).toBe("No space saved");
    expect(outputFileName("/library/nsz/Game.nsz")).toBe("Game.nsz");
    expect(outputFileName("D:\\nsz\\Game.nsz")).toBe("Game.nsz");
    expect(totalSaved([done(1, 300), done(2, -5), task(3)])).toEqual({ files: 2, bytes: 300 });
  });
});

describe("compress.updated events", () => {
  it("keeps the latest task per file and refreshes candidates when one finishes", () => {
    const client = new QueryClient();
    applyServerEvent(client, { type: "compress.updated", task: task(1) });
    expect(client.getQueryData(queryKeys.compress)).toBeUndefined();

    client.setQueryData<CompressTask[]>(queryKeys.compress, [task(1), task(2)]);
    client.setQueryData(queryKeys.compressCandidates, []);
    applyServerEvent(client, { type: "compress.updated", task: task(2, { bytesDone: 60 }) });
    expect(client.getQueryState(queryKeys.compressCandidates)?.isInvalidated).toBe(false);
    applyServerEvent(client, { type: "compress.updated", task: done(1, 10) });
    expect(
      client.getQueryData<CompressTask[]>(queryKeys.compress)?.map((t) => [t.fileId, t.state]),
    ).toEqual([
      [1, "done"],
      [2, "running"],
    ]);
    expect(client.getQueryState(queryKeys.compressCandidates)?.isInvalidated).toBe(true);
  });
});

describe("CompressionPage", () => {
  const settings: CompressSettings = {
    outputDir: "/library/nsz",
    level: 18,
    removeOriginal: false,
    outputInLibrary: true,
    problem: null,
  };
  const candidates: CompressCandidate[] = [
    { file: file(1), name: "Harbor Watch", type: "application", version: 0 },
    { file: file(2), name: "Harbor Watch", type: "patch", version: 65536 },
  ];

  it("shows savings and queues every waiting NSP", async () => {
    const fetch = stubApi({
      "/compress/settings": settings,
      "/compress/candidates": candidates,
      "/compress": [done(3, 1024 ** 3), task(2)],
      "/roots": [],
    });
    renderWithApp(<CompressionPage />);
    expect(
      await screen.findByText("Saved 1.0 GB across 1 file since the server started."),
    ).toBeTruthy();
    expect(screen.getByText("Harbor Watch, Update 1")).toBeTruthy();
    // File 2 is already compressing, so only file 1 is queued.
    fireEvent.click(screen.getByRole("button", { name: "Compress all (1)" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith("/compress") &&
            init?.method === "POST" &&
            JSON.parse(String(init.body)).fileIds.join() === "1",
        ),
      ).toBe(true),
    );
  });

  it("says why compressing can't start", async () => {
    stubApi({
      "/compress/settings": {
        ...settings,
        outputDir: null,
        problem: "Choose an output folder first.",
      },
      "/compress/candidates": [],
      "/compress": [],
      "/roots": [],
    });
    renderWithApp(<CompressionPage />);
    expect(await screen.findByText("Choose an output folder first.")).toBeTruthy();
    expect(await screen.findByText("Everything that can be compressed has been.")).toBeTruthy();
  });
});
