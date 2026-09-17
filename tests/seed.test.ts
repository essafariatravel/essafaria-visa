import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb } from "./helpers";

/* Seed: baseline business configuration exists and re-running is safe. */

describe("seed (spec §35 — idempotency)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb();
  }, 120_000);
  afterAll(async () => await t.close());

  it("first run inserts, second run is a strict no-op", async () => {
    const r1 = await t.seed();
    expect(r1.inserted).toBeGreaterThan(50);
    const snapshot = await t.db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM countries)::int        AS countries,
        (SELECT COUNT(*) FROM visa_types)::int       AS visa_types,
        (SELECT COUNT(*) FROM visa_requirements)::int AS requirements,
        (SELECT COUNT(*) FROM application_statuses)::int AS statuses,
        (SELECT COUNT(*) FROM users)::int            AS users,
        (SELECT COUNT(*) FROM agencies)::int         AS agencies,
        (SELECT COUNT(*) FROM homepage_sections)::int AS sections
    `);
    const counts1 = (snapshot as { rows: Record<string, number>[] }).rows[0];

    const r2 = await t.seed();
    expect(r2.inserted).toBe(0);
    const snapshot2 = await t.db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM countries)::int        AS countries,
        (SELECT COUNT(*) FROM visa_types)::int       AS visa_types,
        (SELECT COUNT(*) FROM visa_requirements)::int AS requirements,
        (SELECT COUNT(*) FROM application_statuses)::int AS statuses,
        (SELECT COUNT(*) FROM users)::int            AS users,
        (SELECT COUNT(*) FROM agencies)::int         AS agencies,
        (SELECT COUNT(*) FROM homepage_sections)::int AS sections
    `);
    const counts2 = (snapshot2 as { rows: Record<string, number>[] }).rows[0];
    expect(counts2).toEqual(counts1);
  });

  it("seed does not overwrite admin-edited values on re-run", async () => {
    const { countries } = await import("@/db");
    const [fr] = await t.db
      .select()
      .from(countries)
      .where(sql`upper(code) = 'FR'`)
      .limit(1);
    await t.db.update(countries).set({ name: "France (edited)" }).where(eq2(countries.id, fr.id));
    await t.seed();
    const [after] = await t.db.select().from(countries).where(eq2(countries.id, fr.id));
    expect(after.name).toBe("France (edited)");
  });

  it("baseline covers the acceptance checklist", async () => {
    const counts = (
      await t.db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM visa_categories)::int   AS cats,
        (SELECT COUNT(*) FROM document_types)::int    AS docs,
        (SELECT COUNT(*) FROM currencies)::int        AS curr,
        (SELECT COUNT(*) FROM visa_fees)::int         AS fees,
        (SELECT COUNT(*) FROM priorities)::int        AS prio,
        (SELECT COUNT(*) FROM communication_templates)::int AS tmpl,
        (SELECT COUNT(*) FROM site_settings)::int     AS settings,
        (SELECT COUNT(*) FROM nav_items)::int         AS nav,
        (SELECT COUNT(*) FROM legal_pages)::int       AS legal,
        (SELECT COUNT(*) FROM brand_settings)::int    AS brand
    `)
    ).rows[0] as Record<string, number>;
    expect(counts.cats).toBeGreaterThanOrEqual(5);
    expect(counts.docs).toBeGreaterThanOrEqual(8);
    expect(counts.curr).toBeGreaterThanOrEqual(3);
    expect(counts.fees).toBeGreaterThanOrEqual(10);
    expect(counts.prio).toBe(4);
    expect(counts.tmpl).toBeGreaterThanOrEqual(6);
    expect(counts.settings).toBeGreaterThanOrEqual(10);
    expect(counts.nav).toBeGreaterThanOrEqual(4);
    expect(counts.legal).toBeGreaterThanOrEqual(3);
    expect(counts.brand).toBe(1);
  });
});

function eq2(col: unknown, val: unknown) {
  // tiny helper avoids importing eq at module scope twice
  return sql`${col as never} = ${val as never}`;
}
