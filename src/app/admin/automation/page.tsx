import { desc, eq } from "drizzle-orm";
import { getDb, taskRuns } from "@/db";
import { EmptyState, PageHeader, Badge } from "@/components/admin/ui";
import { Notice, Panel } from "@/components/ops/ui";
import { TASKS, recentRuns } from "@/lib/automation";
import { staffActorForPage } from "@/lib/page-auth";
import { can } from "@/lib/rbac";
import { getSetting } from "@/lib/config-service";
import { runAllAction, runTaskAction } from "@/app/admin/automation-actions";

export const dynamic = "force-dynamic";

type Q = any;

/**
 * Automation control. Each task is one row per day (unique claim), switchable
 * from Settings → Operations, and safe to run twice.
 */
export default async function AutomationPage({ searchParams }: { searchParams: { flash?: string } }) {
  const actor = await staffActorForPage("automation.run");
  const mayRun = can(actor.role, "automation.run");
  const enabled = await getSetting<boolean>("ops.automationEnabled", true);
  const runs = await recentRuns(20);
  const t: Q = await getDb();
  const today = new Date().toISOString().slice(0, 10);
  const doneToday = (await t
    .select({ taskKey: taskRuns.taskKey })
    .from(taskRuns)
    .where(eq(taskRuns.runKey, today))) as Array<{ taskKey: string }>;
  const done = new Set(doneToday.map((d) => d.taskKey));
  void desc;
  void eq;
  const flash = searchParams.flash ? decodeURIComponent(searchParams.flash).replace(/^(ok|err):/, "") : null;

  return (
    <div className="pb-16">
      <PageHeader
        title="Automation"
        subtitle="Reminders, expiry sweeps, queue draining and housekeeping. Nothing here approves, refuses, reprices or charges — those stay with people."
        action={
          mayRun ? (
            <form action={runAllAction}>
              <button type="submit" className="btn-brand text-sm">
                Run all due tasks
              </button>
            </form>
          ) : null
        }
      />
      {flash ? (
        <div className="mb-4">
          <Notice kind={searchParams.flash?.startsWith("err") ? "error" : "info"}>{flash}</Notice>
        </div>
      ) : null}
      {enabled === false ? (
        <div className="mb-4">
          <Notice kind="warn">Automation is switched off in Settings → Operations. Tasks below still run if you force them.</Notice>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Tasks">
          <ul className="divide-y divide-slate-100">
            {Object.values(TASKS).map((task) => (
              <li key={task.key} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                    {task.label}
                    {done.has(task.key) ? <Badge tone="green">ran today</Badge> : <Badge tone="slate">due</Badge>}
                  </p>
                  <p className="mt-0.5 max-w-prose text-[11px] leading-snug text-slate-500">{task.description}</p>
                </div>
                {mayRun ? (
                  <div className="flex shrink-0 gap-2">
                    <form action={runTaskAction}>
                      <input type="hidden" name="task" value={task.key} />
                      <button type="submit" className="rounded-md border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100">
                        Run
                      </button>
                    </form>
                    <form action={runTaskAction}>
                      <input type="hidden" name="task" value={task.key} />
                      <input type="hidden" name="force" value="1" />
                      <button type="submit" className="rounded-md border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-100">
                        Force
                      </button>
                    </form>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-slate-400">
            Cron example: <code className="rounded bg-slate-100 px-1">0 6 * * * cd /srv/essafaria &amp;&amp; npm run automation:run</code> — safe to overlap; a second worker skips.
          </p>
        </Panel>

        <Panel title="Recent runs" subtitle="Every execution is recorded, including its result payload.">
          {!runs.length ? (
            <EmptyState title="No runs recorded yet" />
          ) : (
            <ul className="divide-y divide-slate-100 text-xs">
              {runs.map((r) => (
                <li key={r.id} className="py-2">
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-slate-700">
                    {r.taskKey}
                    <Badge tone={r.status === "COMPLETED" ? "green" : r.status === "FAILED" ? "red" : "amber"}>{r.status.toLowerCase()}</Badge>
                    <span className="font-mono text-[10px] text-slate-400">{r.runKey}</span>
                  </p>
                  {r.result ? <p className="mt-0.5 text-[11px] text-slate-500">{Object.entries(r.result).map(([k, v]) => `${k}=${String(v)}`).join(" · ")}</p> : null}
                  {r.errorMessage ? <p className="mt-0.5 text-[11px] text-red-700">{r.errorMessage}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
