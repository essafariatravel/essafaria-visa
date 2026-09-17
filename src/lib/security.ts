import { and, eq, gte, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { getDb, loginAttempts, type Database } from "@/db";
import { isMutatingMethod, sameSiteOrigin } from "@/lib/same-site";
import { env } from "@/lib/env";

type Q = any;

/* ============================================================
 * Login throttling and request-rate guards (Phase 10).
 *
 * Throttling is stored in the DATABASE, keyed by a HASH of the identifier, so:
 *   • it survives a restart and works across app instances;
 *   • it never stores a raw email or IP in the counter table;
 *   • it cannot become a user-existence oracle — failures are recorded for
 *     unknown addresses too, and the response is identical either way.
 *
 * Rate limiting for API mutations is per-process (an in-memory token bucket),
 * because this platform has no Redis. That is a deliberate, documented limit: it
 * stops one instance being hammered; a shared store is the upgrade path.
 * ============================================================ */

export { isMutatingMethod, sameSiteOrigin };

export function hashIdentifier(value: string): string {
  return crypto.createHash("sha256").update(`esf-auth:${value.toLowerCase()}`).digest("hex").slice(0, 64);
}

function windowMinutes(): number {
  try {
    return env().LOGIN_WINDOW_MINUTES ?? 15;
  } catch {
    return 15;
  }
}

function maxAttempts(): number {
  try {
    return env().LOGIN_MAX_ATTEMPTS ?? 8;
  } catch {
    return 8;
  }
}

export interface ThrottleState {
  blocked: boolean;
  failures: number;
  retryAfterSeconds: number;
}

/** Counted per identifier (not per user row) and inside the configured window. */
export async function checkLoginThrottle(email: string, tx?: Database): Promise<ThrottleState> {
  const t: Q = tx ?? (await getDb());
  const key = hashIdentifier(email);
  const since = new Date(Date.now() - windowMinutes() * 60_000);
  const rows = (await t
    .select({
      failures: sql<number>`count(*) filter (where ${loginAttempts.success} = false)::int`,
      last: sql<string>`max(${loginAttempts.createdAt})`,
    })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.key, key), gte(loginAttempts.createdAt, since)))) as Array<{ failures: number; last: string | null }>;
  const failures = Number(rows[0]?.failures ?? 0);
  const limit = maxAttempts();
  if (failures < limit) return { blocked: false, failures, retryAfterSeconds: 0 };
  const lastAt = rows[0]?.last ? new Date(rows[0].last as unknown as string).getTime() : Date.now();
  const retryAfterSeconds = Math.max(1, Math.ceil((lastAt + windowMinutes() * 60_000 - Date.now()) / 1000));
  return { blocked: true, failures, retryAfterSeconds };
}

export async function recordLoginAttempt(input: { email: string; success: boolean; req?: Request }): Promise<void> {
  const t: Q = await getDb();
  const ip = input.req?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? input.req?.headers.get("x-real-ip") ?? "";
  const agent = input.req?.headers.get("user-agent") ?? "";
  await t.insert(loginAttempts).values({
    key: hashIdentifier(input.email),
    success: input.success,
    ipHash: ip ? hashIdentifier(`ip:${ip}`).slice(0, 32) : null,
    userAgentHash: agent ? hashIdentifier(`ua:${agent}`).slice(0, 32) : null,
  });
  if (input.success) {
    // a good login clears the counter for that identifier
    await t.delete(loginAttempts).where(and(eq(loginAttempts.key, hashIdentifier(input.email)), eq(loginAttempts.success, false)));
  }
}

/** Prune old counters (called by automation). */
export async function purgeLoginAttempts(olderThanDays = 7, tx?: Database): Promise<number> {
  const t: Q = tx ?? (await getDb());
  const res = await t.execute(
    sql`delete from login_attempts where created_at < now() - make_interval(days => ${olderThanDays})`,
  );
  const n = (res as { affectedRows?: number; rowCount?: number })?.affectedRows ?? (res as { rowCount?: number })?.rowCount ?? 0;
  return Number(n ?? 0);
}

/* ---------------- per-process token bucket ---------------- */

const buckets = new Map<string, { tokens: number; updated: number }>();
const BURST_FACTOR = 2;

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Allow up to RATE_LIMIT_PER_MINUTE requests per minute per bucket key, with a
 * 2× burst allowance. Exposed as a pure function of (key, now) so it is testable
 * without a clock.
 */
export function rateLimit(key: string, now = Date.now()): RateDecision {
  let perMinute = 240;
  try {
    perMinute = env().RATE_LIMIT_PER_MINUTE ?? 240;
  } catch {
    perMinute = 240;
  }
  const capacity = Math.max(1, perMinute) * BURST_FACTOR;
  const refillPerMs = Math.max(1, perMinute) / 60_000;
  const hit = buckets.get(key);
  if (!hit) {
    buckets.set(key, { tokens: capacity - 1, updated: now });
    if (buckets.size > 5000) sweepBuckets(now);
    return { allowed: true, remaining: Math.floor(capacity - 1), retryAfterSeconds: 0 };
  }
  const refilled = Math.min(capacity, hit.tokens + (now - hit.updated) * refillPerMs);
  if (refilled < 1) {
    buckets.set(key, { tokens: refilled, updated: now });
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((1 - refilled) / refillPerMs / 1000)) };
  }
  buckets.set(key, { tokens: refilled - 1, updated: now });
  return { allowed: true, remaining: Math.floor(refilled - 1), retryAfterSeconds: 0 };
}

function sweepBuckets(now: number): void {
  for (const [k, v] of buckets) if (now - v.updated > 5 * 60_000) buckets.delete(k);
}

/** Test seam. */
export function __resetRateBuckets(): void {
  buckets.clear();
}

/** Request-shaped wrapper used by the route layer. */
export function requireTrustedOrigin(req: Request): { ok: boolean; reason?: string } {
  if (!isMutatingMethod(req.method)) return { ok: true };
  const trustProxy = env().TRUST_PROXY_HEADERS !== "false";
  return sameSiteOrigin(
    req.headers.get("origin") ?? req.headers.get("referer"),
    req.url,
    req.headers.get("host"),
    trustProxy ? req.headers.get("x-forwarded-host") : null,
  );
}
