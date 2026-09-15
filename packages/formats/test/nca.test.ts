import {
  buildControlNca,
  buildNca,
  buildPfs0,
  buildRomfs,
  buildTitleNsp,
  CnmtContentType,
  CnmtType,
  formatProdKeys,
  generateFakeKeyset,
  ncaId,
} from "@nslib/fixtures";
import { describe, expect, it } from "vitest";
import {
  BufferReader,
  decryptNcaHeader,
  FormatError,
  headerKey,
  MissingKeyError,
  ncaIdOf,
  nintendoXtsCrypt,
  parseDecryptedNcaHeader,
  parseKeyset,
  parseNcaHeader,
  parseRomfs,
  readCnmtFromMetaNca,
  readControlNca,
  sha256Hex,
} from "../src/index";

const keys = generateFakeKeyset();
const BASE = "0100ABCDEF012000";

async function expectFormatError(promise: Promise<unknown>, code: FormatError["code"]) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FormatError);
  expect((error as FormatError).code).toBe(code);
}

describe("nintendoXtsCrypt", () => {
  it("round-trips a header-sized block", () => {
    const headerKey = keys.get("header_key")!;
    const plain = Buffer.alloc(0xc00, 0x5a);
    plain.write("NCA3", 0x200, "latin1");
    const enc = nintendoXtsCrypt(headerKey, plain, true);
    expect(enc.equals(plain)).toBe(false);
    expect(nintendoXtsCrypt(headerKey, enc, false).equals(plain)).toBe(true);
  });

  it("is not the identity at sector 0 (tweak of zeros still goes through AES)", () => {
    const headerKey = keys.get("header_key")!;
    const sector = Buffer.alloc(0x200, 1);
    expect(nintendoXtsCrypt(headerKey, sector, true).equals(sector)).toBe(false);
  });
});

describe("NCA3 meta", () => {
  const pkg = buildTitleNsp({
    titleId: BASE,
    version: 0,
    keys,
    name: "Example Game",
    publisher: "Fixture Co",
    requiredSystemVersion: 0x0c0000,
  });

  it("decrypts the header and reports title ID and content type", async () => {
    const info = await parseNcaHeader(new BufferReader(pkg.meta), keys);
    expect(info.magic).toBe("NCA3");
    expect(info.titleId).toBe(BASE);
    expect(info.contentType).toBe(1);
    expect(info.rightsId).toBeNull();
    expect(info.sections).toHaveLength(1);
    expect(info.sections[0]?.encryptionType).toBe(3);
  });

  it("reads the CNMT with version, firmware, and content hashes", async () => {
    const cnmt = await readCnmtFromMetaNca(new BufferReader(pkg.meta), keys);
    expect(cnmt).toMatchObject({
      titleId: BASE,
      version: 0,
      kind: "application",
      applicationId: BASE,
      requiredSystemVersion: 0x0c0000,
    });
    expect(cnmt.contents.map((c) => [c.type, c.ncaId, c.size])).toEqual([
      [CnmtContentType.Program, ncaId(pkg.program), pkg.program.length],
      [CnmtContentType.Control, ncaId(pkg.control), pkg.control.length],
    ]);
    expect(cnmt.contents[0]?.sha256).toBe(sha256Hex(pkg.program));
    expect(ncaIdOf(pkg.program)).toBe(ncaId(pkg.program));
  });

  it("filename of the meta NCA matches its hash", () => {
    expect(ncaIdOf(pkg.meta)).toBe(ncaId(pkg.meta));
  });
});

describe("NCA3 control", () => {
  it("reads NACP name, publisher, and icon from RomFS", async () => {
    const icon = Buffer.alloc(0x80, 0x7f);
    icon.set([0xff, 0xd8, 0xff, 0xd9], 0);
    const nca = buildControlNca({
      titleId: BASE,
      keys,
      name: "Example Game",
      publisher: "Fixture Co",
      displayVersion: "1.2.3",
      icon,
    });
    const control = await readControlNca(new BufferReader(nca), keys);
    expect(control.nacp).toMatchObject({
      name: "Example Game",
      publisher: "Fixture Co",
      displayVersion: "1.2.3",
    });
    expect(control.icon?.equals(icon)).toBe(true);
  });
});

describe("NCA3 patch and DLC", () => {
  it("reads the application ID from a patch CNMT", async () => {
    const pkg = buildTitleNsp({
      titleId: "0100ABCDEF012800",
      version: 65536,
      type: CnmtType.Patch,
      keys,
      name: "Example Game",
    });
    const cnmt = await readCnmtFromMetaNca(new BufferReader(pkg.meta), keys);
    expect(cnmt.kind).toBe("patch");
    expect(cnmt.applicationId).toBe(BASE);
    expect(cnmt.version).toBe(65536);
  });

  it("reads the application ID from a DLC CNMT", async () => {
    const pkg = buildTitleNsp({
      titleId: "0100ABCDEF013001",
      type: CnmtType.AddOnContent,
      applicationId: BASE,
      keys,
      name: "Bonus Pack",
    });
    const cnmt = await readCnmtFromMetaNca(new BufferReader(pkg.meta), keys);
    expect(cnmt.kind).toBe("addon");
    expect(cnmt.applicationId).toBe(BASE);
  });
});

describe("NCA validation", () => {
  it("rejects a missing header key", async () => {
    const nca = buildNca({
      contentType: 1,
      titleId: BASE,
      keys,
      fs: { type: "pfs0", data: buildPfs0([{ name: "x.cnmt", data: Buffer.alloc(0x40) }]) },
    });
    await expect(parseNcaHeader(new BufferReader(nca), new Map())).rejects.toBeInstanceOf(
      MissingKeyError,
    );
  });

  it("rejects garbage that does not decrypt to NCA3", async () => {
    const junk = Buffer.alloc(0xc00, 0x11);
    await expectFormatError(parseNcaHeader(new BufferReader(junk), keys), "BAD_MAGIC");
  });

  it("rejects a truncated NCA", async () => {
    await expectFormatError(
      parseNcaHeader(new BufferReader(Buffer.alloc(0x100)), keys),
      "TRUNCATED",
    );
  });
});

describe("parseKeyset status round-trip", () => {
  it("lists key names without exposing material", () => {
    const parsed = parseKeyset(formatProdKeys(keys));
    expect(parsed.keys.get("header_key")?.equals(headerKey(keys))).toBe(true);
  });
});

describe("RomFS", () => {
  it("round-trips root files", () => {
    const nacp = Buffer.from("nacp-bytes");
    const icon = Buffer.from("icon-bytes");
    const image = buildRomfs([
      { name: "control.nacp", data: nacp },
      { name: "icon_AmericanEnglish.dat", data: icon },
    ]);
    const files = parseRomfs(image);
    expect(files.map((f) => f.path)).toEqual(["control.nacp", "icon_AmericanEnglish.dat"]);
    expect(image.subarray(files[0]!.offset, files[0]!.offset + files[0]!.size).equals(nacp)).toBe(
      true,
    );
  });
});

describe("CNMT builder", () => {
  it("sums packaged content sizes", async () => {
    const pkg = buildTitleNsp({ titleId: BASE, keys, name: "G" });
    const cnmt = await readCnmtFromMetaNca(new BufferReader(pkg.meta), keys);
    expect(cnmt.installSize).toBe(pkg.program.length + pkg.control.length);
  });
});

describe("header decrypt helper", () => {
  it("matches parseNcaHeader", async () => {
    const pkg = buildTitleNsp({ titleId: BASE, keys, name: "G" });
    const decrypted = decryptNcaHeader(pkg.meta, keys);
    const info = parseDecryptedNcaHeader(decrypted, keys);
    expect(info.titleId).toBe(BASE);
  });
});
