import { describe, expect, it } from "vitest";
import {
  applicationIdForPatch,
  guessApplicationIdForAddon,
  inferTypeFromTitleId,
  normalizeTitleId,
  parseTitleFilename,
} from "../src/index";

describe("title IDs", () => {
  it("normalizes case and 0x prefix", () => {
    expect(normalizeTitleId("0x0100abcdef012000")).toBe("0100ABCDEF012000");
  });

  it("rejects malformed IDs", () => {
    expect(() => normalizeTitleId("0100ABC")).toThrow();
    expect(() => normalizeTitleId("0100ABCDEF01200G")).toThrow();
  });

  it("infers type from the low 12 bits", () => {
    expect(inferTypeFromTitleId("0100ABCDEF012000")).toBe("application");
    expect(inferTypeFromTitleId("0100ABCDEF012800")).toBe("patch");
    expect(inferTypeFromTitleId("0100ABCDEF013001")).toBe("addon");
  });

  it("maps a patch to its application", () => {
    expect(applicationIdForPatch("0100ABCDEF012800")).toBe("0100ABCDEF012000");
  });

  it("guesses a DLC's base application", () => {
    expect(guessApplicationIdForAddon("0100ABCDEF013001")).toBe("0100ABCDEF012000");
    expect(guessApplicationIdForAddon("0100ABCDEF013FFF")).toBe("0100ABCDEF012000");
  });
});

describe("parseTitleFilename", () => {
  it("reads title ID and version tags", () => {
    expect(parseTitleFilename("Some Game [0100abcdef012800][v393216].nsp")).toEqual({
      titleId: "0100ABCDEF012800",
      version: 393216,
    });
  });

  it("returns partial info when tags are missing", () => {
    expect(parseTitleFilename("Some Game [0100ABCDEF012000].xci")).toEqual({
      titleId: "0100ABCDEF012000",
    });
    expect(parseTitleFilename("backup.nsp")).toEqual({});
  });

  it("ignores out-of-range versions", () => {
    expect(parseTitleFilename("x [0100ABCDEF012000][v9999999999].nsp")).toEqual({
      titleId: "0100ABCDEF012000",
    });
  });
});
