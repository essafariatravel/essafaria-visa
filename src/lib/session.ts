import { cookies } from "next/headers";
import { cache } from "react";
import { eq, and, gt, desc } from "drizzle-orm";
import { getDb, sessions, users, agencyMemberships } from "@/db";
import { randomToken, sha256 } from "@/lib/password";
import type { Role } from "@/lib/rbac";

export const SESSION_COOKIE = "esf_session";
const DEFAULT_SESSION_DAYS = 14;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** Agencies this user belongs to (empty for platform staff). */
  agencyIds: string[];
}

/**
 * Issue a session. `days` comes from the configured security.sessionDays value
 * at the call site (the login route reads it), never from a client value.
 * Cookies are httpOnly + SameSite=Lax + Secure in production, with a 24-hour
 * browser-scope fallback so a stolen cookie cannot outlive the server-side row.
 */
export async function createSession(userId: string, days = DEFAULT_SESSION_DAYS): Promise<void> {
  const db = await getDb();
  const token = randomToken(32);
  const safeDays = Math.min(90, Math.max(1, Math.floor(Number(days) || DEFAULT_SESSION_DAYS)));
  const expiresAt = new Date(Date.now() + safeDays * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({ userId, tokenHash: sha256(token), expiresAt });
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
    maxAge: 24 * 60 * 60,
  });
}

/** Revoke every session of a user (password change, deactivation, "sign me out
 *  of everything"). */
export async function revokeSessionsFor(userId: string): Promise<number> {
  const db = await getDb();
  const res = (await db.delete(sessions).where(eq(sessions.userId, userId))) as unknown as {
    rowCount?: number;
    affectedRows?: number;
  };
  return Number(res?.rowCount ?? res?.affectedRows ?? 0);
}

export async function destroySession(): Promise<void> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
  }
  cookies().delete(SESSION_COOKIE);
}

/**
 * Resolve the current user from the session cookie — the ONLY trusted
 * identity source. Never read user/agency identity from URL params,
 * client state or localStorage. Memoized per request via React cache().
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = await getDb();
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
      sessionId: sessions.id,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row || !row.isActive) return null;
  const memberships = await db
    .select({ agencyId: agencyMemberships.agencyId })
    .from(agencyMemberships)
    .where(eq(agencyMemberships.userId, row.id));
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    agencyIds: memberships.map((m) => m.agencyId),
  };
});

export async function touchLastLogin(userId: string): Promise<void> {
  const db = await getDb();
  await db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, userId));
}
