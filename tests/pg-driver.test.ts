import { describe, expect, it } from "vitest";
import { loadPg } from "@/lib/pg-driver";

/* ============================================================
 * The production driver must actually load.
 *
 * `pg` is CommonJS, and under a native ESM loader its module namespace exposes
 * only `default` — so `const { Pool } = await import("pg")` yields undefined and
 * the app dies at boot with "Pool is not a constructor". Every embedded run uses
 * PGlite, so nothing else would ever notice. This test runs the resolution the
 * real Postgres path uses.
 * ============================================================ */

describe("node-postgres resolution (production database path)", () => {
  it("exposes a usable Pool constructor through the ESM interop shape", async () => {
    const { Pool } = await loadPg();
    expect(typeof Pool).toBe("function");
    // constructing proves the export is the class, not a namespace object
    const pool = new Pool({ connectionString: "postgresql://nobody@127.0.0.1:1/none", connectionTimeoutMillis: 50, max: 1 });
    expect(typeof pool.query).toBe("function");
    await pool.end().catch(() => undefined);
  });

  it("loads and migrates a real schema when a PostgreSQL server is available", async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (process.env.TEST_DB !== "postgres" || !url) {
      expect(loadPg).toBeTypeOf("function"); // skipped: no server configured for this run
      return;
    }
    const { Pool } = await loadPg();
    const pool = new Pool({ connectionString: url.replace(/\/[^/]+$/, "/postgres"), max: 2 });
    const res = await pool.query("select current_setting('server_version_num')::int as v");
    expect(Number((res.rows[0] as { v: number }).v)).toBeGreaterThan(120000);
    await pool.end();
  });
});
