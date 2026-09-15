#!/usr/bin/env node
/**
 * Generate an Ed25519 keypair for signing Switch .nro updates.
 *
 * Prints the public key (safe to commit) and the 32-byte seed.
 * Put the seed in GitHub Actions secret NSLIB_UPDATE_SK. Do not commit it.
 */
import { cPublicKeyHeader, generateUpdateKeypair } from "./update-keys.mjs";

const { publicKey, seed } = generateUpdateKeypair();
process.stdout.write(`Public key (hex):\n${publicKey.toString("hex")}\n\n`);
process.stdout.write(`C++ header:\n${cPublicKeyHeader(publicKey)}\n`);
process.stdout.write(
  `Secret seed (hex) — GitHub secret NSLIB_UPDATE_SK:\n${seed.toString("hex")}\n`,
);
