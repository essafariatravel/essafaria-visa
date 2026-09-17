import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, users } from "@/db";
import { verifyPassword } from "@/lib/password";
import { createSession } from "@/lib/session";
import { loginSchema } from "@/lib/validation";
import { logAudit } from "@/lib/audit";
import { checkLoginThrottle, recordLoginAttempt } from "@/lib/security";
import { getSetting } from "@/lib/config-service";

export const dynamic = "force-dynamic";

/** A real scrypt hash of a random value, used to equalise timing for unknown
 *  accounts. It is public by design and verifies nothing. */
const DUMMY_HASH =
  "scrypt$16384$8$1$00000000000000000000000000000000$00000000000000000000000000000000000000000000000000000000000000000000000000000000";

export async function POST(req: Request) {
  const parsed = loginSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid email and password" }, { status: 400 });
  }
  // Throttle first, with the same response shape either way, so a probe cannot
  // tell "unknown account" from "wrong password" or "locked".
  const throttle = await checkLoginThrottle(parsed.data.email);
  if (throttle.blocked) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(throttle.retryAfterSeconds) } },
    );
  }
  const db = await getDb();
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, parsed.data.email))
    .limit(1);

  // verify even for unknown emails (against a fixed dummy hash) so the response
  // time does not reveal whether an account exists
  const ok =
    !!user &&
    user.isActive &&
    (await verifyPassword(parsed.data.password, user.passwordHash || DUMMY_HASH));
  if (!ok) {
    await recordLoginAttempt({ email: parsed.data.email, success: false, req });
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }
  await recordLoginAttempt({ email: parsed.data.email, success: true, req });
  const days = Number(await getSetting<number>("security.sessionDays", 14));
  await createSession(user.id, Number.isFinite(days) && days >= 1 && days <= 90 ? days : 14);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await logAudit({ actorId: user.id, actorEmail: user.email, action: "LOGIN", entityType: "user", entityId: user.id });
  return NextResponse.json({
    ok: true,
    role: user.role,
    next: user.role === "AGENCY_ADMIN" || user.role === "AGENCY_USER" ? "/agency" : "/admin",
  });
}

export async function DELETE() {
  const { getSessionUser } = await import("@/lib/session");
  const user = await getSessionUser();
  const { destroySession } = await import("@/lib/session");
  await destroySession();
  if (user) {
    await logAudit({ actorId: user.id, actorEmail: user.email, action: "LOGOUT", entityType: "user", entityId: user.id });
  }
  return NextResponse.json({ ok: true });
}
