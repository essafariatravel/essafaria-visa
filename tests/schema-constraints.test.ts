import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "./helpers";

/* Database layer: constraints, uniqueness, FKs, cascades, enums. */

describe("schema constraints (migrated Postgres)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb();
    await t.seed();
  }, 120_000);
  afterAll(async () => await t.close());

  it("enforces unique agency codes", async () => {
    const { agencies } = await import("@/db");
    await expect(
      t.db.insert(agencies).values({ code: "ESSAF001", name: "Duplicate Code Co" }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("enforces unique (case-insensitive) user emails", async () => {
    const { users } = await import("@/db");
    await expect(
      t.db
        .insert(users)
        .values({ email: "ADMIN@essafaria.local", name: "X", passwordHash: "scrypt$1$1$1$aa$bb", role: "ADMIN" }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("enforces unique visa requirement pair (type × document)", async () => {
    const { visaRequirements, visaTypes, documentTypes } = await import("@/db");
    const [vt] = await t.db.select().from(visaTypes).limit(1);
    const [dt] = await t.db.select().from(documentTypes).limit(1);
    await expect(
      t.db
        .insert(visaRequirements)
        .values({ visaTypeId: vt.id, documentTypeId: dt.id, isRequired: true }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("FK: requirements cannot point at a missing visa type", async () => {
    const { visaRequirements, documentTypes } = await import("@/db");
    const [dt] = await t.db.select().from(documentTypes).limit(1);
    await expect(
      t.db.insert(visaRequirements).values({ visaTypeId: "no-such-id", documentTypeId: dt.id }),
    ).rejects.toThrow(/foreign key/i);
  });

  it("FK RESTRICT: a country in use by visa types cannot be deleted (history safety)", async () => {
    const { countries, visaTypes } = await import("@/db");
    const [fr] = await t.db.select().from(countries).where(eq(countries.code, "FR")).limit(1);
    const used = await t.db.select({ id: visaTypes.id }).from(visaTypes).where(eq(visaTypes.countryId, fr.id)).limit(1);
    expect(used.length).toBeGreaterThan(0);
    await expect(t.db.delete(countries).where(eq(countries.id, fr.id))).rejects.toThrow(/foreign key/i);
  });

  it("enum roles reject unknown values", async () => {
    const { users } = await import("@/db");
    await expect(
      t.db
        .insert(users)
        .values({ email: "weird@x.com", name: "W", passwordHash: "h", role: "SUPERUSER" as any }),
    ).rejects.toThrow(/invalid input value for enum/i);
  });

  it("cascades: deleting a visa type removes its requirements, keeps document types", async () => {
    const { visaTypes, visaRequirements, documentTypes } = await import("@/db");
    const [vt] = await t.db.select().from(visaTypes).where(eq(visaTypes.code, "TR_E_VISA")).limit(1);
    const reqs = await t.db.select().from(visaRequirements).where(eq(visaRequirements.visaTypeId, vt.id));
    expect(reqs.length).toBeGreaterThan(0);
    await t.db.delete(visaTypes).where(eq(visaTypes.id, vt.id));
    const after = await t.db.select().from(visaRequirements).where(eq(visaRequirements.visaTypeId, vt.id));
    expect(after.length).toBe(0);
    const docs = await t.db.select().from(documentTypes);
    expect(docs.length).toBeGreaterThan(0);
  });

  it("audit rows survive user deletion (SET NULL actor, kept email copy)", async () => {
    const { users, auditLogs } = await import("@/db");
    const [u] = await t.db.select().from(users).where(eq(users.email, "owner@saharavoyages.dz")).limit(1);
    await t.db.insert(auditLogs).values({ action: "UPDATE", entityType: "agency", entityId: "x", actorId: u.id, actorEmail: u.email });
    await t.db.delete(users).where(eq(users.id, u.id));
    const row = await t.db
      .select()
      .from(auditLogs)
      .where(sql`${auditLogs.entityId} = 'x'`)
      .limit(1);
    expect(row.length).toBe(1);
    expect(row[0].actorId).toBeNull();
    expect(row[0].actorEmail).toBe("owner@saharavoyages.dz");
  });
});
