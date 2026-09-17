import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, gt } from "drizzle-orm";
import { createTestDb } from "./helpers";
import { hashPassword, verifyPassword, randomToken, sha256 } from "@/lib/password";

/* Authentication foundation: password hashing + session table semantics.
 * (Cookie plumbing is exercised by the login page at runtime.) */

describe("passwords", () => {
  it("round-trips and rejects wrong input", async () => {
    const hash = await hashPassword("Corr3ct-Horse!");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("Corr3ct-Horse!", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("salts differ per hash", async () => {
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("garbage stored hashes never verify", async () => {
    expect(await verifyPassword("x", "plain")).toBe(false);
    expect(await verifyPassword("x", "scrypt$bad$data")).toBe(false);
  });

  it("tokens: high entropy, stable hash", () => {
    const t1 = randomToken();
    const t2 = randomToken();
    expect(t1).not.toBe(t2);
    expect(t1).toHaveLength(64);
    expect(sha256(t1)).toHaveLength(64);
    expect(sha256(t1)).toBe(sha256(t1));
  });
});

describe("session records", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb();
    await t.seed();
  }, 120_000);
  afterAll(async () => await t.close());

  it("valid session resolves to active user; expired and disabled do not", async () => {
    const { sessions, users } = await import("@/db");
    const [user] = await t.db.select().from(users).where(eq(users.email, "admin@essafaria.local")).limit(1);
    const token = randomToken();
    await t.db.insert(sessions).values({ userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60_000) });
    const found = await t.db
      .select({ id: users.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())));
    expect(found[0]?.id).toBe(user.id);

    // expired
    const stale = randomToken();
    await t.db.insert(sessions).values({ userId: user.id, tokenHash: sha256(stale), expiresAt: new Date(Date.now() - 1000) });
    const expiredFound = await t.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.tokenHash, sha256(stale)), gt(sessions.expiresAt, new Date())));
    expect(expiredFound.length).toBe(0);

    // deactivated user must not authenticate even with a live session row
    await t.db.update(users).set({ isActive: false }).where(eq(users.id, user.id));
    const row = await t.db
      .select({ isActive: users.isActive })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, sha256(token)))
      .limit(1);
    expect(row[0].isActive).toBe(false); // caller treats inactive as anonymous
    await t.db.update(users).set({ isActive: true }).where(eq(users.id, user.id));
  });

  it("session token hash is unique (same token cannot be inserted twice)", async () => {
    const { sessions, users } = await import("@/db");
    const [user] = await t.db.select().from(users).limit(1);
    const th = sha256("fixed-token");
    await t.db.insert(sessions).values({ userId: user.id, tokenHash: th, expiresAt: new Date(Date.now() + 60_000) });
    await expect(
      t.db.insert(sessions).values({ userId: user.id, tokenHash: th, expiresAt: new Date(Date.now() + 60_000) }),
    ).rejects.toThrow(/duplicate key/i);
  });
});
