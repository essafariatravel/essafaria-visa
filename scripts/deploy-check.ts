import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "@/lib/load-env";
import { env } from "@/lib/env";

/**
 * Deployment preflight. Run it BEFORE trusting a deploy, and wire it into CI/CD so a
 * misconfiguration fails the release instead of the first request.
 *
 *   npm run deploy:check
 *   DATABASE_URL=postgresql://... npm run deploy:check
 *
 * Checks, in the order an operator would want them:
 *   environment  — parses under the same strict schema the app uses; names anything
 *                  that is missing, still a placeholder, or that the app cannot see
 *   database     — connects, runs a couple of real queries, and compares applied
 *                  migrations against drizzle/ (a pending migration is a hard fail)
 *   storage      — MEDIA_ROOT exists and is writable, because an unreadable media
 *                  root otherwise shows up as 500s on the first document open
 *   integrations — resolves the email transport and the AI/Gmail providers the same
 *                  way the runtime does, and says plainly when one is unconfigured
 *   secrets      — flags default/placeholder passwords and a missing or unstable
 *                  ESF_TOKEN_KEY (rotating it silently invalidates sealed Gmail tokens)
 *
 * Exit code 0 = safe to start. 1 = a blocking problem. Warnings never fail the run.
 */
type Verdict = "ok" | "warn" | "fail";
const results: Array<{ name: string; verdict: Verdict; detail: string }> = [];
function record(name: string, verdict: Verdict, detail: string): void {
  results.push({ name, verdict, detail });
  console.log(`  ${verdict === "ok" ? "OK  " : verdict === "warn" ? "WARN" : "FAIL"}  ${name.padEnd(34)} ${detail}`);
}

const PLACEHOLDERS = ["change-me", "changeme", "secret-here", "replace", "example.com"];
function looksPlaceholder(v: string | undefined): boolean {
  if (!v) return true;
  const l = v.toLowerCase();
  return PLACEHOLDERS.some((placeholder) => l.includes(placeholder));
}

async function main(): Promise<void> {
  loadEnv();
  console.log("\nESSAFARIA VISA OS — deployment preflight\n");

  /* ---- environment ---- */
  let config: ReturnType<typeof env>;
  try {
    config = env();
    record("environment parses", "ok", `dbMode=${config.dbMode}`);
  } catch (e) {
    record("environment parses", "fail", (e as Error).message.split("\n").slice(0, 3).join(" / "));
    process.exit(1);
    return;
  }

  if (config.dbMode === "postgres") {
    record("DATABASE_URL", "ok", "set — production driver in use");
  } else {
    record(
      "DATABASE_URL",
      config.DATABASE_URL ? "ok" : "fail",
      config.DATABASE_URL
        ? "set"
        : "unset — falling back to embedded PGlite, which is single-writer and NOT a production target",
    );
  }
  if (!config.SEED_ADMIN_PASSWORD || looksPlaceholder(config.SEED_ADMIN_PASSWORD)) {
    record("seed admin password", config.dbMode === "postgres" ? "fail" : "warn", "default/placeholder — seeded accounts would be guessable");
  } else {
    record("seed admin password", "ok", "non-default");
  }
  const tokenKey = process.env.ESF_TOKEN_KEY ?? "";
  if (tokenKey.length < 32) {
    record(
      "ESF_TOKEN_KEY",
      config.dbMode === "postgres" ? "fail" : "warn",
      "missing/short — Gmail tokens cannot be sealed and sessions cannot survive a restart",
    );
  } else {
    record("ESF_TOKEN_KEY", "ok", `${tokenKey.length} chars — keep it in the secret store; rotating it forces Gmail re-auth`);
  }
  if (config.REQUIRE_HTTPS === "true") record("REQUIRE_HTTPS", "ok", "plain HTTP will be refused");
  else if (config.REQUIRE_HTTPS === "false")
    record("REQUIRE_HTTPS", "warn", "explicitly off — plain HTTP is accepted; never do this on a public origin");
  else record("REQUIRE_HTTPS", config.dbMode === "postgres" ? "warn" : "ok", "not set — fine locally, set it behind TLS");
  record(
    "TRUST_PROXY_HEADERS",
    process.env.TRUST_PROXY_HEADERS === "false" ? "ok" : "warn",
    process.env.TRUST_PROXY_HEADERS === "false"
      ? "proxy headers ignored for the same-site check (app is directly exposed)"
      : "X-Forwarded-Host is trusted for CSRF — make sure a proxy sets and strips it",
  );

  /* ---- storage ---- */
  if (config.MEDIA_PROVIDER === "supabase") {
    const storageOk = Boolean(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY);
    record(
      "Supabase Storage",
      storageOk ? "ok" : "fail",
      storageOk ? `${config.SUPABASE_URL} / bucket=${config.SUPABASE_STORAGE_BUCKET}` : "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing",
    );
  } else {
    const mediaRoot = path.resolve(process.cwd(), config.MEDIA_ROOT);
    try {
      fs.mkdirSync(mediaRoot, { recursive: true });
      const probe = path.join(mediaRoot, `.deploy-check-${process.pid}`);
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
      record("MEDIA_ROOT writable", "ok", mediaRoot);
    } catch (e) {
      record("MEDIA_ROOT writable", "fail", `${mediaRoot}: ${(e as Error).message}`);
    }
  }

  /* ---- database ---- */
  try {
    const { getDb } = await import("@/db");
    const { sql } = await import("drizzle-orm");
    const t = (await getDb()) as unknown as { execute: (q: unknown) => Promise<{ rows: unknown[] }> };
    const version = await t.execute(sql`select current_setting('server_version_num')::int as v`);
    const vnum = Number((version.rows[0] as { v: number }).v);
    record(
      "database reachable",
      "ok",
      config.dbMode === "postgres"
        ? `PostgreSQL ${Math.floor(vnum / 10000)}.${Math.floor((vnum / 100) % 100)}`
        : `embedded PGlite (Postgres ${vnum}) — not a production target`,
    );

    /* the applied-migration ledger, counted against the files that ship in drizzle/.
       A pending migration is a hard fail: the app would otherwise start against a
       schema it does not know, and the first write tells you about it. */
    try {
      const applied = await t.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
      const n = Number((applied.rows[0] as { n: number }).n ?? 0);
      const folder = path.resolve(process.cwd(), "drizzle");
      const onDisk = fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => /^\d{4}_.*\.sql$/.test(f)) : [];
      record(
        "migrations applied",
        n < onDisk.length ? "fail" : "ok",
        n < onDisk.length
          ? `${n} applied, ${onDisk.length} shipped in drizzle/ — run npm run db:migrate before starting`
          : `${n} of ${onDisk.length} files`,
      );
    } catch (e) {
      record("migrations applied", "fail", `cannot read drizzle.__drizzle_migrations: ${(e as Error).message.split("\n")[0].slice(0, 90)}`);
    }

    const seeded = await t.execute(sql`select count(*)::int as n from visa_types`);
    const visaTypes = Number((seeded.rows[0] as { n: number }).n ?? 0);
    record("configuration seeded", visaTypes > 0 ? "ok" : "warn", `${visaTypes} visa types — empty means npm run db:seed has not run`);
  } catch (e) {
    record("database reachable", "fail", (e as Error).message.split("\n")[0].slice(0, 160));
  }

  /* ---- integrations ---- */
  const { resolveTransportName } = await import("@/lib/email-transport");
  const transport = resolveTransportName();
  record(
    "email transport",
    transport === "none" ? "warn" : "ok",
    transport === "none"
      ? "none — notifications are recorded as SKIPPED and nothing is sent"
      : transport === "file"
        ? "file — messages are written under MEDIA_ROOT/outbox and never leave the host (EMAIL_TRANSPORT=log resolves here too); fine for UAT, not for production"
        : `${transport}${transport === "smtp" && !config.SMTP_URL ? " — SMTP_URL missing!" : ""}`,
  );
  record("ai provider", config.AI_PROVIDER === "none" ? "warn" : "ok", config.AI_PROVIDER);
  record("gmail provider", config.GMAIL_PROVIDER === "none" || !config.GMAIL_PROVIDER ? "warn" : "ok", config.GMAIL_PROVIDER ?? "none");
  if (config.GMAIL_PROVIDER === "google") {
    const missing = [config.GMAIL_CLIENT_ID_REF, config.GMAIL_CLIENT_SECRET_REF].filter((ref) => !ref || !process.env[ref ?? ""]);
    record(
      "gmail credentials",
      missing.length ? "fail" : "ok",
      missing.length ? `env vars named but not set: ${missing.join(", ") || "(references missing)"}` : "references resolve",
    );
  }
  if (config.AI_PROVIDER !== "none" && config.AI_PROVIDER !== "rules") {
    const ref = config.AI_API_KEY_REF ?? "AI_API_KEY";
    record("ai credentials", process.env[ref] ? "ok" : "fail", `${ref} ${process.env[ref] ? "set" : "not set"}`);
  }

  /* ---- jobs ---- */
  record(
    "background jobs",
    config.dbMode === "postgres" ? "ok" : "warn",
    "outbox:drain + automation:run must be on a timer; with embedded PGlite they cannot run while the app holds the data directory",
  );

  const failed = results.filter((r) => r.verdict === "fail");
  const warned = results.filter((r) => r.verdict === "warn");
  console.log(`\n${results.length - failed.length - warned.length} ok, ${warned.length} warning(s), ${failed.length} blocking\n`);
  if (failed.length) {
    for (const f of failed) console.log(`  ! ${f.name}: ${f.detail}`);
    console.log("");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[deploy-check] crashed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
