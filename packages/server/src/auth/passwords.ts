import { randomBytes, type ScryptOptions, scrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 32;
const DEFAULT_COST: Required<Pick<ScryptOptions, "N" | "r" | "p">> = { N: 2 ** 15, r: 8, p: 1 };

function derive(password: string, salt: Buffer, cost: typeof DEFAULT_COST): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      { ...cost, maxmem: 128 * cost.N * cost.r * 2 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** Returns `scrypt$N$r$p$salt$hash` (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, DEFAULT_COST);
  const { N, r, p } = DEFAULT_COST;
  return ["scrypt", N, r, p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
