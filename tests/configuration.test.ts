import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, actorSuperAdmin } from "./helpers";

/* Configuration service: create, update, activate/deactivate, reorder,
 * validation rejections, and audit-log coupling. */

describe("configuration CRUD (spec §2–§13)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb(); // also points getDb() at the test db
    await t.seed();
    // Actor must exist so audit_logs.actor_id FK holds.
    const { users } = await import("@/db");
    await t.db.insert(users).values({
      id: "test-admin",
      email: "test-admin@essafaria.local",
      name: "Test Admin",
      passwordHash: "scrypt$1$1$1$aa$bb",
      role: "SUPER_ADMIN",
    });
  }, 120_000);
  afterAll(async () => await t.close());

  async function crud() {
    return import("@/lib/crud");
  }

  it("creates a new country that immediately appears in listings", async () => {
    const { saveEntity, listEntities } = await crud();
    await saveEntity(actorSuperAdmin, "countries", { code: "CH", name: "Switzerland", isActive: true, displayOrder: 99 });
    const rows = await listEntities("countries");
    const ch = rows.find((r) => r.code === "CH");
    expect(ch).toBeTruthy();
    // FK-safe: create a visa type for the NEW country — proves config is live data
    const { countries, visaTypes } = await import("@/db");
    const [row] = await t.db.select().from(countries).where(eq(countries.code, "CH"));
    await saveEntity(actorSuperAdmin, "visa-types", {
      code: "CH_SCHENGEN_TOUR",
      name: "Switzerland — Schengen Tourism",
      countryId: row.id,
      processingTimeDays: 14,
      isActive: true,
      isFeatured: false,
      displayOrder: 99,
    });
    const [vt] = await t.db.select().from(visaTypes).where(eq(visaTypes.code, "CH_SCHENGEN_TOUR"));
    expect(vt).toBeTruthy();
  });

  it("rejects invalid colors, malformed codes and unsafe hrefs (spec §34)", async () => {
    const { saveEntity } = await crud();
    // hex color enforced
    await expect(
      saveEntity(actorSuperAdmin, "statuses", { code: "BAD1", label: "X", color: "red", isActive: true, displayOrder: 1 }),
    ).rejects.toThrow(/color/i);
    // code shape enforced
    await expect(
      saveEntity(actorSuperAdmin, "statuses", { code: "bad color!", label: "X", color: "#112233", isActive: true, displayOrder: 1 }),
    ).rejects.toThrow(/Code/);
    // javascript: href rejected by navigation schema
    await expect(
      saveEntity(actorSuperAdmin, "navigation", { location: "HEADER", label: "Evil", href: "javascript:alert(1)", isActive: true, displayOrder: 1 }),
    ).rejects.toThrow(/javascript|internal path/i);
  });

  it("renaming a visa type keeps its id stable (history safety, §23)", async () => {
    const { saveEntity } = await crud();
    const { visaTypes, visaRequirements } = await import("@/db");
    const [before] = await t.db.select().from(visaTypes).where(eq(visaTypes.code, "FR_SCHENGEN_TOURISM"));
    await saveEntity(
      actorSuperAdmin,
      "visa-types",
      {
        code: "FR_SCHENGEN_TOURISM",
        name: "France — Tourism Visa (Renamed)",
        countryId: before.countryId,
        processingTimeDays: before.processingTimeDays,
        isActive: true,
        isFeatured: true,
        displayOrder: 0,
      },
      before.id,
    );
    const [after] = await t.db.select().from(visaTypes).where(eq(visaTypes.code, "FR_SCHENGEN_TOURISM"));
    expect(after.id).toBe(before.id);
    expect(after.name).toContain("Renamed");
    // requirements still attached (history intact)
    const reqs = await t.db.select().from(visaRequirements).where(eq(visaRequirements.visaTypeId, after.id));
    expect(reqs.length).toBeGreaterThan(0);
  });

  it("deactivate/reactivate round-trip + audit trail written atomically", async () => {
    const { setEntityActive } = await crud();
    const { countries, auditLogs } = await import("@/db");
    const [gr] = await t.db.select().from(countries).where(eq(countries.code, "GR"));
    await setEntityActive(actorSuperAdmin, "countries", gr.id, false);
    const [grOff] = await t.db.select().from(countries).where(eq(countries.id, gr.id));
    expect(grOff.isActive).toBe(false);
    await setEntityActive(actorSuperAdmin, "countries", gr.id, true);
    const [grOn] = await t.db.select().from(countries).where(eq(countries.id, gr.id));
    expect(grOn.isActive).toBe(true);
    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityType, "country"))
      .orderBy(auditLogs.createdAt);
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(audits.some((a) => a.action === "DEACTIVATE")).toBe(true);
    expect(audits.some((a) => a.action === "REACTIVATE")).toBe(true);
    expect(audits.every((a) => a.actorId === "test-admin")).toBe(true);
  });

  it("reordering swaps neighbours only", async () => {
    const { saveEntity, moveEntity } = await crud();
    await saveEntity(actorSuperAdmin, "countries", { code: "AT", name: "Austria", isActive: true, displayOrder: 1000 });
    const { countries } = await import("@/db");
    const [at] = await t.db.select().from(countries).where(eq(countries.code, "AT"));
    const before = (await t.db.select().from(countries).orderBy(countries.displayOrder)).map((c) => c.code);
    await moveEntity(actorSuperAdmin, "countries", at.id, "up");
    const after = (await t.db.select().from(countries).orderBy(countries.displayOrder)).map((c) => c.code);
    expect(before[before.length - 1]).toBe("AT");
    expect(after[after.length - 1]).not.toBe("AT");
    expect(after[after.length - 2]).toBe("AT");
  });

  it("duplicate codes fail with unique-violation, not silent update", async () => {
    const { saveEntity } = await crud();
    await expect(
      saveEntity(actorSuperAdmin, "currencies", { code: "EUR", name: "Euro Copy", symbol: "€", isBase: false, isActive: true }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("branding singleton: save twice → one row, latest wins", async () => {
    const { saveEntity } = await crud();
    await saveEntity(actorSuperAdmin, "branding", {
      brandName: "ESSAFARIA",
      companyName: "Essafaria Travel",
      tagline: "One",
      primaryColor: "#000000",
      secondaryColor: "#111111",
      accentColor: "#222222",
      backgroundColor: "#ffffff",
      textColor: "#000000",
      buttonStyle: "rounded",
    });
    await saveEntity(actorSuperAdmin, "branding", {
      brandName: "ESSAFARIA",
      companyName: "Essafaria Travel",
      tagline: "Two",
      primaryColor: "#0E7A6D",
      secondaryColor: "#13315C",
      accentColor: "#D9A441",
      backgroundColor: "#F7F5F0",
      textColor: "#1B2430",
      buttonStyle: "pill",
    });
    const { brandSettings } = await import("@/db");
    const all = await t.db.select().from(brandSettings);
    expect(all.length).toBe(1);
    expect(all[0].tagline).toBe("Two");
    expect(all[0].buttonStyle).toBe("pill");
  });
});
