import { formatProdKeys, generateFakeKeyset } from "@nslib/fixtures";
import { describe, expect, it } from "vitest";
import { aesEcb, keysetStatus, parseKeyset, unwrapKeyArea } from "../src/index";

describe("parseKeyset", () => {
  it("round-trips a generated keyset", () => {
    const keys = generateFakeKeyset();
    const parsed = parseKeyset(formatProdKeys(keys));
    expect(parsed.invalidLines).toEqual([]);
    expect(parsed.keys).toEqual(keys);
    expect(parsed.keys.get("header_key")).toHaveLength(32);
    expect(parsed.keys.get("key_area_key_application_03")).toHaveLength(16);
  });

  it("is deterministic per seed", () => {
    expect(generateFakeKeyset()).toEqual(generateFakeKeyset());
    expect(generateFakeKeyset("other").get("header_key")).not.toEqual(
      generateFakeKeyset().get("header_key"),
    );
  });

  it("skips comments and blank lines, normalizes names, and reports bad lines", () => {
    const text = [
      "# dumped with Lockpick_RCM",
      "",
      "HEADER_KEY = 00112233445566778899AABBCCDDEEFF00112233445566778899aabbccddeeff",
      "; another comment",
      "titlekek_00=0123456789abcdef0123456789abcdef",
      "broken line",
      "odd_length = abc",
    ].join("\r\n");
    const parsed = parseKeyset(text);
    expect([...parsed.keys.keys()]).toEqual(["header_key", "titlekek_00"]);
    expect(parsed.invalidLines).toEqual([6, 7]);
  });

  it("reports names without exposing key material", () => {
    const status = keysetStatus(generateFakeKeyset());
    expect(status.configured).toBe(true);
    expect(status.headerKey).toBe(true);
    expect(status.keyAreaKeyGenerations).toEqual([0, 1, 2, 3]);
    expect(JSON.stringify(status)).not.toContain(
      formatProdKeys(generateFakeKeyset()).slice(20, 52),
    );
  });

  it("unwraps a key area with the matching KAEK", () => {
    const keys = generateFakeKeyset();
    const plain = Buffer.alloc(0x40, 0xab);
    const kaek = keys.get("key_area_key_application_00")!;
    const wrapped = aesEcb(kaek, plain, true);
    expect(unwrapKeyArea(keys, wrapped, 0, 0).equals(plain)).toBe(true);
  });
});
