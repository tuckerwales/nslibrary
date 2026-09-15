import { deterministicBytes } from "./bytes";

export const FAKE_KEYSET_SEED = "nslibrary-fake-keyset-v1";
export const FAKE_KEY_GENERATIONS = 4;

const PER_GENERATION_KEYS = [
  "master_key",
  "key_area_key_application",
  "key_area_key_ocean",
  "key_area_key_system",
  "titlekek",
];

/**
 * A keyset with real key names and made-up values. Fixtures are encrypted with it so crypto
 * code paths run in CI without any console keys.
 */
export function generateFakeKeyset(seed = FAKE_KEYSET_SEED): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  keys.set("header_key", deterministicBytes(`${seed}:header_key`, 32));
  for (let generation = 0; generation < FAKE_KEY_GENERATIONS; generation++) {
    const suffix = generation.toString(16).padStart(2, "0");
    for (const name of PER_GENERATION_KEYS) {
      keys.set(`${name}_${suffix}`, deterministicBytes(`${seed}:${name}_${suffix}`, 16));
    }
  }
  return keys;
}

export function formatProdKeys(keys: ReadonlyMap<string, Uint8Array>): string {
  let text = "";
  for (const [name, value] of keys) text += `${name} = ${Buffer.from(value).toString("hex")}\n`;
  return text;
}
