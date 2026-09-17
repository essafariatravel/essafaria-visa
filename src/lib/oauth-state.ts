import crypto from "node:crypto";
import { cookies } from "next/headers";

/* ============================================================
 * Stateless OAuth state for the Gmail callback.
 *
 * The pending {connectionId, state, PKCE verifier} is held in an httpOnly
 * cookie, signed with an HMAC keyed by the caller's session token hash.
 * Effects:
 *   • only the browser that started the flow can complete it (state check),
 *   • no server-side session store or extra table is needed,
 *   • the verifier never appears in a URL the user can bookmark or leak,
 *   • a forged cookie cannot be produced without the session token, and a
 *     stolen callback URL alone is useless.
 * The signed value is never logged.
 * ============================================================ */

const COOKIE = "esf_oauth_state";
const MAX_AGE_SECONDS = 600;

export interface OAuthStatePayload {
  connectionId: string;
  state: string;
  verifier: string;
}

function key(sessionToken: string): string {
  return crypto.createHash("sha256").update(`oauth-state:${sessionToken}`).digest("hex");
}

function sign(payload: string, sessionToken: string): string {
  return crypto.createHmac("sha256", key(sessionToken)).update(payload).digest("base64url");
}

export function writeOAuthState(payload: OAuthStatePayload, sessionToken: string): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  cookies().set(COOKIE, `${body}.${sign(body, sessionToken)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/gmail",
    maxAge: MAX_AGE_SECONDS,
  });
}

/** Reads and clears the state (single use). Returns null on any mismatch. */
export function readOAuthState(expectedConnectionId: string, expectedState: string, sessionToken: string): OAuthStatePayload | null {
  const raw = cookies().get(COOKIE)?.value;
  cookies().delete(COOKIE);
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = sign(body, sessionToken);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let parsed: OAuthStatePayload | null = null;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthStatePayload;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.state !== "string" || typeof parsed.verifier !== "string") return null;
  if (parsed.connectionId !== expectedConnectionId || parsed.state !== expectedState) return null;
  return parsed;
}
