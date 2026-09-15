import { describe, expect, it } from "vitest";
import { etagFor, etagsMatch, parseRangeHeader } from "../src/device/range";

describe("parseRangeHeader", () => {
  it("treats a missing header as the whole file", () => {
    expect(parseRangeHeader(undefined, 100)).toBe("all");
    expect(parseRangeHeader("", 100)).toBe("all");
  });

  it("parses closed, open-ended, and suffix ranges", () => {
    expect(parseRangeHeader("bytes=0-3", 100)).toEqual({ start: 0, end: 3 });
    expect(parseRangeHeader("bytes=50-", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRangeHeader("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRangeHeader("bytes=0-999", 100)).toEqual({ start: 0, end: 99 });
  });

  it("rejects unsatisfiable and multipart ranges", () => {
    expect(parseRangeHeader("bytes=100-110", 100)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=20-10", 100)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=0-1,2-3", 100)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRangeHeader("items=0-1", 100)).toBe("unsatisfiable");
  });
});

describe("etags", () => {
  it("matches quoted tags with optional weak prefixes", () => {
    const tag = etagFor(16, 1000);
    expect(etagsMatch(tag, tag)).toBe(true);
    expect(etagsMatch(`W/${tag}`, tag)).toBe(true);
    expect(etagsMatch(tag, etagFor(17, 1000))).toBe(false);
  });
});
