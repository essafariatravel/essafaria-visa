import crypto from "node:crypto";
import { env } from "@/lib/env";
import { DomainError } from "@/lib/ops";

/* ============================================================
 * Sealed storage for long-lived integration secrets (Phase 8).
 *
 * A Gmail refresh token is a standing credential: it can read a mailbox at any
 * time. It is therefore never stored in plaintext, never returned by any read
 * path, and never sent to a client. The key lives in an environment variable
 * referenced by NAME (GMAIL_TOKEN_KEY_REF), so no key material is in the
 * database or in the repository.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to open instead of
 * yielding garbage. If the key is missing, the platform refuses to store or read
 * tokens — it does not fall back to plaintext.
 * ============================================================ */

const VERSION = "v1";

function resolveKey(): Buffer {
  const e = env() as unknown as Record<string, string | undefined>;
  const keyRefName = e["GMAIL_TOKEN_KEY_REF"] ?? "ESF_TOKEN_KEY";
  const raw = process.env[keyRefName];
  if (!raw) {
    throw new DomainError(
      "CONFIG",
      `No token encryption key configured — set ${keyRefName} to a 32-byte base64 key to enable Gmail connections`,
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new DomainError("CONFIG", `${keyRefName} must decode to exactly 32 bytes (base64 of 32 random bytes)`);
  }
  return buf;
}

export function sealPlaintext(plaintext: string): string {
  const key = resolveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

export function openSealed(cipherText: string): string {
  const key = resolveKey();
  const parts = String(cipherText ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new DomainError("CONFIG", "Stored token is not in a supported format — reconnect the account");
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1]!, "base64"));
    decipher.setAuthTag(Buffer.from(parts[2]!, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // Never echo the ciphertext or the key: a decode failure is a security event.
    throw new DomainError("CONFIG", "Stored token could not be decrypted — the encryption key changed, or the row is corrupt");
  }
}

export function tokenKeyConfigured(): boolean {
  try {
    resolveKey();
    return true;
  } catch {
    return false;
  }
}

/** Random state for the OAuth redirect (CSRF protection on the callback). */
export function oauthState(): { state: string; verifier: string } {
  const state = crypto.randomBytes(16).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { state, verifier };
}
