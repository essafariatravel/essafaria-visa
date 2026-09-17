import path from "node:path";
import * as schema from "./schema";
import { env } from "@/lib/env";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/* ============================================================
 * Driver abstraction
 *
 * PostgreSQL is the canonical database of ESSAFARIA VISA OS.
 *
 * dbMode = "postgres" (default whenever DATABASE_URL is set):
 *   node-postgres pool against a managed PostgreSQL instance.
 *   This is the production path.
 *
 * dbMode = "pglite" (explicit opt-in, sandbox/dev/tests only):
 *   PGlite — the same PostgreSQL engine (same SQL dialect, same
 *   indexes, constraints, enums) running embedded in-process from
 *   a file/memory location. It exists ONLY because this coding
 *   sandbox cannot run a Postgres server; it is not a product
 *   dependency. No business logic may rely on PGlite-specific
 *   behavior — the schema, migrations and every query here are
 *   plain, portable PostgreSQL.
 *
 * Same schema → same drizzle-kit generated SQL migrations → either
 * driver. Transitioning to managed Postgres is: set DATABASE_URL,
 * run `npm run db:migrate` + `npm run db:seed`, deploy. Nothing else.
 * ============================================================ */

export type Schema = typeof schema;
// Both drivers (node-postgres and PGlite) return a PgDatabase over the same
// schema. Drizzle's generic requires the query-result HKT first.
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

let dbPromise: Promise<Database> | null = null;
let dbOverride: Database | null = null;

/** Test seam: replace the resolved database (used by vitest integration
 * tests against a freshly migrated in-memory Postgres). No production code
 * path calls this. */
export function __setDbOverride(db: Database | null): void {
  dbOverride = db;
  dbPromise = null;
}

async function buildDb(): Promise<Database> {
  const config = env();
  if (config.dbMode === "postgres") {
    const { loadPg } = await import("@/lib/pg-driver");
    const { Pool } = await loadPg();
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({
      connectionString: config.DATABASE_URL,
      // Vercel serverless instances should keep a very small application-side
      // pool. Supabase's pooler handles fan-out between short-lived instances.
      max: process.env.VERCEL ? 1 : 10,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
    });
    return drizzle(pool as never, { schema });
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const dataDir = path.resolve(process.cwd(), config.PGLITE_DATA_DIR);
  // PGlite mkdirs the data dir itself but not parents — ensure .data exists.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.dirname(dataDir), { recursive: true });
  // One writer per data directory, or the cluster gets torn down under our feet.
  const { acquireWriterLock } = await import("@/lib/pglite-writer-lock");
  acquireWriterLock(dataDir, "essafaria-visa-os (app)");
  const client = new PGlite(dataDir);
  return drizzle(client, { schema });
}

/** Resolve the singleton DB handle for the current process. */
export function getDb(): Promise<Database> {
  if (dbOverride) return Promise.resolve(dbOverride);
  if (!dbPromise) dbPromise = buildDb();
  return dbPromise;
}

/** Fresh in-memory database (tests only). */
export async function createMemoryDb(): Promise<{ db: Database; close: () => Promise<void> }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  return { db, close: () => client.close() };
}

export { schema };
export * from "./schema";
