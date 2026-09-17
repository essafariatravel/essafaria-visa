import { loadEnv } from "@/lib/load-env";
import { env } from "@/lib/env";
import { runAllTasks, TASKS } from "@/lib/automation";
import { systemActor } from "@/lib/system-actor";

/**
 * Automation entry point for cron / CI:
 *
 *   npm run automation:run                 every task, one claim per day
 *   AUTOMATION_TASK=stale-files npm run automation:run
 *   AUTOMATION_FORCE=1 npm run automation:run   ignore today's claim
 *
 * Runs as a SYSTEM actor: it holds no human identity, so anything that requires
 * a person (visa decisions, money movement, gate overrides) is not reachable
 * from here. Exit code 1 if any task failed, so a scheduler can alert.
 */
async function main() {
  loadEnv();
  const only = process.env.AUTOMATION_TASK ?? null;
  const force = process.env.AUTOMATION_FORCE === "1";
  const actor = await systemActor();
  const keys = only ? [only] : Object.keys(TASKS);
  const results = [];
  for (const key of keys) {
    if (!TASKS[key]) {
      console.error(`[automation] unknown task ${key}`);
      process.exitCode = 1;
      return;
    }
    const res = await (await import("@/lib/automation")).runTask(actor, key, { force });
    results.push(res);
    console.log(
      `[automation] ${res.task} ${res.ran ? (res.error ? `FAILED ${res.error}` : `ok ${Object.entries(res.result).map(([k, v]) => `${k}=${v}`).join(" ")}`) : `skipped (${res.skippedReason})`}`,
    );
  }
  if (results.some((r: { error: string | null }) => r.error)) process.exitCode = 1;
  void env;
}

main().catch((err) => {
  console.error("[automation] FAILED", err instanceof Error ? err.message : err);
  process.exit(1);
});
