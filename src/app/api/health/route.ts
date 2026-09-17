import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getBranding } from "@/lib/config-service";
import { deliveryStats } from "@/lib/notifications";
import { gmailStatus } from "@/lib/gmail";
import { aiStatus } from "@/lib/ai";
import { resolveTransportName } from "@/lib/email-transport";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

const STARTED = Date.now();

/**
 * Health/readiness. Counts only — no emails, no names, no tokens.
 * `degraded` is reported when a subsystem is misconfigured rather than lying
 * about being healthy (for example the outbox has a queue but no transport).
 */
export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string | number }> = {};
  let dbOk = false;
  const counts: Record<string, number> = {};
  try {
    const db = await getDb();
    const t = db as unknown as { execute: (q: unknown) => Promise<{ rows?: Array<Record<string, string | number>> }> };
    const ping = await t.execute(sql`select 1 as ok`);
    dbOk = Number((ping.rows?.[0]?.ok ?? 0)) === 1;
    const row = (await t.execute(
      sql`select
        (select count(*) from visa_applications)::int as applications,
        (select count(*) from visa_applications va join application_statuses st on st.id = va.status_id where st.is_terminal = false)::int as open_applications,
        (select count(*) from visa_applications va join application_statuses st on st.id = va.status_id where st.is_terminal = false and va.checklist_complete = false)::int as waiting_on_documents,
        (select count(*) from application_documents where is_current = true and review_state = 'PENDING')::int as documents_to_review,
        (select count(*) from agencies)::int as agencies,
        (select count(*) from agencies where wallet_balance_cents < 0)::int as negative_wallets,
        (select count(*) from notification_deliveries where state = 'QUEUED')::int as queued_deliveries,
        (select count(*) from notification_deliveries where state = 'FAILED')::int as failed_deliveries,
        (select count(*) from task_runs where status = 'FAILED')::int as failed_task_runs,
        (select count(*) from gmail_messages where requires_review = true)::int as mail_awaiting_review`,
    )).rows?.[0];
    for (const [k, v] of Object.entries(row ?? {})) counts[k] = Number(v ?? 0);
  } catch (err) {
    checks.database = { ok: false, detail: "unreachable" };
    void err;
  }
  if (dbOk) checks.database = { ok: true };
  let brandingOk = true;
  try {
    await getBranding();
  } catch {
    brandingOk = false;
  }
  checks.configuration = { ok: brandingOk, detail: brandingOk ? "loaded" : "branding unreadable" };
  const deliveries = dbOk ? await deliveryStats().catch(() => ({} as Record<string, number>)) : {};
  const transport = resolveTransportName();
  const queued = Number(deliveries.QUEUED ?? 0);
  checks.email = {
    ok: !(queued > 0 && transport === "none"),
    detail: `${transport}${queued ? ` · ${queued} queued` : ""}`,
  };
  checks.automation = {
    ok: Number(counts.failed_task_runs ?? 0) === 0,
    detail: `${counts.failed_task_runs ?? 0} failed run(s)`,
  };
  checks.gmail = { ok: true, detail: gmailStatus().provider };
  checks.ai = { ok: true, detail: aiStatus().provider };
  const storageConfig = env();
  checks.storage =
    storageConfig.MEDIA_PROVIDER === "supabase"
      ? {
          ok: Boolean(storageConfig.SUPABASE_URL && storageConfig.SUPABASE_SERVICE_ROLE_KEY),
          detail: `supabase/${storageConfig.SUPABASE_STORAGE_BUCKET}`,
        }
      : { ok: true, detail: "local" };
  checks.databaseMode = { ok: true, detail: env().dbMode };

  const degraded = Object.values(checks).some((c) => !c.ok);
  return NextResponse.json(
    {
      status: degraded ? "degraded" : "ok",
      uptimeSeconds: Math.floor((Date.now() - STARTED) / 1000),
      counts,
      checks,
      serverTime: new Date().toISOString(),
    },
    { status: degraded ? 503 : 200, headers: { "Cache-Control": "no-store" } },
  );
}
