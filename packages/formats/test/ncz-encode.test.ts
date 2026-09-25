import {
  buildBktrNca,
  buildFixtureNca,
  buildNca,
  buildPfs0,
  generateFakeKeyset,
  mixedBytes,
  NcaContentType,
} from "@nslib/fixtures";
import { describe, expect, it } from "vitest";
import {
  BufferReader,
  buildPfs0Header,
  decompressNczToBuffer,
  encodeNcz,
  FormatError,
  MissingKeyError,
  NczCryptoType,
  type NczEncodeOptions,
  type NczSection,
  parseNczHeader,
  parsePfs0,
  planNczSections,
  zstdBlockCompressor,
} from "../src/index";

const keys = generateFakeKeyset();
const TITLE = "0100ABCDEF012000";

/** Encodes into memory and patches the block table, as a file writer would. */
async function encode(
  nca: Buffer,
  sections: NczSection[],
  options: Partial<NczEncodeOptions> = {},
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const result = await encodeNcz(
    new BufferReader(nca),
    sections,
    async (chunk) => {
      chunks.push(Buffer.from(chunk));
    },
    { compressBlock: zstdBlockCompressor(3), blockSizeExponent: 14, ...options },
  );
  const ncz = Buffer.concat(chunks);
  expect(ncz.length).toBe(result.size);
  result.blockTable.data.copy(ncz, result.blockTable.offset);
  return ncz;
}

function programNca(size: number, options: { rightsId?: string; titleKey?: Buffer } = {}) {
  return buildNca({
    seed: `encode:${size}`,
    contentType: NcaContentType.Program,
    titleId: TITLE,
    keys,
    fs: {
      type: "pfs0",
      data: buildPfs0([{ name: "main", data: mixedBytes(`encode:${size}`, size, 0x8000) }]),
    },
    ...options,
  });
}

describe("encodeNcz", () => {
  it("round-trips a fixture NCA through the decoder", async () => {
    const nca = buildFixtureNca("encode", [
      { size: 0x30003, encrypted: true },
      { size: 0x1ff1, encrypted: false },
      { size: 0x2400b, encrypted: true },
    ]);
    const sections = nca.sections.map((s) => ({ ...s }));
    const ncz = await encode(nca.encrypted, sections, { parallelBlocks: 3 });
    const header = await parseNczHeader(new BufferReader(ncz));
    expect(header.block?.blockSize).toBe(0x4000);
    expect(header.sections.map((s) => [s.offset, s.size, s.cryptoType])).toEqual(
      nca.sections.map((s) => [s.offset, s.size, s.cryptoType]),
    );
    expect((await decompressNczToBuffer(new BufferReader(ncz))).equals(nca.encrypted)).toBe(true);
    // Only possible if zstd saw the plaintext.
    expect(ncz.length).toBeLessThan(nca.encrypted.length * 0.75);
  });

  it("stores blocks raw when zstd doesn't help", async () => {
    const nca = buildFixtureNca("encode-raw", [{ size: 0x9000, encrypted: true }]);
    const ncz = await encode(nca.encrypted, nca.sections, {
      compressBlock: async (block) => Buffer.concat([block, Buffer.alloc(1)]),
    });
    const header = await parseNczHeader(new BufferReader(ncz));
    expect(header.block?.compressedBlockSizes).toEqual([0x4000, 0x4000, 0x1000]);
    expect((await decompressNczToBuffer(new BufferReader(ncz))).equals(nca.encrypted)).toBe(true);
  });

  it("hands the original bytes to onSource in order", async () => {
    const nca = buildFixtureNca("encode-source", [{ size: 0x12345, encrypted: true }]);
    const seen: Buffer[] = [];
    await encode(nca.encrypted, nca.sections, {
      onSource: (chunk) => seen.push(Buffer.from(chunk)),
    });
    expect(Buffer.concat(seen).equals(nca.encrypted)).toBe(true);
  });

  it("stops when aborted", async () => {
    const nca = buildFixtureNca("encode-abort", [{ size: 0x20000, encrypted: true }]);
    const abort = new AbortController();
    abort.abort();
    await expect(encode(nca.encrypted, nca.sections, { signal: abort.signal })).rejects.toThrow();
  });

  it("reports a failed block", async () => {
    const nca = buildFixtureNca("encode-fail", [{ size: 0x20000, encrypted: true }]);
    await expect(
      encode(nca.encrypted, nca.sections, {
        parallelBlocks: 4,
        compressBlock: async () => {
          throw new Error("zstd broke");
        },
      }),
    ).rejects.toThrow("zstd broke");
  });
});

describe("planNczSections", () => {
  it("plans CTR sections from a real NCA header", async () => {
    const nca = programNca(0x40000);
    const plan = await planNczSections(new BufferReader(nca), keys);
    expect(plan.nca.contentType).toBe(NcaContentType.Program);
    expect(plan.sections).toHaveLength(1);
    expect(plan.sections[0]).toMatchObject({ offset: 0xc00, cryptoType: NczCryptoType.Ctr });
    expect(plan.sections[0]?.size).toBe(nca.length - 0xc00);

    const ncz = await encode(nca, plan.sections, { blockSizeExponent: 16 });
    expect((await decompressNczToBuffer(new BufferReader(ncz))).equals(nca)).toBe(true);
    expect(ncz.length).toBeLessThan(nca.length * 0.75);
  });

  it("covers bytes after the last section, which the Switch uses to size the NCA", async () => {
    const nca = Buffer.concat([programNca(0x8000), Buffer.alloc(0x300, 0xaa)]);
    const plan = await planNczSections(new BufferReader(nca), keys);
    expect(plan.sections.at(-1)).toMatchObject({
      offset: nca.length - 0x300,
      size: 0x300,
      cryptoType: NczCryptoType.None,
    });
    const ncz = await encode(nca, plan.sections);
    expect((await decompressNczToBuffer(new BufferReader(ncz))).equals(nca)).toBe(true);
  });

  it("needs the title key for rights-ID content", async () => {
    const titleKey = Buffer.alloc(16, 7);
    const nca = programNca(0x8000, { rightsId: `${TITLE}000000000000000000`, titleKey });
    await expect(planNczSections(new BufferReader(nca), keys)).rejects.toBeInstanceOf(
      MissingKeyError,
    );
    const plan = await planNczSections(new BufferReader(nca), keys, titleKey);
    expect(plan.sections[0]?.cryptoKey.equals(titleKey)).toBe(true);
  });

  it("refuses an NCA too small to have a body", async () => {
    await expect(
      planNczSections(new BufferReader(Buffer.alloc(0x4000)), keys),
    ).rejects.toBeInstanceOf(FormatError);
  });

  it("splits a BKTR section into subsections with their generations", async () => {
    const data = mixedBytes("bktr", 0x28000, 0x4000);
    const subsections = [
      { size: 0x8000, generation: 0 },
      { size: 0x10010, generation: 3 },
      { size: 0xfff0, generation: 7 },
    ];
    const { nca, dataOffset } = buildBktrNca({ titleId: TITLE, keys, data, subsections });
    const plan = await planNczSections(new BufferReader(nca), keys);
    expect(plan.bktrFallbacks).toBe(0);
    expect(plan.sections.map((s) => [s.offset - dataOffset, s.size, s.cryptoType])).toEqual([
      [0, 0x8000, NczCryptoType.Bktr],
      [0x8000, 0x10010, NczCryptoType.Bktr],
      [0x18010, 0xfff0, NczCryptoType.Bktr],
      [0x28000, 0xc000, NczCryptoType.Ctr],
    ]);
    expect(plan.sections[1]?.cryptoCounter.readUInt32BE(4)).toBe(3);
    expect(plan.sections[1]?.cryptoCounter.readUInt32BE(0)).toBe(0x5ec0e);

    const ncz = await encode(nca, plan.sections);
    expect((await decompressNczToBuffer(new BufferReader(ncz))).equals(nca)).toBe(true);
    expect(ncz.length).toBeLessThan(nca.length * 0.75);
  });

  it("falls back to the base counter when the BKTR table is unreadable", async () => {
    const data = mixedBytes("bktr-bad", 0x10000, 0x4000);
    const { nca } = buildBktrNca({
      titleId: TITLE,
      keys,
      data,
      subsections: [
        { size: 0x8000, generation: 1 },
        { size: 0x8000, generation: 2 },
      ],
      corruptTable: true,
    });
    const plan = await planNczSections(new BufferReader(nca), keys);
    expect(plan.bktrFallbacks).toBe(1);
    expect(plan.sections).toHaveLength(1);
    // Still exact: the decoder re-applies the same counter.
    const ncz = await encode(nca, plan.sections);
    expect((await decompressNczToBuffer(new BufferReader(ncz))).equals(nca)).toBe(true);
  });
});

describe("buildPfs0Header", () => {
  it("builds a header parsePfs0 reads back", async () => {
    const files = [
      { name: "a.ncz", data: Buffer.alloc(0x123, 1) },
      { name: "longer-name.tik", data: Buffer.alloc(0x40, 2) },
    ];
    const header = buildPfs0Header(files.map((f) => ({ name: f.name, size: f.data.length })));
    expect(header.length % 0x20).toBe(0);
    const pfs0 = Buffer.concat([header, ...files.map((f) => f.data)]);
    const parsed = await parsePfs0(new BufferReader(pfs0));
    expect(parsed.entries.map((e) => [e.name, e.offset, e.size])).toEqual([
      ["a.ncz", header.length, 0x123],
      ["longer-name.tik", header.length + 0x123, 0x40],
    ]);
    // Same length with any sizes, so a writer can reserve it up front.
    expect(buildPfs0Header(files.map((f) => ({ name: f.name, size: 0 }))).length).toBe(
      header.length,
    );
  });
});
