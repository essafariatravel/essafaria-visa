import { getInvoiceForApplication, getWallet, type InvoiceView, type WalletView } from "@/lib/billing";
import {
  availableTransitions,
  getApplication,
  getChecklist,
  listTimeline,
  type ApplicationView,
  type ChecklistBundle,
  type TimelineEntry,
  type TransitionOption,
} from "@/lib/applications";
import { listApplicants, type ApplicantView } from "@/lib/applicants";
import { priorityOptions, staffOptions } from "@/lib/options";
import type { OpActor } from "@/lib/guard";
import { notFound } from "next/navigation";

/* ============================================================
 * Page-level composition. Detail pages render fast and consistently by
 * loading everything the workspace shows in ONE place — five independent
 * queries issued in parallel, each of which re-proves tenancy inside.
 * ============================================================ */

export interface WorkspaceData {
  view: ApplicationView;
  checklist: ChecklistBundle;
  applicants: ApplicantView[];
  timeline: TimelineEntry[];
  transitions: TransitionOption[];
  invoice: InvoiceView | null;
  wallet: WalletView | null;
  staffOptions: Array<{ value: string; label: string }>;
  priorityOptions: Array<{ value: string; label: string }>;
}

export async function loadWorkspace(actor: OpActor, id: string): Promise<WorkspaceData> {
  const { view, app } = await getApplication(actor, id);
  const [checklist, applicants, timeline, transitions, invoice, priorities, staff] = await Promise.all([
    getChecklist(actor, id),
    listApplicants(actor, id),
    listTimeline(actor, id, { customerView: !actor.isStaff, limit: 40 }),
    availableTransitions(actor, id),
    getInvoiceForApplication(id),
    priorityOptions(),
    actor.isStaff ? staffOptions() : Promise.resolve([]),
  ]);
  // an agency may only ever see the wallet of its own agency — app.agencyId is
  // already tenant-proven by getApplication above
  const wallet = await getWallet(app.agencyId).catch(() => null);
  return {
    view,
    checklist,
    applicants,
    timeline,
    transitions,
    invoice,
    wallet,
    staffOptions: staff,
    priorityOptions: priorities,
  };
}

/** Safe wrapper for `/{portal}/applications/[id]`: an unknown or foreign id is
 *  a 404 page, never a 403 that confirms the row exists. */
export async function loadWorkspaceOr404(actor: OpActor, id: string | undefined): Promise<WorkspaceData> {
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound();
  try {
    return await loadWorkspace(actor, id);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const name = (err as { name?: string })?.name;
    if (code === "NOT_FOUND" || name === "NotFoundError" || name === "TenantError") notFound();
    throw err;
  }
}
