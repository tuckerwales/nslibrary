import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const golden = join(import.meta.dirname, "../../../switch/tests/golden/update");

describe("update signing", () => {
  it("round-trips Ed25519 over canonical update.json", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const nro = Buffer.from("hello nro");
    const json = `{"version":"1.2.3","sha256":"${createHash("sha256").update(nro).digest("hex")}","size":${nro.byteLength}}`;
    const sig = sign(null, Buffer.from(json, "utf8"), privateKey);
    expect(sig.byteLength).toBe(64);
    expect(verify(null, Buffer.from(json, "utf8"), publicKey, sig)).toBe(true);
    expect(verify(null, Buffer.from(`${json} `), publicKey, sig)).toBe(false);
  });

  it("matches the C++ golden vectors", () => {
    const pk = readFileSync(join(golden, "test.pk"));
    const json = readFileSync(join(golden, "update.json"));
    const sig = readFileSync(join(golden, "update.json.sig"));
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, pk]),
      format: "der",
      type: "spki",
    });
    expect(verify(null, json, publicKey, sig)).toBe(true);
  });
});
