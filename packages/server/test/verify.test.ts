import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildFixtureNca, buildNcz, buildPfs0 } from "@nslib/fixtures";
import { BufferReader, parsePfs0 } from "@nslib/formats";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client";
import { LibraryRepository } from "../src/library/repository";
import { verifyLibraryFile } from "../src/library/verify";
import { makeTempDir, removeDir } from "./helpers";

const TITLE = "0100ABCDEF012000";

describe("verifyLibraryFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  /** An NSZ holding one NCZ, recorded in the database as if its CNMT had been read. */
  async function nszWithRecord(options: { corrupt?: boolean } = {}) {
    const nca = buildFixtureNca("verify", [
      { size: 0x30003, encrypted: true },
      { size: 0x2400b, encrypted: true },
    ]);
    const ncaId = createHash("sha256").update(nca.encrypted).digest("hex").slice(0, 32);
    const nsz = buildPfs0([
      { name: `${ncaId}.ncz`, data: buildNcz(nca, { mode: "block", blockSizeExponent: 14 }) },
    ]);
    if (options.corrupt) nsz[nsz.length - 1] = (nsz[nsz.length - 1] ?? 0) ^ 0xff;

    const { db } = openDatabase(":memory:");
    const repo = new LibraryRepository(db);
    await writeFile(join(dir, "game.nsz"), nsz);
    const root = repo.createRoot({ path: dir });
    const { fileId } = repo.upsertSeenFile(root.id, "game.nsz", {
      size: nsz.length,
      mtimeMs: 1,
    });
    const reader = new BufferReader(nsz);
    repo.saveInspection(fileId, null, {
      status: "ok",
      iconKey: null,
      message: null,
      result: {
        entries: (await parsePfs0(reader)).entries,
        metas: [
          {
            titleId: TITLE,
            version: 0,
            type: "application",
            applicationId: TITLE,
            applicationIdSource: "exact",
            displayName: "Game",
            keyGeneration: null,
            rightsId: null,
            requiredSystemVersion: null,
            installSize: null,
            source: "cnmt",
            publisher: null,
            icon: null,
            records: [
              {
                ncaId,
                type: "program",
                size: nca.encrypted.length,
                sha256: createHash("sha256").update(nca.encrypted).digest("hex"),
                compressed: true,
              },
            ],
          },
        ],
        homebrew: null,
        application: null,
        metadataSource: "cnmt",
        warnings: [],
      },
    });
    const file = repo.getFile(fileId);
    if (!file) throw new Error("file row missing");
    return { repo, file, reader, size: nca.encrypted.length };
  }

  it("hashes NCZ content as it streams and reports progress", async () => {
    const { repo, file, reader, size } = await nszWithRecord();
    const progress: [number, number][] = [];
    const result = await verifyLibraryFile(repo, file, reader, "full", {
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(result.status).toBe("ok");
    expect(progress.at(-1)).toEqual([size, size]);
    expect(progress.length).toBeGreaterThan(2);
    expect(repo.getFile(file.id)?.verifyStatus).toBe("ok");
  });

  it("flags NCZ content whose hash doesn't match", async () => {
    const { repo, file, reader } = await nszWithRecord({ corrupt: true });
    const result = await verifyLibraryFile(repo, file, reader, "full");
    expect(result.status).toBe("bad");
    expect(result.items[0]?.message).toMatch(/does not match/);
  });

  it("stops when aborted", async () => {
    const { repo, file, reader } = await nszWithRecord();
    const abort = new AbortController();
    abort.abort();
    await expect(
      verifyLibraryFile(repo, file, reader, "full", { signal: abort.signal }),
    ).rejects.toThrow();
  });
});
