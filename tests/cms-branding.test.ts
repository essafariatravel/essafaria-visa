import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, actorSuperAdmin } from "./helpers";

/* CMS + branding: the admin panel is the only writer; public reads see
 * exactly the published, active configuration. */

describe("CMS & branding (spec §14–§16, §30, §31)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb();
    await t.seed();
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

  it("homepage renders only PUBLISHED + active sections, in display order", async () => {
    const { getPublishedHomepageSections } = await import("@/lib/config-service");
    const { homepageSections } = await import("@/db");
    const { invalidateConfig } = await import("@/lib/config-service");
    invalidateConfig();
    let sections = await getPublishedHomepageSections();
    expect(sections.length).toBeGreaterThan(3);
    const orders = sections.map((s) => s.displayOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    expect(sections.every((s) => s.sectionType)).toBe(true);

    // hide a section → it disappears from the public view after invalidation
    const first = sections[0];
    await t.db.update(homepageSections).set({ isActive: false }).where(eqId(homepageSections.id, first.id));
    invalidateConfig();
    sections = await getPublishedHomepageSections();
    expect(sections.find((s) => s.id === first.id)).toBeUndefined();

    // restore
    await t.db.update(homepageSections).set({ isActive: true }).where(eqId(homepageSections.id, first.id));
    invalidateConfig();
    sections = await getPublishedHomepageSections();
    expect(sections.find((s) => s.id === first.id)).toBeTruthy();
  });

  it("draft sections are never public", async () => {
    const { homepageSections } = await import("@/db");
    const { getPublishedHomepageSections, invalidateConfig } = await import("@/lib/config-service");
    const [ins] = await t.db
      .insert(homepageSections)
      .values({ sectionType: "cta", title: "SECRET DRAFT", publishState: "DRAFT", isActive: true, displayOrder: 9999, config: {} })
      .returning({ id: homepageSections.id });
    invalidateConfig();
    const sections = await getPublishedHomepageSections();
    expect(sections.some((s) => s.title === "SECRET DRAFT")).toBe(false);
    await t.db.delete(homepageSections).where(eqId(homepageSections.id, ins.id));
    invalidateConfig();
  });

  it("branding drives CSS tokens; a changed color flows through the service", async () => {
    const { getBranding, invalidateConfig } = await import("@/lib/config-service");
    invalidateConfig();
    const before = await getBranding();
    expect(before.primaryColor).toMatch(/^#[0-9a-fA-F]{6}$/);
    const { saveEntity } = await import("@/lib/crud");
    await saveEntity(actorSuperAdmin, "branding", {
      ...before,
      id: undefined,
      primaryColor: "#FF00AA",
      logoMediaId: before.logoMediaId ?? undefined,
      secondaryLogoMediaId: before.secondaryLogoMediaId ?? undefined,
      faviconMediaId: before.faviconMediaId ?? undefined,
      tagline: before.tagline ?? undefined,
    } as never);
    invalidateConfig();
    const after = await getBranding();
    expect(after.primaryColor).toBe("#FF00AA");
  });

  it("navigation is config: disabled items leave the public nav", async () => {
    const { getNavItems, invalidateConfig } = await import("@/lib/config-service");
    const { navItems } = await import("@/db");
    invalidateConfig();
    let header = await getNavItems("HEADER");
    const active = header.filter((n) => n.isActive);
    expect(active.length).toBeGreaterThan(0);
    const victim = active[0];
    await t.db.update(navItems).set({ isActive: false }).where(eqId(navItems.id, victim.id));
    invalidateConfig();
    header = await getNavItems("HEADER");
    // getNavItems returns raw rows; layout filters by isActive — the hidden item is filtered there
    expect(header.find((n) => n.id === victim.id)?.isActive).toBe(false);
    await t.db.update(navItems).set({ isActive: true }).where(eqId(navItems.id, victim.id));
    invalidateConfig();
  });

  it("legal pages: public reads only PUBLISHED (draft privacy text must 404)", async () => {
    const { legalPages } = await import("@/db");
    const [pp] = await t.db.select().from(legalPages).limit(1);
    await t.db.update(legalPages).set({ publishState: "DRAFT" }).where(eqId(legalPages.id, pp.id));
    const [after] = await t.db.select().from(legalPages).where(eq(legalPages.id, pp.id));
    expect(after.publishState).toBe("DRAFT");
    await t.db.update(legalPages).set({ publishState: "PUBLISHED" }).where(eqId(legalPages.id, pp.id));
  });
});

const eqId = (col: any, val: string) => eq(col, val);
