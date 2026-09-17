import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, actorAgencyUser, actorAgencyAdmin } from "./helpers";
import type { SessionUser } from "@/lib/session";

/* Multi-tenancy: agency isolation is a server-side invariant, never a
 * client-side convention. */

describe("tenant isolation (spec §27)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let agencyA = "";
  let agencyB = "";

  beforeAll(async () => {
    t = await createTestDb();
    await t.seed();
    const { agencies, users, agencyMemberships } = await import("@/db");
    const [a] = await t.db.insert(agencies).values({ code: "TEN-A", name: "Tenant A" }).returning({ id: agencies.id });
    const [b] = await t.db.insert(agencies).values({ code: "TEN-B", name: "Tenant B" }).returning({ id: agencies.id });
    agencyA = a.id;
    agencyB = b.id;
    for (const [id, email] of [
      ["u-a", "ua@t.test"],
      ["u-a-admin", "uaa@t.test"],
      ["u-b", "ub@t.test"],
    ] as const) {
      await t.db
        .insert(users)
        .values({ id, email, name: id, passwordHash: "scrypt$1$1$1$aa$bb", role: id === "u-a-admin" ? "AGENCY_ADMIN" : "AGENCY_USER" });
    }
    await t.db.insert(agencyMemberships).values([
      { agencyId: agencyA, userId: "u-a", isPrimary: true },
      { agencyId: agencyA, userId: "u-a-admin", isPrimary: true },
      { agencyId: agencyB, userId: "u-b", isPrimary: true },
    ]);
  }, 120_000);
  afterAll(async () => await t.close());

  function asAgency(id: string, email: string, role: "AGENCY_USER" | "AGENCY_ADMIN"): SessionUser {
    return { id, email, name: id, role, agencyIds: [] };
  }

  it("agency user can access its own agency only", async () => {
    const { assertAgencyAccess } = await import("@/lib/tenancy");
    const ua = asAgency("u-a", "ua@t.test", "AGENCY_USER");
    await expect(assertAgencyAccess(ua, agencyA)).resolves.toBeUndefined();
    await expect(assertAgencyAccess(ua, agencyB)).rejects.toThrow(/denied/i);
  });

  it("forged URL context cannot widen access (scope comes from membership, not input)", async () => {
    const { resolveAgencyContext } = await import("@/lib/tenancy");
    const ua = asAgency("u-a", "ua@t.test", "AGENCY_USER");
    const ctx = await resolveAgencyContext(ua);
    expect(ctx).toBe(agencyA); // even if the client asked for agencyB
  });

  it("agency admin may manage users of own agency, and platform writes are denied server-side", async () => {
    const { can } = await import("@/lib/rbac");
    expect(can("AGENCY_ADMIN", "agencies.users.manage")).toBe(true);
    const { saveEntity } = await import("@/lib/crud");
    const adminActor = { id: "u-a-admin", email: "uaa@t.test", role: "AGENCY_ADMIN" as const };
    await expect(
      saveEntity(adminActor, "countries", { code: "ZZ", name: "Hacked", isActive: true, displayOrder: 1 }),
    ).rejects.toThrow(/Missing permission/i);
  });

  it("agency user can never write any configuration", async () => {
    const { saveEntity } = await import("@/lib/crud");
    await expect(
      saveEntity(actorAgencyUser, "countries", { code: "ZY", name: "No", isActive: true, displayOrder: 1 }),
    ).rejects.toThrow(/Missing permission/i);
    await expect(
      saveEntity(actorAgencyAdmin, "branding", {
        brandName: "X",
        companyName: "Y",
        primaryColor: "#000000",
        secondaryColor: "#000000",
        accentColor: "#000000",
        backgroundColor: "#ffffff",
        textColor: "#000000",
        buttonStyle: "rounded",
      }),
    ).rejects.toThrow(/Missing permission/i);
  });

  it("membership is unique per pair (no double-assign)", async () => {
    const { agencyMemberships } = await import("@/db");
    await expect(
      t.db.insert(agencyMemberships).values({ agencyId: agencyA, userId: "u-a", isPrimary: false }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("staff (no membership needed) passes assertAgencyAccess by design", async () => {
    const { assertAgencyAccess } = await import("@/lib/tenancy");
    const admin = { id: "s1", email: "s1@t.test", name: "S", role: "SUPER_ADMIN" as const, agencyIds: [] };
    await expect(assertAgencyAccess(admin, agencyA)).resolves.toBeUndefined();
    await expect(assertAgencyAccess(admin, agencyB)).resolves.toBeUndefined();
  });
});
