import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildNca,
  buildPfs0,
  buildTicket,
  buildTitleNsp,
  formatProdKeys,
  generateFakeKeyset,
  mixedBytes,
  NcaContentType,
  ncaId,
  rightsIdFor,
} from "@nslib/fixtures";
import {
  BufferReader,
  decompressNczToBuffer,
  decryptTitleKey,
  parsePfs0,
  parseTicket,
  SliceReader,
  zstdBlockCompressor,
} from "@nslib/formats";
import type {
  AppDetail,
  CompressCandidate,
  CompressFolderOption,
  CompressSettings,
  CompressStartResponse,
  CompressTask,
  LibraryRoot,
} from "@nslib/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/auth/auth-service";
import { CompressError, compressNsp } from "../src/library/compress";
import { nszNameFor } from "../src/library/compress-service";
import { ZstdWorkerPool } from "../src/library/zstd-pool";
import { createServer, type NslibServer } from "../src/server";
import { makeTempDir, removeDir, testConfig } from "./helpers";

const keys = generateFakeKeyset();
const BASE = "0100ABCDEF012000";
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** A title whose program NCA is big and compressible enough to be worth an NCZ. */
function bigTitle(titleId = BASE, name = "Squeeze") {
  return buildTitleNsp({
    titleId,
    keys,
    name,
    programData: mixedBytes(`${titleId}:program`, 0x60000, 0x8000),
  });
}

describe("compressNsp", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  function expectedFor(...ncas: Buffer[]) {
    return new Map(ncas.map((nca) => [ncaId(nca), sha256(nca)]));
  }

  it("compresses the program NCA, copies the rest, and restores exactly", async () => {
    const pkg = bigTitle();
    const outputPath = join(dir, "out.nsz");
    const phases = new Set<string>();
    const result = await compressNsp({
      reader: new BufferReader(pkg.nsp),
      keys,
      expected: expectedFor(pkg.program, pkg.control),
      outputPath,
      compressBlock: zstdBlockCompressor(3),
      parallelBlocks: 2,
      blockSizeExponent: 16,
      onProgress: (phase) => phases.add(phase),
    });
    expect([...phases]).toEqual(["compressing", "checking"]);

    const nsz = await readFile(outputPath);
    expect(result.outputSize).toBe(nsz.length);
    expect(nsz.length).toBeLessThan(pkg.nsp.length * 0.75);
    const program = result.items.find((item) => item.compressed);
    expect(program).toMatchObject({
      name: `${ncaId(pkg.program)}.nca`,
      outputName: `${ncaId(pkg.program)}.ncz`,
      sourceSize: pkg.program.length,
    });
    expect(result.items.filter((item) => item.compressed)).toHaveLength(1);

    const entries = (await parsePfs0(new BufferReader(nsz))).entries;
    const source = (await parsePfs0(new BufferReader(pkg.nsp))).entries;
    expect(entries.map((e) => e.name)).toEqual(result.items.map((item) => item.outputName));
    for (const [i, entry] of entries.entries()) {
      const original = pkg.nsp.subarray(source[i]!.offset, source[i]!.offset + source[i]!.size);
      const slice = new SliceReader(new BufferReader(nsz), entry.offset, entry.size);
      const restored =
        entry.kind === "ncz"
          ? await decompressNczToBuffer(slice)
          : nsz.subarray(entry.offset, entry.offset + entry.size);
      expect(restored.equals(original), entry.name).toBe(true);
    }
  });

  it("refuses an original whose NCA doesn't match its CNMT", async () => {
    const pkg = bigTitle();
    const expected = expectedFor(pkg.program);
    expected.set(ncaId(pkg.program), "0".repeat(64));
    await expect(
      compressNsp({
        reader: new BufferReader(pkg.nsp),
        keys,
        expected,
        outputPath: join(dir, "out.nsz"),
        compressBlock: zstdBlockCompressor(1),
        parallelBlocks: 1,
      }),
    ).rejects.toThrow(/original is damaged/);
  });

  it("catches an NSZ that doesn't restore to the original", async () => {
    const pkg = bigTitle();
    let blocks = 0;
    await expect(
      compressNsp({
        reader: new BufferReader(pkg.nsp),
        keys,
        expected: expectedFor(pkg.program),
        outputPath: join(dir, "out.nsz"),
        // A compressor that drops a byte of its second block, as a disk or zstd fault might.
        compressBlock: async (block) => {
          const compressed = await zstdBlockCompressor(1)(
            ++blocks === 2 ? Buffer.concat([block.subarray(1), Buffer.alloc(1)]) : block,
          );
          return compressed;
        },
        parallelBlocks: 1,
        blockSizeExponent: 14,
      }),
    ).rejects.toThrow(/doesn't match the original/);
  });

  it("uses the ticket's title key for rights-ID content", async () => {
    const rightsId = rightsIdFor(BASE, 0);
    const ticket = buildTicket({ rightsId, keyGeneration: 0 });
    const titleKey = decryptTitleKey(keys, parseTicket(ticket).titleKeyBlock, 0);
    const program = buildNca({
      seed: "rights",
      contentType: NcaContentType.Program,
      titleId: BASE,
      keys,
      rightsId,
      titleKey,
      fs: {
        type: "pfs0",
        data: buildPfs0([{ name: "main", data: mixedBytes("rights", 0x40000, 0x8000) }]),
      },
    });
    const nsp = buildPfs0([
      { name: `${ncaId(program)}.nca`, data: program },
      { name: `${rightsId.toLowerCase()}.tik`, data: ticket },
    ]);
    const result = await compressNsp({
      reader: new BufferReader(nsp),
      keys,
      expected: expectedFor(program),
      outputPath: join(dir, "rights.nsz"),
      compressBlock: zstdBlockCompressor(3),
      parallelBlocks: 2,
    });
    expect(result.items[0]?.compressed).toBe(true);
    expect(result.outputSize).toBeLessThan(nsp.length * 0.75);

    const personal = buildTicket({ rightsId, keyGeneration: 0, personalized: true });
    const personalNsp = buildPfs0([
      { name: `${ncaId(program)}.nca`, data: program },
      { name: `${rightsId.toLowerCase()}.tik`, data: personal },
    ]);
    await expect(
      compressNsp({
        reader: new BufferReader(personalNsp),
        keys,
        expected: expectedFor(program),
        outputPath: join(dir, "personal.nsz"),
        compressBlock: zstdBlockCompressor(3),
        parallelBlocks: 1,
      }),
    ).rejects.toThrow(/Nothing in this file can be compressed.*personalized/);
  });

  it("copies an NCZ that is already inside the NSP", async () => {
    const pkg = bigTitle();
    await compressNsp({
      reader: new BufferReader(pkg.nsp),
      keys,
      expected: expectedFor(pkg.program, pkg.control),
      outputPath: join(dir, "first.nsz"),
      compressBlock: zstdBlockCompressor(1),
      parallelBlocks: 1,
    });
    // An already compressed file named .nsp, plus one more program NCA to compress.
    const first = await readFile(join(dir, "first.nsz"));
    const extra = bigTitle("0100ABCDEF014000", "Extra").program;
    const nsp = buildPfs0([
      ...(await parsePfs0(new BufferReader(first))).entries.map((entry) => ({
        name: entry.name,
        data: first.subarray(entry.offset, entry.offset + entry.size),
      })),
      { name: `${ncaId(extra)}.nca`, data: extra },
    ]);
    const result = await compressNsp({
      reader: new BufferReader(nsp),
      keys,
      expected: expectedFor(pkg.program, pkg.control, extra),
      outputPath: join(dir, "second.nsz"),
      compressBlock: zstdBlockCompressor(1),
      parallelBlocks: 1,
    });
    expect(result.items.map((item) => item.compressed)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(result.items[2]?.name).toBe(`${ncaId(pkg.program)}.ncz`);
  });

  it("needs keys", async () => {
    await expect(
      compressNsp({
        reader: new BufferReader(bigTitle().nsp),
        keys: new Map(),
        expected: new Map(),
        outputPath: join(dir, "out.nsz"),
        compressBlock: zstdBlockCompressor(1),
        parallelBlocks: 1,
      }),
    ).rejects.toBeInstanceOf(CompressError);
  });
});

describe("ZstdWorkerPool", () => {
  it("compresses on worker threads and rejects once closed", async () => {
    const pool = new ZstdWorkerPool(2, 3);
    const blocks = Array.from({ length: 5 }, (_, i) => mixedBytes(`pool${i}`, 0x20000));
    const compressed = await Promise.all(blocks.map((block) => pool.compress(block)));
    const { zstdDecompressSync } = await import("node:zlib");
    compressed.forEach((out, i) => {
      expect(Buffer.isBuffer(out)).toBe(true);
      expect(zstdDecompressSync(out).equals(blocks[i]!)).toBe(true);
    });
    await pool.close();
    await expect(pool.compress(Buffer.alloc(16))).rejects.toThrow(/stopped/);
  });
});

describe("nszNameFor", () => {
  it("swaps the extension, including for split folders", () => {
    expect(nszNameFor("games/Game [0100ABCDEF012000][v0].nsp")).toBe(
      "Game [0100ABCDEF012000][v0].nsz",
    );
    expect(nszNameFor("Game.NSP")).toBe("Game.nsz");
    expect(nszNameFor("split/Game")).toBe("Game.nsz");
  });
});

describe("compression API", () => {
  let dir: string;
  let server: NslibServer;
  let session: string;

  beforeEach(async () => {
    dir = await makeTempDir();
    server = await createServer(testConfig(join(dir, "data"), { compressThreads: 2 }));
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { username: "admin", password: "correct horse" },
    });
    session = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? "";
  });

  afterEach(async () => {
    await server.close();
    await removeDir(dir);
  });

  function call(method: "GET" | "POST" | "PUT", url: string, body?: unknown) {
    return server.app.inject({
      method,
      url: `/api/v1${url}`,
      cookies: { [SESSION_COOKIE]: session },
      ...(body === undefined ? {} : { payload: body as object }),
    });
  }

  async function waitFor(fileId: number): Promise<CompressTask> {
    for (let attempt = 0; attempt < 500; attempt++) {
      const task = server.compress.get(fileId);
      if (task && task.state !== "queued" && task.state !== "running") return task;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`compression of file ${fileId} did not finish`);
  }

  /** A library with keys, one big NSP, and an output folder inside it. */
  async function library(options: { outputInside?: boolean } = {}) {
    await call("PUT", "/keys", { contents: formatProdKeys(keys) });
    const games = join(dir, "games");
    await mkdir(games, { recursive: true });
    const pkg = bigTitle();
    const nspPath = join(games, `Squeeze [${BASE}][v0].nsp`);
    await writeFile(nspPath, pkg.nsp);
    const output = options.outputInside === false ? join(dir, "elsewhere") : join(games, "nsz");
    await mkdir(output, { recursive: true });
    const root = (await call("POST", "/roots", { path: games })).json<LibraryRoot>();
    await server.scanner.scanRoot(root.id);
    const [file] = server.repo.listRootFiles(root.id);
    if (!file) throw new Error("NSP wasn't scanned");
    return { pkg, nspPath, output, root, file };
  }

  it("checks the output folder", async () => {
    expect((await call("GET", "/compress/settings")).json<CompressSettings>()).toMatchObject({
      outputDir: null,
      level: 18,
      removeOriginal: false,
      problem: expect.stringMatching(/prod\.keys/),
    });
    const relative = await call("PUT", "/compress/settings", { outputDir: "nsz" });
    expect(relative.statusCode).toBe(400);
    const missing = await call("PUT", "/compress/settings", { outputDir: join(dir, "nope") });
    expect(missing.json().error.msg).toMatch(/Folder not found/);
    const level = await call("PUT", "/compress/settings", { level: 30 });
    expect(level.statusCode).toBe(400);

    await call("PUT", "/keys", { contents: formatProdKeys(keys) });
    expect((await call("GET", "/compress/settings")).json<CompressSettings>().problem).toMatch(
      /save NSZ files/,
    );
    const saved = await call("PUT", "/compress/settings", { outputDir: dir, level: 3 });
    expect(saved.json<CompressSettings>()).toMatchObject({
      level: 3,
      problem: null,
      outputInLibrary: false,
    });
  });

  it("compresses an NSP into the library, checks it, and reports the saving", async () => {
    const { pkg, nspPath, output, file, root } = await library();
    const settings = (
      await call("PUT", "/compress/settings", { outputDir: output, level: 3 })
    ).json<CompressSettings>();
    expect(settings.outputInLibrary).toBe(true);

    const candidates = (await call("GET", "/compress/candidates")).json<CompressCandidate[]>();
    expect(candidates.map((c) => [c.file.id, c.name, c.type])).toEqual([
      [file.id, "Squeeze", "application"],
    ]);

    const events: CompressTask[] = [];
    const unsubscribe = server.events.subscribe((event) => {
      if (event.type === "compress.updated") events.push(event.task);
    });
    const started = await call("POST", `/files/${file.id}/compress`);
    expect(started.statusCode).toBe(202);
    const task = await waitFor(file.id);
    unsubscribe();
    expect(task.error).toBeNull();
    expect(task.state).toBe("done");
    expect(events.map((e) => e.phase)).toEqual(
      expect.arrayContaining(["compressing", "checking", "finishing"]),
    );

    const result = task.result!;
    const nszPath = join(output, `Squeeze [${BASE}][v0].nsz`);
    expect(result).toMatchObject({
      outputPath: nszPath,
      sourceSize: pkg.nsp.length,
      inLibrary: true,
      originalRemoved: false,
    });
    expect(result.outputSize).toBe((await stat(nszPath)).size);
    expect(result.savedBytes).toBe(pkg.nsp.length - result.outputSize);
    expect(result.savedBytes).toBeGreaterThan(pkg.nsp.length / 4);
    expect(await stat(nspPath)).toBeTruthy();
    // No partial file is left beside it.
    expect(await readdir(output)).toEqual([`Squeeze [${BASE}][v0].nsz`]);

    // The rescan picks it up (this joins it, or scans again if it already finished), installs
    // prefer it, and it verifies against the CNMT.
    await server.scanner.scanRoot(root.id);
    const detail = (await call("GET", `/apps/${BASE}`)).json<AppDetail>();
    const nszFile = detail.contents[0]?.files.find((f) => f.format === "nsz");
    expect(nszFile?.relPath).toBe(`nsz/Squeeze [${BASE}][v0].nsz`);
    expect(detail.contents[0]?.files).toHaveLength(2);
    server.verify.start(nszFile!.id, "full");
    for (let i = 0; i < 500 && server.verify.get(nszFile!.id)?.state !== "done"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(server.verify.get(nszFile!.id)?.result?.status).toBe("ok");
    expect((await call("GET", "/compress/candidates")).json<CompressCandidate[]>()).toEqual([]);

    // Compressing again would overwrite it, so it fails.
    await call("POST", `/files/${file.id}/compress`);
    const again = await waitFor(file.id);
    expect(again.state).toBe("failed");
    expect(again.error).toMatch(/already exists/);
  });

  it("removes the original when asked, once the NSZ checks out", async () => {
    const { nspPath, output, file } = await library({ outputInside: false });
    await call("PUT", "/compress/settings", { outputDir: output, level: 1, removeOriginal: true });
    const queued = (
      await call("POST", "/compress", { fileIds: [file.id, file.id, 999_999] })
    ).json<CompressStartResponse>();
    expect(queued.tasks.map((t) => t.fileId)).toEqual([file.id]);
    expect(queued.skipped).toEqual([
      { fileId: 999_999, reason: expect.stringMatching(/no longer/) },
    ]);
    const task = await waitFor(file.id);
    expect(task.state).toBe("done");
    expect(task.result).toMatchObject({ originalRemoved: true, inLibrary: false });
    await expect(stat(nspPath)).rejects.toThrow();
    expect(server.repo.getFile(file.id)).toBeUndefined();
    expect((await stat(task.result!.outputPath)).size).toBe(task.result!.outputSize);
  });

  it("refuses files it can't compress and cancels queued ones", async () => {
    const { output, file, root } = await library();
    expect((await call("POST", `/files/${file.id}/compress`)).json().error.msg).toMatch(
      /save NSZ files/,
    );
    await call("PUT", "/compress/settings", { outputDir: output, level: 1 });

    const second = join(dir, "games", "Other [0100ABCDEF014000][v0].nsp");
    await writeFile(second, bigTitle("0100ABCDEF014000", "Other").nsp);
    await server.scanner.scanRoot(root.id);
    const other = server.repo.listRootFiles(root.id).find((f) => f.relPath.startsWith("Other"));
    // One compression runs at a time, so the second waits.
    await server.compress.start(file.id);
    expect((await server.compress.start(other!.id)).state).toBe("queued");
    const cancelled = await call("POST", `/files/${other!.id}/compress/cancel`);
    expect(cancelled.json<CompressTask>().state).toBe("cancelled");
    expect((await waitFor(file.id)).state).toBe("done");
    expect(server.compress.get(other!.id)?.state).toBe("cancelled");

    await server.scanner.scanRoot(root.id);
    const nsz = server.repo.listRootFiles(root.id).find((f) => f.format === "nsz");
    const refused = await call("POST", `/files/${nsz!.id}/compress`);
    expect(refused.json().error.msg).toMatch(/Only NSP/);
  });

  it("suggests folders it can write to and creates the one chosen", async () => {
    const { root } = await library();
    const folders = (await call("GET", "/compress/folders")).json<CompressFolderOption[]>();
    expect(folders).toEqual([
      { path: join(root.path, "NSZ"), rootPath: root.path, exists: false, writable: true },
      { path: root.path, rootPath: root.path, exists: true, writable: true },
    ]);
    const saved = await call("PUT", "/compress/settings", {
      outputDir: join(root.path, "NSZ"),
      createOutputDir: true,
    });
    expect(saved.json<CompressSettings>()).toMatchObject({
      outputDir: join(root.path, "NSZ"),
      outputInLibrary: true,
      keysReady: true,
      problem: null,
    });
    expect((await stat(join(root.path, "NSZ"))).isDirectory()).toBe(true);
    // Only one level is created, so a typo doesn't make a tree of folders.
    const deep = await call("PUT", "/compress/settings", {
      outputDir: join(root.path, "a", "b"),
      createOutputDir: true,
    });
    expect(deep.json().error.msg).toMatch(/Folder not found/);
  });

  it("deletes the original on request after a successful compression, then clears the list", async () => {
    const { nspPath, output, file } = await library({ outputInside: false });
    await call("PUT", "/compress/settings", { outputDir: output, level: 1 });
    expect((await call("POST", `/files/${file.id}/compress/remove-original`)).statusCode).toBe(404);
    const started = (await call("POST", `/files/${file.id}/compress`)).json<CompressTask>();
    expect(started.name).toBe("Squeeze");
    const task = await waitFor(file.id);
    expect(task.phaseStartedAt).toBeNull();
    expect(task.result?.originalRemoved).toBe(false);

    const removed = await call("POST", `/files/${file.id}/compress/remove-original`);
    expect(removed.json<CompressTask>().result?.originalRemoved).toBe(true);
    await expect(stat(nspPath)).rejects.toThrow();
    // Deleted on purpose, so it's gone from the library rather than listed as missing.
    expect(server.repo.getFile(file.id)).toBeUndefined();

    expect((await call("POST", "/compress/clear")).json<CompressTask[]>()).toEqual([]);
    expect(server.compress.get(file.id)).toBeNull();
  });

  it("clears partial files left by a restart", async () => {
    const output = join(dir, "out");
    await mkdir(output);
    await call("PUT", "/keys", { contents: formatProdKeys(keys) });
    await call("PUT", "/compress/settings", { outputDir: output });
    await writeFile(join(output, ".Game.nsz.nslib-partial"), "half");
    await writeFile(join(output, "keep.nsz"), "whole");
    expect(await server.compress.removeLeftovers()).toBe(1);
    expect(await readdir(output)).toEqual(["keep.nsz"]);
  });
});
