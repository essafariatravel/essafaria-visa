import { and, desc, eq, lt, sql } from "drizzle-orm";
import { agencies, applicationStatuses, getDb, sessions, taskRuns, users, visaApplications, type Database } from "@/db";
import { assertActorPermission, auditIn, affectedRows } from "@/lib/ops";
import { withTx } from "@/lib/with-tx";
import { getSettingIn } from "@/lib/config-service";
import { notify } from "@/lib/notifications";
import { expireDueDocuments } from "@/lib/documents";
import { raiseLowBalanceAlert, reconcileWallets } from "@/lib/billing";
import { dispatchDueEmails } from "@/lib/notifications";
import { purgeLoginAttempts } from "@/lib/security";
import type { OpActor } from "@/lib/guard";

type Q = any;

/* ============================================================
 * Operational automation (Phase 10).
 *
 * Rules that make this safe to put on a cron:
 *   • one run per task per day, enforced by a UNIQUE (task_key, run_key) row
 *     that is claimed BEFORE the work starts — a second worker gets "already
 *     ran" instead of duplicating notifications;
 *   • every task is idempotent anyway (expiry sweep only touches accepted rows,
 *     alerts dedupe by day, outbox claims rows with FOR UPDATE SKIP LOCKED);
 *   • automation only ever notifies, flags or expires. It never approves,
 *     refuses, reprices or charges;
 *   • the whole thing can be switched off from Settings → Operations.
 * ============================================================ */

export interface TaskDef {
  key: string;
  label: string;
  description: string;
  /** the shared database handle — tasks open their own transactions inside */
  run: (t: Q) => Promise<Record<string, number | string>>;
}

export const TASKS: Record<string, TaskDef> = {
  "document-expiry": {
    key: "document-expiry",
    label: "Expire out-of-date documents",
    description:
      "Accepted documents past their configured validity window stop satisfying the checklist, the agency is told, and the file returns to “documents outstanding”.",
    run: async () => {
      const res = await expireDueDocuments();
      return { expired: res.expired };
    },
  },
  "low-balances": {
    key: "low-balances",
    label: "Low wallet balance alerts",
    description: "Notifies accounting for agencies below the configured floor, and reports any header/ledger drift.",
    run: async (t) => {
      const rows = (await t
        .select({ id: agencies.id })
        .from(agencies)) as Array<{ id: string }>;
      let alerted = 0;
      for (const a of rows) if (await raiseLowBalanceAlert(t, a.id)) alerted++;
      const drift = (await reconcileWallets()).filter((r) => !r.consistent);
      if (drift.length) {
        await notify(
          {
            staffOnly: true,
            audienceRole: "ACCOUNTING",
            kind: "WALLET_DRIFT",
            title: `Wallet ledger drift on ${drift.length} agency account(s)`,
            body: drift.map((d) => `${d.agencyCode}: header ${d.balanceCents} vs ledger ${d.ledgerSumCents}`).join("\n"),
            link: "/admin/wallet",
            severity: "WARNING",
            dedupeKey: `WALLET_DRIFT:${new Date().toISOString().slice(0, 10)}`,
          },
        );
      }
      return { alerted, drifted: drift.length };
    },
  },
  "stale-files": {
    key: "stale-files",
    label: "Flag stale files",
    description: "Reminds the assigned officer (or the desk) about open files with no activity beyond the configured threshold.",
    run: async (t) => {
      const days = Number(await getSettingIn<number>(t, "ops.staleAfterDays", 7)) || 7;
      const cutoff = new Date(Date.now() - days * 86_400_000);
      const rows = (await t
        .select({
          id: visaApplications.id,
          reference: visaApplications.reference,
          agencyId: visaApplications.agencyId,
          officer: visaApplications.caseOfficerUserId,
          caseOfficerEmail: users.email,
        })
        .from(visaApplications)
        .innerJoin(applicationStatuses, eq(applicationStatuses.id, visaApplications.statusId))
        .leftJoin(users, eq(users.id, visaApplications.caseOfficerUserId))
        .where(
          and(
            eq(applicationStatuses.isTerminal, false),
            lt(visaApplications.lastActivityAt, cutoff),
            eq(visaApplications.gateOverridden, false),
          ),
        )
        .orderBy(desc(visaApplications.lastActivityAt))
        .limit(200)) as unknown as Array<{ id: string; reference: string; agencyId: string; officer: string | null; caseOfficerEmail: string | null }>;
      let reminded = 0;
      for (const r of rows) {
        await notify(
          {
            staffOnly: true,
            ...(r.officer ? { userIds: [r.officer] } : { audienceRole: "VISA_AGENT" }),
            applicationId: r.id,
            agencyId: r.agencyId,
            kind: "FILE_STALE",
            title: `${r.reference} has had no activity for ${days}+ days`,
            body: "Move it forward or ask the agency for what is missing.",
            link: `/admin/applications/${r.id}`,
            severity: "ACTION_REQUIRED",
            dedupeKey: `FILE_STALE:${r.id}:${new Date().toISOString().slice(0, 10)}`,
          },
        );
        reminded++;
      }
      return { reminded, thresholdDays: days };
    },
  },
  "outbox-drain": {
    key: "outbox-drain",
    label: "Dispatch queued email",
    description: "Claims QUEUED delivery intents and hands them to the configured transport, with retries and backoff.",
    run: async () => {
      const res = await dispatchDueEmails(50);
      return { claimed: res.claimed, sent: res.sent, failed: res.failed };
    },
  },
  "session-purge": {
    key: "session-purge",
    label: "Purge expired sessions and login counters",
    description:
      "Deletes session rows past their expiry (so a stolen cookie stops being useful once the row is gone) and trims login-attempt counters older than a week.",
    run: async (t) => {
      const res = await t.delete(sessions).where(lt(sessions.expiresAt, new Date()));
      const attempts = await purgeLoginAttempts(7);
      return { sessionsDeleted: affectedRows(res), attemptRowsPruned: attempts };
    },
  },
  "daily-digest": {
    key: "daily-digest",
    label: "Daily desk digest",
    description: "One summary of open volume, blocked files and money issues for the desk and accounting.",
    run: async (t) => {
      const counts = (await t
        .select({
          open: sql<number>`count(*) filter (where ${applicationStatuses.isTerminal} = false)::int`,
          blocked: sql<number>`count(*) filter (where ${applicationStatuses.isTerminal} = false and ${visaApplications.checklistComplete} = false)::int`,
          overridden: sql<number>`count(*) filter (where ${applicationStatuses.isTerminal} = false and ${visaApplications.gateOverridden} = true)::int`,
        })
        .from(visaApplications)
        .innerJoin(applicationStatuses, eq(applicationStatuses.id, visaApplications.statusId))) as Array<Record<string, number>>;
      const c = counts[0] ?? { open: 0, blocked: 0, overridden: 0 };
      const negatives = (await t
        .select({ n: sql<number>`count(*)::int` })
        .from(agencies)
        .where(sql`${agencies.walletBalanceCents} < 0`)) as Array<{ n: number }>;
      await notify(
        {
          staffOnly: true,
          audienceRole: "ADMIN",
          kind: "DAILY_DIGEST",
          title: `Daily digest — ${c.open} open, ${c.blocked} blocked`,
          body: `Open files: ${c.open}. Waiting on documents: ${c.blocked}. Gate-overridden and still open: ${c.overridden}. Negative wallets: ${Number(negatives[0]?.n ?? 0)}.`,
          link: "/admin",
          severity: "INFO",
          dedupeKey: `DAILY_DIGEST:${new Date().toISOString().slice(0, 10)}`,
        },
      );
      return { ...c, negativeWallets: Number(negatives[0]?.n ?? 0) };
    },
  },
};

export interface TaskResult {
  task: string;
  ran: boolean;
  skippedReason?: string;
  result: Record<string, number | string>;
  startedAt: string;
  finishedAt: string;
  error: string | null;
}

function runKeyFor(key: string, force: boolean): string {
  const day = new Date().toISOString().slice(0, 10);
  return force ? `${day}T${Date.now()}` : day;
}

/**
 * Claim a daily slot, then run. The claim is a plain INSERT against the unique
 * (task_key, run_key) index — so two workers racing on the same midnight can
 * only produce one execution.
 */
export async function runTask(actor: OpActor, taskKey: string, opts: { force?: boolean } = {}): Promise<TaskResult> {
  const def = TASKS[taskKey];
  if (!def) throw new Error(`Unknown automation task: ${taskKey}`);
  assertActorPermission(actor, "automation.run");
  const t0: Q = await getDb();
  const enabled = await getSettingIn<boolean>(t0, "ops.automationEnabled", true);
  if (enabled === false && !opts.force) {
    return {
      task: taskKey,
      ran: false,
      skippedReason: "automation disabled in Settings → Operations",
      result: {},
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: null,
    };
  }
  const runKey = runKeyFor(taskKey, Boolean(opts.force));
  const startedAt = new Date();

  // 1. claim the day. A single INSERT against UNIQUE(task_key, run_key): two
  //    workers racing at midnight produce one execution, not two.
  const claim = await withTx(async (tx: Database) => {
    const t: Q = tx;
    const claimed = (await t
      .insert(taskRuns)
      .values({ taskKey, runKey, status: "RUNNING" })
      .onConflictDoNothing()
      .returning({ id: taskRuns.id })) as Array<{ id: string }>;
    return claimed[0]?.id ?? null;
  });
  if (!claim) {
    return {
      task: taskKey,
      ran: false,
      skippedReason: `already ran for ${runKey}`,
      result: {},
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      error: null,
    };
  }

  // 2. run OUTSIDE the claim transaction. Tasks manage their own transactions;
  //    holding one across the whole run would both nest (refused by withTx) and
  //    deadlock the embedded driver the moment a helper opens its own connection.
  let result: Record<string, number | string> = {};
  let error: string | null = null;
  try {
    result = await def.run(t0);
  } catch (err) {
    error = String((err as Error).message).slice(0, 500);
  }

  // 3. record the outcome (its own short transaction, with the audit row)
  await withTx(async (tx: Database) => {
    const t: Q = tx;
    await t
      .update(taskRuns)
      .set({ status: error ? "FAILED" : "COMPLETED", result, errorMessage: error, finishedAt: new Date() })
      .where(eq(taskRuns.id, claim));
    await auditIn(tx, {
      actor,
      action: "UPDATE",
      entityType: "task_run",
      entityId: claim,
      metadata: { task: taskKey, runKey, result, error, forced: Boolean(opts.force) },
    });
  });

  return { task: taskKey, ran: true, result, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), error };
}

export async function runAllTasks(actor: OpActor, opts: { force?: boolean } = {}): Promise<TaskResult[]> {
  const out: TaskResult[] = [];
  for (const key of Object.keys(TASKS)) {
    out.push(await runTask(actor, key, opts));
  }
  return out;
}

export interface TaskRunView {
  id: string;
  taskKey: string;
  runKey: string;
  status: string;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export async function recentRuns(limit = 25): Promise<TaskRunView[]> {
  const t: Q = await getDb();
  const rows = (await t
    .select()
    .from(taskRuns)
    .orderBy(desc(taskRuns.startedAt))
    .limit(Math.min(100, Math.max(1, limit)))) as Array<typeof taskRuns.$inferSelect>;
  return rows.map((r) => ({
    id: r.id,
    taskKey: r.taskKey,
    runKey: r.runKey,
    status: r.status,
    result: (r.result ?? null) as Record<string, unknown> | null,
    errorMessage: r.errorMessage ?? null,
    startedAt: String(r.startedAt),
    finishedAt: r.finishedAt ? String(r.finishedAt) : null,
  }));
}
