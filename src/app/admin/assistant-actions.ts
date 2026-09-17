"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/session";
import { buildStaffActor } from "@/lib/guard";
import { can } from "@/lib/rbac";
import { describeDomainError } from "@/lib/ops";
import { acceptSuggestion, analyseApplication, dismissSuggestion, draftCommunication, runDocumentExtraction } from "@/lib/ai";

/* ============================================================
 * Assistant actions (staff only).
 *
 * Note what is NOT here: no accept/reject of a visa, no document decision, no
 * charge, no configuration write. The assistant can only produce analysis and
 * proposals; the one write it can cause (accepting an extracted field value)
 * goes through the ordinary applicant service as the named human.
 * ============================================================ */

function flash(path: string, kind: "ok" | "err", message: string): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}flash=${encodeURIComponent(`${kind}:${message}`.slice(0, 400))}`);
}

async function staffActor(permission: "ai.use" | "applications.write" | "communications.write") {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!can(user.role, permission) || !["SUPER_ADMIN", "ADMIN", "VISA_AGENT", "ACCOUNTING"].includes(user.role)) {
    redirect("/login?error=forbidden");
  }
  return buildStaffActor(user, permission);
}

export async function runAnalysisAction(fd: FormData): Promise<void> {
  const applicationId = String(fd.get("applicationId") ?? "");
  const path = `/admin/applications/${applicationId}/assistant`;
  const actor = await staffActor("ai.use");
  try {
    const res = await analyseApplication(actor, applicationId);
    revalidatePath(path);
    flash(
      path,
      "ok",
      `Analysed with ${res.provider}: ${res.missing.length} outstanding, ${res.inconsistencies.length} flagged, ${res.nextActions.length} suggested action(s). Nothing was changed.`,
    );
  } catch (err) {
    flash(path, "err", describeDomainError(err).message);
  }
}

export async function runExtractionAction(fd: FormData): Promise<void> {
  const documentId = String(fd.get("documentId") ?? "");
  const applicationId = String(fd.get("applicationId") ?? "");
  const path = `/admin/applications/${applicationId}/assistant`;
  const actor = await staffActor("ai.use");
  try {
    const res = await runDocumentExtraction(actor, documentId);
    revalidatePath(path);
    const n = Object.keys(res.fields).length;
    flash(
      path,
      "ok",
      res.injectionSuspected
        ? `Instruction-like text was found inside the document content. It was ignored and flagged; ${n} value(s) were read as data.`
        : `${n} value(s) read at ${res.confidence}% confidence — review each before accepting.`,
    );
  } catch (err) {
    flash(path, "err", describeDomainError(err).message);
  }
}

export async function acceptSuggestionAction(fd: FormData): Promise<void> {
  const applicationId = String(fd.get("applicationId") ?? "");
  const path = `/admin/applications/${applicationId}/assistant`;
  const actor = await staffActor("applications.write");
  try {
    const res = await acceptSuggestion(actor, String(fd.get("suggestionId") ?? ""));
    revalidatePath(path);
    revalidatePath(`/admin/applications/${applicationId}`);
    flash(path, "ok", res.message);
  } catch (err) {
    flash(path, "err", describeDomainError(err).message);
  }
}

export async function dismissSuggestionAction(fd: FormData): Promise<void> {
  const applicationId = String(fd.get("applicationId") ?? "");
  const path = `/admin/applications/${applicationId}/assistant`;
  const actor = await staffActor("applications.write");
  try {
    await dismissSuggestion(actor, String(fd.get("suggestionId") ?? ""), (fd.get("reason") as string) || null);
    revalidatePath(path);
    flash(path, "ok", "Dismissed — the proposal stays in the audit trail");
  } catch (err) {
    flash(path, "err", describeDomainError(err).message);
  }
}

export async function generateDraftAction(fd: FormData): Promise<void> {
  const applicationId = String(fd.get("applicationId") ?? "");
  const path = `/admin/applications/${applicationId}/assistant`;
  const actor = await staffActor("communications.write");
  try {
    const purpose = (fd.get("purpose") as "MISSING_DOCUMENTS" | "STATUS_UPDATE" | "FOLLOW_UP") ?? "STATUS_UPDATE";
    const res = await draftCommunication(actor, applicationId, purpose);
    revalidatePath(path);
    redirect(`${path}?draft=${encodeURIComponent(res.runId)}&flash=${encodeURIComponent(`ok:Draft composed from the configured ${purpose} template — nothing was sent`)}`);
  } catch (err) {
    flash(path, "err", describeDomainError(err).message);
  }
}
