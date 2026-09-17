import path from "node:path";
import { loadEnv } from "@/lib/load-env";
import { env } from "@/lib/env";

/**
 * Applies drizzle-kit generated SQL migrations (./drizzle) to the resolved
 * PostgreSQL target — real Postgres via DATABASE_URL, or embedded PGlite in
 * the sandbox. Identical SQL either way; drizzle records applied files in
 * its __drizzle_migrations table.
 */
async function main() {
  loadEnv();
  const config = env();
  const migrationsFolder = path.resolve(process.cwd(), "drizzle");

  if (config.dbMode === "postgres") {
    const { loadPg } = await import("@/lib/pg-driver");
    const { Pool } = await loadPg();
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const pool = new Pool({ connectionString: config.DATABASE_URL });
    await migrate(drizzle(pool as never), { migrationsFolder });
    await pool.end();
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const { mkdirSync } = await import("node:fs");
    const dataDir = path.resolve(process.cwd(), config.PGLITE_DATA_DIR);
    mkdirSync(path.dirname(dataDir), { recursive: true });
    const { acquireWriterLock } = await import("@/lib/pglite-writer-lock");
    acquireWriterLock(dataDir, "npm run db:migrate");
    const client = new PGlite(dataDir);
    await migrate(drizzle(client), { migrationsFolder });
    await client.close();
  }
  console.log(`[migrate] ok (mode=${config.dbMode})`);
}

main().catch((err) => {
  console.error("[migrate] FAILED", err);
  process.exit(1);
});
