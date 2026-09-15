import { createHash } from "node:crypto";
import {
  buildHfs0,
  buildPfs0,
  buildXci,
  deterministicBytes,
  type FixtureFile,
} from "@nslib/fixtures";
import { describe, expect, it } from "vitest";
import {
  BufferReader,
  FormatError,
  formatFromFileName,
  listContainerEntries,
  parseHfs0,
  parsePfs0,
  parseXci,
} from "../src/index";

const files: FixtureFile[] = [
  { name: "0123456789abcdef0123456789abcdef.cnmt.nca", data: deterministicBytes("cnmt", 0x321) },
  { name: "fedcba9876543210fedcba9876543210.nca", data: deterministicBytes("program", 0x2000) },
  { name: "00112233445566778899aabbccddeeff.ncz", data: deterministicBytes("ncz", 0x77) },
  { name: "0100000000010000000000000000000a.tik", data: deterministicBytes("tik", 0x2c0) },
  { name: "0100000000010000000000000000000a.cert", data: deterministicBytes("cert", 0x700) },
  { name: "empty.txt", data: new Uint8Array(0) },
];

async function expectFormatError(promise: Promise<unknown>, code: FormatError["code"]) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FormatError);
  expect((error as FormatError).code).toBe(code);
}

async function expectEntriesMatch(
  buffer: Buffer,
  entries: { name: string; offset: number; size: number }[],
) {
  expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
  for (const [i, entry] of entries.entries()) {
    expect(buffer.subarray(entry.offset, entry.offset + entry.size)).toEqual(
      Buffer.from(files[i]!.data),
    );
  }
}

describe("PFS0", () => {
  it("round-trips names, offsets, and data", async () => {
    const nsp = buildPfs0(files);
    const partition = await parsePfs0(new BufferReader(nsp));
    await expectEntriesMatch(nsp, partition.entries);
    expect(partition.entries.map((e) => e.kind)).toEqual([
      "cnmt",
      "nca",
      "ncz",
      "tik",
      "cert",
      "other",
    ]);
    expect(partition.headerSize % 0x20).toBe(0);
  });

  it("parses an empty partition", async () => {
    expect((await parsePfs0(new BufferReader(buildPfs0([])))).entries).toEqual([]);
  });

  it("rejects the wrong magic", async () => {
    await expectFormatError(parsePfs0(new BufferReader(buildHfs0(files))), "BAD_MAGIC");
  });

  it("rejects truncated files", async () => {
    const nsp = buildPfs0(files);
    await expectFormatError(
      parsePfs0(new BufferReader(nsp.subarray(0, nsp.length - 1))),
      "TRUNCATED",
    );
    await expectFormatError(parsePfs0(new BufferReader(nsp.subarray(0, 0x20))), "TRUNCATED");
    await expectFormatError(parsePfs0(new BufferReader(nsp.subarray(0, 8))), "TRUNCATED");
  });

  it("rejects a name offset outside the string table", async () => {
    const nsp = buildPfs0(files);
    nsp.writeUInt32LE(0xffff, 0x10 + 0x10);
    await expectFormatError(parsePfs0(new BufferReader(nsp)), "INVALID");
  });

  it("rejects absurd entry counts before reading them", async () => {
    const nsp = buildPfs0(files);
    nsp.writeUInt32LE(0xffffffff, 4);
    await expectFormatError(parsePfs0(new BufferReader(nsp)), "INVALID");
  });
});

describe("HFS0", () => {
  it("round-trips entries and records prefix hashes", async () => {
    const hfs0 = buildHfs0(files, { hashedSize: 0x100 });
    const partition = await parseHfs0(new BufferReader(hfs0));
    await expectEntriesMatch(hfs0, partition.entries);
    for (const [i, entry] of partition.entries.entries()) {
      const data = files[i]!.data;
      expect(entry.hashedSize).toBe(Math.min(0x100, data.length));
      expect(entry.sha256).toEqual(
        createHash("sha256").update(data.subarray(0, entry.hashedSize)).digest(),
      );
    }
  });
});

describe("XCI", () => {
  it.each([false, true])("finds the secure partition (key area prepended: %s)", async (keyArea) => {
    const xci = buildXci(files, {
      keyArea,
      emptyLogo: true,
      update: [{ name: "system-update.nca", data: deterministicBytes("update", 0x40) }],
    });
    const info = await parseXci(new BufferReader(xci));
    expect(info.cardOffset).toBe(keyArea ? 0x1000 : 0);
    expect([...info.partitions.keys()]).toEqual(["update", "normal", "secure"]);
    await expectEntriesMatch(xci, info.secure.entries);
  });

  it("lists only secure-partition entries as installable", async () => {
    const xci = buildXci(files, {
      update: [{ name: "system-update.nca", data: new Uint8Array(4) }],
    });
    const entries = await listContainerEntries(new BufferReader(xci), "xcz");
    expect(entries.map((e) => e.name)).not.toContain("system-update.nca");
    await expectEntriesMatch(xci, entries);
  });

  it("rejects images without a card header", async () => {
    await expectFormatError(parseXci(new BufferReader(buildPfs0(files))), "BAD_MAGIC");
  });

  it("rejects images without a secure partition", async () => {
    await expectFormatError(
      parseXci(new BufferReader(buildXci(files, { omitSecure: true }))),
      "INVALID",
    );
  });

  it("rejects a secure partition entry that overruns its parent", async () => {
    const xci = buildXci(files);
    await expectFormatError(
      parseXci(new BufferReader(xci.subarray(0, xci.length - 1))),
      "TRUNCATED",
    );
  });
});

describe("formatFromFileName", () => {
  it("maps known extensions case-insensitively", () => {
    expect(formatFromFileName("Game [0100000000010000][v0].NSZ")).toBe("nsz");
    expect(formatFromFileName("tool.nro")).toBe("nro");
    expect(formatFromFileName("notes.txt")).toBeNull();
    expect(formatFromFileName("README")).toBeNull();
  });
});
