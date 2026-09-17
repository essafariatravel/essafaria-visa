import { loadEnv } from "@/lib/load-env";
import { dispatchDueEmails, deliveryStats } from "@/lib/notifications";
import { resolveTransportName } from "@/lib/email-transport";

/**
 * Outbox dispatcher: claim QUEUED email intents and hand them to the configured
 * transport. Safe to run repeatedly and concurrently — claiming uses
 * SELECT … FOR UPDATE SKIP LOCKED, delivery state is conditional, and each
 * intent carries an idempotency key, so a retry cannot send twice.
 *
 *   npm run outbox:drain            one pass (up to 25 messages)
 *   OUTBOX_LIMIT=100 npm run outbox:drain
 *
 * Exit codes: 0 = nothing failed, 1 = at least one delivery failed (so a cron
 * or CI step can alert), which is the point of recording attempts at all.
 */
async function main() {
  loadEnv();
  const transport = resolveTransportName();
  const limit = Math.min(200, Number(process.env.OUTBOX_LIMIT ?? 25) || 25);
  console.log(`[outbox] transport=${transport} limit=${limit}`);
  if (transport === "none") {
    const stats = await deliveryStats();
    console.log(
      "[outbox] no transport configured — intents are recorded as SKIPPED by design. Set EMAIL_TRANSPORT=file (local .eml) or smtp (needs a provider client). Stats:",
      JSON.stringify(stats),
    );
    return;
  }
  const res = await dispatchDueEmails(limit);
  const stats = await deliveryStats();
  console.log(`[outbox] claimed=${res.claimed} sent=${res.sent} failed=${res.failed}`, "state:", JSON.stringify(stats));
  if (res.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[outbox] FAILED", err instanceof Error ? err.message : err);
  process.exit(1);
});
