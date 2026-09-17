import crypto from "node:crypto";

/* ============================================================
 * Password hashing — scrypt via node:crypto (no native deps).
 * Format: scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
 * ============================================================ */

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize("NFKC"),
      salt,
      PARAMS.keylen,
      { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p },
      (err, derived) => (err ? reject(err) : resolve(derived)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt);
  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("hex"),
    hash.toString("hex"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [algo, n, r, p, saltHex, hashHex] = stored.split("$");
    if (algo !== "scrypt") return false;
    const derived = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(
        password.normalize("NFKC"),
        Buffer.from(saltHex, "hex"),
        Buffer.from(hashHex, "hex").length,
        { N: Number(n), r: Number(r), p: Number(p) },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
    });
    return crypto.timingSafeEqual(derived, Buffer.from(hashHex, "hex"));
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
