import { loadEnv } from "@/lib/load-env";
import { getDb } from "@/db";

/** CLI wrapper around the seed module. Idempotent — safe to re-run. */
async function main() {
  loadEnv();
  const { seed } = await import("@/db/seed");
  const db = await getDb();
  const result = await seed(db);
  console.log(`[seed] inserted=${result.inserted} skipped(existing)=${result.skipped}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed] FAILED", err);
  process.exit(1);
});
