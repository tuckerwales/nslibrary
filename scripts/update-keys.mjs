/**
 * Ed25519 helpers for NSLibrary Switch app updates.
 *
 * Secret keys are 32-byte seeds (hex). Public keys are 32-byte raw points (hex).
 * Signatures are 64 raw bytes (RFC 8032), matching TweetNaCl crypto_sign_open.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function seedToPrivateKey(seed) {
  if (seed.byteLength !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

export function rawToPublicKey(raw) {
  if (raw.byteLength !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function parseHexKey(hex, expected) {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(clean) || clean.length !== expected * 2) {
    throw new Error(`Expected ${expected} bytes of hex, got ${clean.length / 2}`);
  }
  return Buffer.from(clean, "hex");
}

export function generateUpdateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pkDer = publicKey.export({ type: "spki", format: "der" });
  const skDer = privateKey.export({ type: "pkcs8", format: "der" });
  return {
    publicKey: pkDer.subarray(SPKI_PREFIX.length),
    seed: skDer.subarray(PKCS8_PREFIX.length),
  };
}

export function signBytes(seed, message) {
  return sign(null, message, seedToPrivateKey(seed));
}

export function verifyBytes(publicKey, message, signature) {
  return verify(null, message, rawToPublicKey(publicKey), signature);
}

export function cPublicKeyHeader(publicKey, symbol = "kUpdatePublicKey") {
  const bytes = [...publicKey].map((b) => `0x${b.toString(16).padStart(2, "0")}`);
  const rows = [];
  for (let i = 0; i < bytes.length; i += 8) rows.push(bytes.slice(i, i + 8).join(", "));
  return `constexpr uint8_t ${symbol}[32] = {\n    ${rows.join(",\n    ")},\n};\n`;
}

export function canonicalUpdateJson(version, sha256Hex, size) {
  return `{"version":${JSON.stringify(version)},"sha256":${JSON.stringify(sha256Hex.toLowerCase())},"size":${size}}`;
}
