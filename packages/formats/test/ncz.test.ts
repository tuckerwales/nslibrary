import { buildFixtureNca, buildNcz, buildPfs0, deterministicBytes } from "@nslib/fixtures";
import { describe, expect, it } from "vitest";
import {
  BufferReader,
  decompressNczToBuffer,
  FormatError,
  parseNczHeader,
  parsePfs0,
  SliceReader,
} from "../src/index";

// Odd sizes put section boundaries mid AES block, and the mix of plain and encrypted
// sections checks that only CTR sections are re-encrypted.
const nca = buildFixtureNca("ncz-test", [
  { size: 0x30003, encrypted: true },
  { size: 0x1ff1, encrypted: false },
  { size: 0x2400b, encrypted: true },
]);

async function expectFormatError(promise: Promise<unknown>, code: FormatError["code"]) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FormatError);
  expect((error as FormatError).code).toBe(code);
}

describe("NCZ solid", () => {
  const ncz = buildNcz(nca, { mode: "solid" });

  it("is smaller than the NCA", () => {
    expect(ncz.length).toBeLessThan(nca.encrypted.length);
  });

  it("parses the section table", async () => {
    const header = await parseNczHeader(new BufferReader(ncz));
    expect(header.block).toBeNull();
    expect(header.sections.map((s) => [s.offset, s.size, s.cryptoType])).toEqual(
      nca.sections.map((s) => [s.offset, s.size, s.cryptoType]),
    );
  });

  it("restores the original encrypted NCA", async () => {
    expect((await decompressNczToBuffer(new BufferReader(ncz))).equals(nca.encrypted)).toBe(true);
  });
});

describe("NCZ with many sections", () => {
  // BKTR patch NCAs split into thousands of sections; the parser once capped them at 64.
  const many = buildFixtureNca(
    "ncz-many",
    Array.from({ length: 300 }, (_, i) => ({ size: 0x101 + i, encrypted: i % 3 !== 1 })),
  );
  const ncz = buildNcz(many, { mode: "solid" });

  it("restores the original encrypted NCA", async () => {
    expect((await decompressNczToBuffer(new BufferReader(ncz))).equals(many.encrypted)).toBe(true);
  });
});

describe("NCZ block", () => {
  const ncz = buildNcz(nca, { mode: "block", blockSizeExponent: 14 });

  it("stores incompressible blocks raw and compressible ones compressed", async () => {
    const header = await parseNczHeader(new BufferReader(ncz));
    const block = header.block!;
    expect(block.blockSize).toBe(0x4000);
    expect(block.decompressedSize).toBe(nca.encrypted.length - 0x4000);
    expect(block.compressedBlockSizes).toContain(0x4000);
    expect(block.compressedBlockSizes.some((size) => size < 0x1000)).toBe(true);
  });

  it("restores the original encrypted NCA", async () => {
    expect((await decompressNczToBuffer(new BufferReader(ncz))).equals(nca.encrypted)).toBe(true);
  });

  it("restores an NCZ read from inside an NSZ", async () => {
    const nsz = buildPfs0([
      { name: "a.cnmt.nca", data: deterministicBytes("cnmt", 0x100) },
      { name: "b.ncz", data: ncz },
    ]);
    const reader = new BufferReader(nsz);
    const entry = (await parsePfs0(reader)).entries[1]!;
    const restored = await decompressNczToBuffer(new SliceReader(reader, entry.offset, entry.size));
    expect(restored.equals(nca.encrypted)).toBe(true);
  });

  it("rejects a block table that does not match the decompressed size", async () => {
    const corrupt = Buffer.from(ncz);
    const blockHeaderOffset = 0x4000 + 0x10 + nca.sections.length * 0x40;
    corrupt.writeUInt32LE(1, blockHeaderOffset + 0x0c);
    await expectFormatError(parseNczHeader(new BufferReader(corrupt)), "INVALID");
  });

  it("rejects truncated block data", async () => {
    await expectFormatError(
      parseNczHeader(new BufferReader(ncz.subarray(0, ncz.length - 1))),
      "TRUNCATED",
    );
  });

  it("detects a corrupted block size", async () => {
    const corrupt = Buffer.from(ncz);
    const sizeTableOffset = 0x4000 + 0x10 + nca.sections.length * 0x40 + 0x18;
    const firstSize = corrupt.readUInt32LE(sizeTableOffset);
    corrupt.writeUInt32LE(firstSize + 1, sizeTableOffset);
    await expect(decompressNczToBuffer(new BufferReader(corrupt))).rejects.toThrow();
  });
});

describe("NCZ header validation", () => {
  it("rejects files without NCZSECTN", async () => {
    await expectFormatError(parseNczHeader(new BufferReader(nca.encrypted)), "BAD_MAGIC");
  });

  it("rejects XTS sections", async () => {
    const ncz = buildNcz(nca, { mode: "solid" });
    ncz.writeBigUInt64LE(2n, 0x4000 + 0x10 + 0x10);
    await expectFormatError(parseNczHeader(new BufferReader(ncz)), "UNSUPPORTED");
  });
});
