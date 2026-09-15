import {
  buildNro,
  buildTitleNsp,
  buildXci,
  deterministicBytes,
  fakeJpeg,
  generateFakeKeyset,
} from "@nslib/fixtures";
import { BufferReader, FormatError, formatFromFileName } from "@nslib/formats";
import { describe, expect, it } from "vitest";
import { displayNameFromFileName, inspectLibraryFile } from "../src/library/inspect";
import { fakeNsp, fakeNspEntries } from "./helpers";

const BASE = "0100ABCDEF012000";
const UPDATE = "0100ABCDEF012800";
const DLC = "0100ABCDEF013001";

function inspect(data: Buffer, fileName: string, keys?: Map<string, Buffer>) {
  const format = formatFromFileName(fileName);
  if (!format) throw new Error(`unsupported test file ${fileName}`);
  return inspectLibraryFile(new BufferReader(data), fileName, format, { keys });
}

describe("inspectLibraryFile", () => {
  it("identifies a base game from its ticket, with the version from the filename", async () => {
    const result = await inspect(fakeNsp({ tickets: [BASE] }), `Example Game [${BASE}][v0].nsp`);
    expect(result.metas).toEqual([
      {
        titleId: BASE,
        type: "application",
        applicationId: BASE,
        applicationIdSource: "exact",
        version: 0,
        displayName: "Example Game",
        keyGeneration: 0x0b,
        rightsId: `${BASE}000000000000000B`,
        requiredSystemVersion: null,
        installSize: null,
        records: [],
        publisher: null,
        icon: null,
        source: "ticket",
      },
    ]);
    expect(result.metadataSource).toBe("ticket");
    expect(result.entries.map((e) => e.kind)).toEqual(["cnmt", "nca", "tik", "cert"]);
    expect(result.warnings).toEqual([]);
  });

  it("identifies an update from the filename alone", async () => {
    const result = await inspect(fakeNsp(), `Example Game [${UPDATE}][v196608].nsp`);
    expect(result.metas).toMatchObject([
      {
        titleId: UPDATE,
        type: "patch",
        applicationId: BASE,
        applicationIdSource: "derived",
        version: 196608,
        source: "filename",
      },
    ]);
    expect(result.metadataSource).toBe("filename");
  });

  it("assigns DLC bundled with a base game to that game", async () => {
    const result = await inspect(fakeNsp({ tickets: [BASE, DLC] }), "Bundle.nsp");
    expect(result.metas).toMatchObject([
      { titleId: BASE, type: "application", version: null },
      {
        titleId: DLC,
        type: "addon",
        applicationId: BASE,
        applicationIdSource: "derived",
        version: null,
      },
    ]);
  });

  it("guesses the base game of standalone DLC", async () => {
    const result = await inspect(fakeNsp({ tickets: [DLC] }), "Example Game - Bonus Pack.nsp");
    expect(result.metas).toMatchObject([
      {
        titleId: DLC,
        applicationId: BASE,
        applicationIdSource: "guess",
        displayName: "Example Game - Bonus Pack",
      },
    ]);
  });

  it("uses the filename for cartridge images, which carry no tickets", async () => {
    const result = await inspect(buildXci(fakeNspEntries()), `Cart Game [${BASE}].xci`);
    expect(result.metas).toMatchObject([{ titleId: BASE, version: null, source: "filename" }]);
  });

  it("returns no content when nothing identifies the file", async () => {
    const result = await inspect(fakeNsp(), "backup.nsz");
    expect(result.metas).toEqual([]);
    expect(result.metadataSource).toBeNull();
  });

  it("warns when a container has no content metadata entry", async () => {
    const result = await inspect(buildXci([]), `Empty [${BASE}].xci`);
    expect(result.warnings).toContain("No content metadata (.cnmt.nca) entry found");
  });

  it("reads homebrew name, author, version, and icon", async () => {
    const icon = fakeJpeg("tool");
    const result = await inspect(
      buildNro({ name: "Tool", publisher: "Someone", displayVersion: "2.0.1", icon }),
      "tool.nro",
    );
    expect(result.homebrew).toEqual({ name: "Tool", publisher: "Someone", version: "2.0.1", icon });
    expect(result.metadataSource).toBe("nacp");
  });

  it("rejects damaged containers", async () => {
    await expect(inspect(deterministicBytes("junk", 0x400), "junk.nsp")).rejects.toBeInstanceOf(
      FormatError,
    );
  });
});

describe("inspectLibraryFile with keys", () => {
  const keys = generateFakeKeyset();

  it("reads name, version, firmware, and icon from CNMT and NACP", async () => {
    const pkg = buildTitleNsp({
      titleId: BASE,
      version: 0,
      keys,
      name: "Example Game",
      publisher: "Fixture Co",
      requiredSystemVersion: 0x0c0000,
    });
    const result = await inspect(pkg.nsp, "ignored-name.nsp", keys);
    expect(result.metadataSource).toBe("nacp");
    expect(result.application).toMatchObject({
      applicationId: BASE,
      name: "Example Game",
      publisher: "Fixture Co",
    });
    expect(result.application?.icon).toBeInstanceOf(Buffer);
    expect(result.metas).toMatchObject([
      {
        titleId: BASE,
        type: "application",
        applicationId: BASE,
        applicationIdSource: "exact",
        version: 0,
        displayName: "Example Game",
        requiredSystemVersion: 0x0c0000,
        source: "nacp",
      },
    ]);
    expect(result.metas[0]?.records.length).toBe(2);
    expect(result.metas[0]?.installSize).toBeGreaterThan(0);
  });

  it("maps DLC to its base game from the CNMT", async () => {
    const pkg = buildTitleNsp({
      titleId: DLC,
      type: 0x82,
      applicationId: BASE,
      keys,
      name: "Bonus Pack",
    });
    const result = await inspect(pkg.nsp, "Bonus Pack.nsp", keys);
    expect(result.metas).toMatchObject([
      {
        titleId: DLC,
        type: "addon",
        applicationId: BASE,
        applicationIdSource: "derived",
        displayName: "Bonus Pack",
        source: "nacp",
      },
    ]);
  });

  it("falls back to tickets when the CNMT cannot be decrypted", async () => {
    const result = await inspect(
      fakeNsp({ tickets: [BASE] }),
      `Example Game [${BASE}][v0].nsp`,
      keys,
    );
    expect(result.metas).toMatchObject([{ titleId: BASE, source: "ticket" }]);
    expect(result.warnings.some((w) => w.includes("Couldn't read"))).toBe(true);
  });
});

describe("displayNameFromFileName", () => {
  it.each([
    ["Example Game [0100ABCDEF012000][v0].nsp", "Example Game"],
    ["Example Game [0100ABCDEF012800][v196608] [UPD].nsz", "Example Game"],
    ["Example Game - Bonus Pack [0100ABCDEF013001].nsp", "Example Game - Bonus Pack"],
    ["[0100ABCDEF012000].xci", "[0100ABCDEF012000]"],
    ["tool.nro", "tool"],
  ])("%s → %s", (input, expected) => {
    expect(displayNameFromFileName(input)).toBe(expected);
  });
});
