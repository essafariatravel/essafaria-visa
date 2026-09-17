import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import type { Database } from "@/db";

/**
 * A test database handle.
 *
 * The two drivers return slightly different concrete types (PgliteDatabase vs
 * NodePgDatabase), so the helper normalises to the app's `Database` shape with a
 * permissive `execute`, which is what the suites use for raw SQL assertions.
 */
export type TestDb = Omit<Database, "execute"> & {
  execute: (query: unknown) => Promise<{ rows: Array<Record<string, any>> }>;
};

/* ============================================================
 * Test database helper: a fresh, migrated Postgres per test FILE.
 *
 * Default — PGlite in memory: the same engine and the SAME SQL migration files the
 * app applies in production, no external service, nothing shared between files.
 *
 * `TEST_DB=postgres` — each test file instead creates its own randomly named
 * database on a real PostgreSQL *server*, migrates it, and drops it afterwards.
 * This exists because the claim "the locking and concurrency logic is
 * PostgreSQL-correct" can only be shown against a server that many connections
 * reach at once; a single embedded instance cannot demonstrate that.
 *
 *   TEST_DB=postgres npm test
 *   TEST_DATABASE_URL=postgresql://user:pass@host:5432/postgres TEST_DB=postgres npm test
 *
 * The target user needs CREATE DATABASE. The application's own database is never
 * touched, so a run cannot corrupt anything a person is looking at.
 * ============================================================ */

export async function createTestDb(): Promise<{
  db: TestDb;
  close: () => Promise<void>;
  seed: () => Promise<{ inserted: number; skipped: number }>;
}> {
  const { schema, __setDbOverride } = await import("@/db");
  const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
  const seedWith =
    (db: Database & TestDb) =>
    async (): Promise<{ inserted: number; skipped: number }> => {
      const { seed } = await import("@/db/seed");
      return seed(db);
    };

  if (process.env.TEST_DB === "postgres") {
    const { loadPg } = await import("@/lib/pg-driver");
    const { Pool } = await loadPg();
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");

    const adminUrl = process.env.TEST_DATABASE_URL ?? "postgresql://essafaria@127.0.0.1:55432/postgres";
    const admin = new Pool({ connectionString: adminUrl, max: 2 });
    const name = `esf_test_${crypto.randomBytes(5).toString("hex")}`;
    await admin.query(`create database ${name}`);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: url.toString(), max: 10 });
    const raw = drizzle(pool as never, { schema });
    await migrate(raw, { migrationsFolder });
    const db = raw as unknown as Database & TestDb;
    __setDbOverride(db);

    return {
      db,
      seed: seedWith(db),
      close: async () => {
        __setDbOverride(null);
        // Teardown races are expected: a client still finishing a query when the
        // database is dropped is terminated with 57P01 (admin_shutdown). Silence
        // it and retry the drop — otherwise a green suite is reported as an
        // unhandled error, which in CI reads like a failure.
        pool.on("error", () => {});
        await pool.end().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 50));
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            await admin.query(`drop database ${name}${attempt >= 5 ? " with (force)" : ""}`);
            break;
          } catch (e) {
            if (attempt === 9) console.warn(`[test-db] could not drop ${name}: ${(e as Error).message}`);
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        await admin.end().catch(() => undefined);
      },
    };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite("memory://");
  const raw = drizzle(client, { schema });
  await migrate(raw, { migrationsFolder });
  const db = raw as unknown as Database & TestDb;
  // Route app-level getDb() calls at this test instance.
  __setDbOverride(db);

  return {
    db,
    close: async () => {
      __setDbOverride(null);
      await client.close();
    },
    seed: seedWith(db),
  };
}

export const actorSuperAdmin = { id: "test-admin", email: "test-admin@essafaria.local", role: "SUPER_ADMIN" as const };
export const actorAgencyUser = { id: "test-ag-user", email: "test-ag-user@essafaria.local", role: "AGENCY_USER" as const };
export const actorAgencyAdmin = { id: "test-ag-admin", email: "test-ag-admin@essafaria.local", role: "AGENCY_ADMIN" as const };
export const actorAccounting = { id: "test-accounting", email: "test-accounting@essafaria.local", role: "ACCOUNTING" as const };

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
