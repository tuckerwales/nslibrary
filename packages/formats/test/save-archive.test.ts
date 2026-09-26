import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BufferReader,
  buildSaveArchive,
  FormatError,
  readSaveArchive,
  type SaveArchiveInput,
  saveArchivePathProblem,
  splitUstarPath,
} from "../src/index";

const goldenDir = join(import.meta.dirname, "..", "..", "shared", "golden", "saves");

interface GoldenSpec {
  entries: { path: string; hex?: string }[];
}

function goldenInputs(): SaveArchiveInput[] {
  const spec = JSON.parse(readFileSync(join(goldenDir, "archive.json"), "utf8")) as GoldenSpec;
  return spec.entries.map((entry) =>
    entry.hex === undefined
      ? { path: entry.path }
      : { path: entry.path, data: Buffer.from(entry.hex, "hex") },
  );
}

async function expectFormatError(promise: Promise<unknown>, code?: FormatError["code"]) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FormatError);
  if (code) expect((error as FormatError).code).toBe(code);
}

function header(archive: Buffer, index = 0): Buffer {
  return archive.subarray(index * 512, index * 512 + 512);
}

/** Rewrites a header's checksum after a test edits it, so only the edit is under test. */
function fixChecksum(block: Buffer): void {
  block.fill(0x20, 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(sum.toString(8).padStart(6, "0"), 148, 6, "latin1");
  block[154] = 0;
  block[155] = 0x20;
}

describe("save archive golden file", () => {
  it("is rebuilt byte for byte from archive.json", () => {
    const built = buildSaveArchive(goldenInputs());
    // UPDATE_GOLDEN=1 rewrites archive.tar after an intentional format change.
    if (process.env.UPDATE_GOLDEN) writeFileSync(join(goldenDir, "archive.tar"), built);
    const golden = readFileSync(join(goldenDir, "archive.tar"));
    expect(built.equals(golden)).toBe(true);
  });

  it("lists every entry in byte order with parents before children", async () => {
    const golden = readFileSync(join(goldenDir, "archive.tar"));
    const listing = await readSaveArchive(new BufferReader(golden));
    const paths = listing.entries.map((e) => e.path);
    expect(paths).toContain("deep");
    expect(paths).toContain("café");
    expect(paths).toContain("screenshots");
    expect(listing.fileCount).toBe(7);
    const expectedData = goldenInputs().reduce((sum, e) => sum + (e.data?.byteLength ?? 0), 0);
    expect(listing.dataSize).toBe(expectedData);
    for (const entry of listing.entries) {
      const input = goldenInputs().find((i) => i.path === entry.path);
      if (entry.type === "file") {
        expect(input?.data).toBeDefined();
        const bytes = golden.subarray(entry.offset, entry.offset + entry.size);
        expect(Buffer.compare(bytes, Buffer.from(input?.data ?? []))).toBe(0);
      }
    }
    // Directories keep their trailing slash when sorted, so "a-b" sorts before "a/".
    const tarPaths = listing.entries.map((e) => (e.type === "dir" ? `${e.path}/` : e.path));
    const sorted = [...tarPaths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    expect(tarPaths).toEqual(sorted);
  });

  it("is what archive.json says it hashes to", () => {
    const golden = readFileSync(join(goldenDir, "archive.tar"));
    const expected = readFileSync(join(goldenDir, "archive.sha256"), "utf8").trim();
    expect(createHash("sha256").update(golden).digest("hex")).toBe(expected);
  });
});

describe("buildSaveArchive", () => {
  it("produces an empty archive for an empty save", async () => {
    const archive = buildSaveArchive([]);
    expect(archive.length).toBe(1024);
    expect(await readSaveArchive(new BufferReader(archive))).toEqual({
      entries: [],
      fileCount: 0,
      dataSize: 0,
    });
  });

  it("does not depend on input order", () => {
    const inputs = goldenInputs();
    expect(buildSaveArchive([...inputs].reverse()).equals(buildSaveArchive(inputs))).toBe(true);
  });

  it("rejects unsafe paths", () => {
    for (const path of ["", "/abs", "a/../b", "./a", "a//b", "a\\b", "a/"]) {
      expect(() => buildSaveArchive([{ path, data: Buffer.alloc(1) }])).toThrow(FormatError);
    }
  });

  it("splits long paths at the last slash that fits", () => {
    const path = `${"p".repeat(150)}/${"n".repeat(90)}`;
    expect(splitUstarPath(path)).toEqual({ prefix: "p".repeat(150), name: "n".repeat(90) });
    expect(() => splitUstarPath(`${"p".repeat(160)}/${"n".repeat(90)}`)).toThrow(FormatError);
    expect(() => splitUstarPath(`p/${"n".repeat(120)}`)).toThrow(FormatError);
  });
});

describe("readSaveArchive", () => {
  const simple = () => buildSaveArchive([{ path: "a.bin", data: Buffer.from("hello") }]);

  it("accepts extra zero blocks that tar tools pad with", async () => {
    const padded = Buffer.concat([simple(), Buffer.alloc(512 * 17)]);
    expect((await readSaveArchive(new BufferReader(padded))).fileCount).toBe(1);
  });

  it("rejects data after the end of archive", async () => {
    const trailing = Buffer.concat([simple(), Buffer.alloc(512, 1)]);
    await expectFormatError(readSaveArchive(new BufferReader(trailing)), "INVALID");
  });

  it("rejects a truncated archive", async () => {
    const archive = simple();
    await expectFormatError(
      readSaveArchive(new BufferReader(archive.subarray(0, 512))),
      "TRUNCATED",
    );
    await expectFormatError(
      readSaveArchive(new BufferReader(archive.subarray(0, 1536))),
      "TRUNCATED",
    );
    await expectFormatError(readSaveArchive(new BufferReader(archive.subarray(0, 100))), "INVALID");
  });

  it("rejects a bad checksum", async () => {
    const archive = simple();
    header(archive)[0] = 0x62;
    await expectFormatError(readSaveArchive(new BufferReader(archive)), "INVALID");
  });

  it("rejects something that is not a tar", async () => {
    await expectFormatError(readSaveArchive(new BufferReader(Buffer.alloc(2048, 7))), "BAD_MAGIC");
  });

  it("rejects links and other entry types", async () => {
    const archive = simple();
    header(archive)[156] = 0x32;
    fixChecksum(header(archive));
    await expectFormatError(readSaveArchive(new BufferReader(archive)), "UNSUPPORTED");
  });

  it("rejects a path that climbs out of the save", async () => {
    const archive = buildSaveArchive([{ path: "aa/b.bin", data: Buffer.from("x") }]);
    // Entry 1 is aa/b.bin (entry 0 is aa/).
    header(archive, 1).write("../b.bin", 0, "latin1");
    fixChecksum(header(archive, 1));
    await expectFormatError(readSaveArchive(new BufferReader(archive)), "INVALID");
  });

  it("rejects duplicate entries and files used as directories", async () => {
    const one = buildSaveArchive([{ path: "a", data: Buffer.from("x") }]).subarray(0, 1024);
    const dup = Buffer.concat([one, one, Buffer.alloc(1024)]);
    await expectFormatError(readSaveArchive(new BufferReader(dup)), "INVALID");

    const child = buildSaveArchive([{ path: "b/c", data: Buffer.from("y") }]);
    // Replace the b/ directory entry with a file named b.
    const file = buildSaveArchive([{ path: "b", data: Buffer.alloc(0) }]).subarray(0, 512);
    const nested = Buffer.concat([file, child.subarray(512)]);
    await expectFormatError(readSaveArchive(new BufferReader(nested)), "INVALID");
  });

  it("reads archives made with `tar -cf save.tar .`", async () => {
    const archive = buildSaveArchive([{ path: "d/f.bin", data: Buffer.from("z") }]);
    // Rename d/ and d/f.bin to ./d/ and ./d/f.bin, and put a "./" entry in front.
    for (const [index, name] of [
      [0, "./d/"],
      [1, "./d/f.bin"],
    ] as const) {
      header(archive, index).fill(0, 0, 100);
      header(archive, index).write(name, 0, "latin1");
      fixChecksum(header(archive, index));
    }
    const root = Buffer.from(header(archive, 0));
    root.fill(0, 0, 100);
    root.write("./", 0, "latin1");
    fixChecksum(root);
    const listing = await readSaveArchive(new BufferReader(Buffer.concat([root, archive])));
    expect(listing.entries.map((e) => e.path)).toEqual(["d", "d/f.bin"]);
  });

  it("explains path problems", () => {
    expect(saveArchivePathProblem("ok/path.bin")).toBeNull();
    expect(saveArchivePathProblem("x".repeat(255))).toMatch(/longer/);
  });
});
