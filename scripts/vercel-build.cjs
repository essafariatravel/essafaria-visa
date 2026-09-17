const { execFileSync } = require("node:child_process");

function run(cmd, args) {
  console.log(`[vercel-build] ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", env: process.env });
}

// The production database is migrated during the Vercel build so a fresh
// Supabase project cannot deploy an application against an empty schema.
// The seed is deliberately opt-in: never create a predictable administrator
// password merely because a deployment was triggered.
run(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "scripts/migrate.ts"]);

if (process.env.SEED_ADMIN_PASSWORD && process.env.SEED_AGENCY_PASSWORD) {
  run(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "scripts/seed.ts"]);
} else {
  console.log("[vercel-build] seed skipped (set SEED_ADMIN_PASSWORD and SEED_AGENCY_PASSWORD to bootstrap demo accounts)");
}

run(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "build"]);
