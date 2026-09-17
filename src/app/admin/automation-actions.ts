"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/session";
import { buildStaffActor } from "@/lib/guard";
import { can } from "@/lib/rbac";
import { describeDomainError } from "@/lib/ops";
import { runAllTasks, runTask } from "@/lib/automation";

function flash(path: string, kind: "ok" | "err", message: string): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}flash=${encodeURIComponent(`${kind}:${message}`.slice(0, 300))}`);
}

async function actor(force: boolean) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!can(user.role, "automation.run")) flash("/admin/automation", "err", "Not allowed");
  return buildStaffActor(user, force ? "settings.write" : "automation.run");
}

function summarise(results: Array<{ task: string; ran: boolean; skippedReason?: string; result: Record<string, number | string>; error: string | null }>): string {
  return results
    .map((r) => {
      if (!r.ran) return `${r.task}: skipped (${r.skippedReason ?? "already ran today"})`;
      if (r.error) return `${r.task}: failed (${r.error})`;
      const detail = Object.entries(r.result).map(([k, v]) => `${k}=${v}`).join(" ");
      return `${r.task}: ${detail || "done"}`;
    })
    .join(" · ");
}

export async function runTaskAction(fd: FormData): Promise<void> {
  const force = fd.get("force") === "1";
  const a = await actor(force);
  try {
    const res = await runTask(a, String(fd.get("task") ?? ""), { force });
    revalidatePath("/admin/automation");
    revalidatePath("/admin");
    flash(
      "/admin/automation",
      res.error ? "err" : "ok",
      res.ran ? (res.error ? `${res.task} failed: ${res.error}` : `${res.task}: ${Object.entries(res.result).map(([k, v]) => `${k}=${v}`).join(" ") || "done"}`) : `${res.task} skipped — ${res.skippedReason}`,
    );
  } catch (err) {
    flash("/admin/automation", "err", describeDomainError(err).message);
  }
}

export async function runAllAction(fd: FormData): Promise<void> {
  const force = fd.get("force") === "1";
  const a = await actor(force);
  try {
    const results = await runAllTasks(a, { force });
    revalidatePath("/admin/automation");
    revalidatePath("/admin");
    revalidatePath("/agency/inbox");
    flash("/admin/automation", "ok", summarise(results));
  } catch (err) {
    flash("/admin/automation", "err", describeDomainError(err).message);
  }
}
