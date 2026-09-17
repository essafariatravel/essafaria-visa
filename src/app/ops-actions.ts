"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  applicationCreateSchema,
  applicationUpdateSchema,
  applicantUpsertSchema,
  statusTransitionSchema,
} from "@/lib/validation";
import { getSessionUser } from "@/lib/session";
import { buildActor } from "@/lib/guard";
import { can, type Permission } from "@/lib/rbac";
import { describeDomainError } from "@/lib/ops";
import {
  appendNote,
  assignCaseOfficer,
  createApplication,
  transitionStatus,
  updateApplication,
} from "@/lib/applications";
import { removeApplicant, upsertApplicant } from "@/lib/applicants";
import { requestMissingDocuments, reviewDocument, uploadDocument, withdrawDocument } from "@/lib/documents";

/* ============================================================
 * Server actions for the operational screens (both portals).
 *
 * These are the ONLY write paths the UI uses, and every one of them:
 *   1. takes identity from the session, never from a form field
 *   2. declares the capability it needs (a button being hidden is not a rule)
 *   3. validates the payload with the same zod schemas the API uses
 *   4. delegates to the service — which owns tenancy, state and money rules
 *
 * Staff may name an agency in a form (`__agencyId`); for an agency user that
 * field is ignored, because buildActor pins them to their own membership.
 * ============================================================ */

function toRecord(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

function back(fd: FormData, fallback: string): string {
  const raw = fd.get("__back");
  const value = typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") ? raw : fallback;
  return value.slice(0, 200);
}

function flash(path: string, kind: "ok" | "err", message: string): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}flash=${encodeURIComponent(`${kind}:${message}`)}`);
}

async function actor(permission: Permission, fd: FormData) {
  const user = await getSessionUser();
  if (!user) {
    // No session: send them to login rather than leaking why the action failed.
    redirect("/login");
  }
  const named = fd.get("__agencyId");
  return buildActor(user, permission, {
    onBehalfOfAgencyId: typeof named === "string" && named ? named : null,
  });
}

function detailPath(actor: { isStaff: boolean }, id: string): string {
  return actor.isStaff ? `/admin/applications/${id}` : `/agency/applications/${id}`;
}

function fail(err: unknown, path: string): never {
  const { message, issues } = describeDomainError(err);
  flash(path, "err", issues?.length ? `${message} — ${issues.join("; ")}` : message);
}

/* ---------------- application ---------------- */

export async function createApplicationAction(fd: FormData): Promise<void> {
  const path = back(fd, "/agency/applications");
  let a: Awaited<ReturnType<typeof actor>>;
  try {
    a = await actor("applications.write", fd);
  } catch {
    redirect("/login");
  }
  const parsed = applicationCreateSchema.safeParse({
    ...toRecord(fd),
    agencyId: a.isStaff ? (fd.get("agencyId") as string) || null : null,
  });
  if (!parsed.success) {
    fail(
      { name: "ValidationError", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
      path,
    );
  }
  const d = parsed.data as Record<string, unknown>;
  try {
    const created = await createApplication(a, {
      visaTypeCode: (d.visaTypeCode as string) || null,
      visaTypeId: (d.visaTypeId as string) || null,
      requestedCount: Number(d.requestedCount ?? 1),
      priorityCode: (d.priorityCode as string) || null,
      travelDate: (d.travelDate as string) || null,
      notes: (d.notes as string) || null,
      agencyId: (d.agencyId as string) || null,
    });
    // add the first traveller in the same submit if the form carried one
    const firstName = String(d.applicantFullName ?? "").trim();
    if (firstName) {
      const ap = applicantUpsertSchema.safeParse({
        fullName: firstName,
        dateOfBirth: d["applicant.dateOfBirth"] ?? "",
        gender: d["applicant.gender"] ?? "",
        nationalityCountryCode: d["applicant.nationalityCountryCode"] ?? "",
        passportNumber: d["applicant.passportNumber"] ?? "",
        passportIssueDate: d["applicant.passportIssueDate"] ?? "",
        passportExpiryDate: d["applicant.passportExpiryDate"] ?? "",
        intendedEntryDate: d["applicant.intendedEntryDate"] ?? "",
        intendedExitDate: d["applicant.intendedExitDate"] ?? "",
        email: d["applicant.email"] ?? "",
        phone: d["applicant.phone"] ?? "",
        isPrimary: true,
      });
      if (ap.success) {
        await upsertApplicant(a, created.id, ap.data as never);
      } else {
        revalidatePath(detailPath(a, created.id));
        flash(
          detailPath(a, created.id),
          "err",
          `File ${created.reference} was created, but the traveller needs attention: ${ap.error.issues.map((i) => i.message).join("; ")}`,
        );
      }
    }
    revalidatePath("/agency/applications");
    revalidatePath("/admin/applications");
    flash(detailPath(a, created.id), "ok", `Application ${created.reference} created`);
  } catch (err) {
    fail(err, path);
  }
}

export async function updateApplicationAction(fd: FormData): Promise<void> {
  const id = String(fd.get("__applicationId") ?? "");
  const path = back(fd, `/admin/applications/${id}`);
  const a = await actor("applications.write", fd);
  const raw = toRecord(fd);
  const patch: Record<string, unknown> = {};
  for (const key of ["requestedCount", "priorityId", "travelDate", "notes", "caseOfficerUserId", "consulateRef", "staffNotes"]) {
    if (raw[key] !== undefined) patch[key] = raw[key] === "" ? null : raw[key];
  }
  if (!id) fail(new Error("Missing application id"), path);
  const parsed = applicationUpdateSchema.safeParse(patch);
  if (!parsed.success) {
    fail({ name: "ValidationError", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, path);
  }
  try {
    await updateApplication(a, id, parsed.data as never);
    revalidatePath(path);
    flash(path, "ok", "Saved");
  } catch (err) {
    fail(err, path);
  }
}

export async function transitionAction(fd: FormData): Promise<void> {
  const id = String(fd.get("__applicationId") ?? "");
  const path = back(fd, `/admin/applications/${id}`);
  const permission: Permission = fd.get("forceOverride") ? "applications.override" : "applications.submit";
  const a = await actor(permission, fd);
  const parsed = statusTransitionSchema.safeParse({
    toStatusCode: fd.get("toStatusCode") ?? "",
    reason: fd.get("reason") ?? "",
  });
  if (!parsed.success) {
    fail({ name: "ValidationError", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, path);
  }
  try {
    const res = await transitionStatus(a, id, {
      toStatusCode: (parsed.data as { toStatusCode: string }).toStatusCode,
      reason: (parsed.data as { reason?: string }).reason ?? null,
      forceOverride: Boolean(fd.get("forceOverride")),
    });
    revalidatePath(path);
    revalidatePath("/admin/applications");
    revalidatePath("/agency/applications");
    flash(
      path,
      "ok",
      res.overrodeGate ? `Moved to ${res.toStatusCode} with a recorded override` : `Moved to ${res.toStatusCode}`,
    );
  } catch (err) {
    fail(err, path);
  }
}

/* ---------------- applicants ---------------- */

export async function upsertApplicantAction(fd: FormData): Promise<void> {
  const id = String(fd.get("__applicationId") ?? "");
  const applicantId = (fd.get("__applicantId") as string) || null;
  const path = back(fd, `/agency/applications/${id}`);
  const a = await actor("applications.write", fd);
  const rec = toRecord(fd);
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) if (!k.startsWith("__")) clean[k] = v;
  const parsed = applicantUpsertSchema.safeParse(clean);
  if (!parsed.success) {
    fail(
      { name: "ValidationError", issues: parsed.error.issues.map((i) => `${i.path.join(".") || "field"}: ${i.message}`) },
      path,
    );
  }
  try {
    const res = await upsertApplicant(a, id, parsed.data as never, applicantId);
    revalidatePath(path);
    flash(path, "ok", applicantId ? "Applicant updated" : `Applicant added`);
    void res;
  } catch (err) {
    fail(err, path);
  }
}

export async function removeApplicantAction(fd: FormData): Promise<void> {
  const id = String(fd.get("__applicationId") ?? "");
  const applicantId = String(fd.get("__applicantId") ?? "");
  const path = back(fd, `/agency/applications/${id}`);
  const a = await actor("applications.write", fd);
  try {
    await removeApplicant(a, id, applicantId, (fd.get("reason") as string) || null);
    revalidatePath(path);
    flash(path, "ok", "Applicant removed from the file");
  } catch (err) {
    fail(err, path);
  }
}

/* ---------------- notes / assignment ---------------- */

export async function appendNoteAction(fd: FormData): Promise<void> {
  const id = String(fd.get("__applicationId") ?? "");
  const path = back(fd, `/agency/applications/${id}`);
  const a = await actor("applications.write", fd);
  try {
    await appendNote(a, id, {
      body: String(fd.get("body") ?? ""),
      customerVisible: Boolean(fd.get("customerVisible")),
    });
    revalidatePath(path);
    flash(path, "ok", "Message recorded on the file");
  } catch (err) {
    fail(err, path);
  }
}

export async function assignAction(fd: FormData): Promise<void> {
  const id = String(fd.get("__applicationId") ?? "");
  const path = back(fd, `/admin/applications/${id}`);
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!can(user.role, "applications.assign")) flash(path, "err", "You may not assign files");
  const a = buildActor(user, "applications.assign");
  try {
    await assignCaseOfficer(a, id, (fd.get("userId") as string) || null);
    revalidatePath(path);
    flash(path, "ok", "Assignment updated");
  } catch (err) {
    fail(err, path);
  }
}

/* ---------------- documents (Phase 5) ---------------- */

export async function uploadDocumentAction(fd: FormData): Promise<void> {
  const id = String(fd.get("__applicationId") ?? "");
  const path = back(fd, `/agency/applications/${id}/documents`);
  const a = await actor("documents.upload", fd);
  const entry = fd.get("file");
  if (!entry || typeof entry === "string") fail(new Error("Choose a file to upload"), path);
  const file = entry as File;
  if (!file.size) fail(new Error("That file is empty"), path);
  const bytes = Buffer.from(await file.arrayBuffer());
  try {
    const res = await uploadDocument(a, id, {
      bytes,
      filename: file.name,
      claimedMime: file.type,
      documentTypeCode: (fd.get("documentTypeCode") as string) || null,
      documentTypeId: (fd.get("documentTypeId") as string) || null,
      applicantId: (fd.get("applicantId") as string) || null,
      agencyNotes: (fd.get("agencyNotes") as string) || null,
      source: a.isStaff ? "BACK_OFFICE" : "PORTAL",
    });
    revalidatePath(path);
    flash(
      path,
      "ok",
      res.satisfiesRequirement
        ? `Uploaded ${file.name} (version ${res.version})${res.supersededDocumentId ? ", replacing the previous copy" : ""}`
        : `Attached ${file.name} to the file. It is not a checklist item, so nothing was satisfied.`,
    );
  } catch (err) {
    fail(err, path);
  }
}

export async function reviewDocumentAction(fd: FormData): Promise<void> {
  const documentId = String(fd.get("__documentId") ?? "");
  const applicationId = String(fd.get("__applicationId") ?? "");
  const path = back(fd, `/admin/applications/${applicationId}/documents`);
  const a = await actor("applications.review", fd);
  try {
    await reviewDocument(a, documentId, {
      decision: (fd.get("decision") as "ACCEPT" | "REJECT" | "NEEDS_REPLACEMENT") ?? "ACCEPT",
      note: (fd.get("note") as string) || null,
      rejectionCode: (fd.get("rejectionCode") as string) || null,
      requireValidityDays: fd.get("requireValidityDays") ? Number(fd.get("requireValidityDays")) : null,
    });
    revalidatePath(path);
    flash(path, "ok", "Decision recorded and the agency notified");
  } catch (err) {
    fail(err, path);
  }
}

export async function requestDocumentsAction(fd: FormData): Promise<void> {
  const id = String(fd.get("__applicationId") ?? "");
  const path = back(fd, `/admin/applications/${id}/documents`);
  const a = await actor("applications.write", fd);
  try {
    const res = await requestMissingDocuments(a, id, (fd.get("note") as string) || null);
    revalidatePath(path);
    flash(path, "ok", res.requested ? `Asked the agency for ${res.requested} outstanding item(s)` : "Nothing outstanding — the checklist is complete");
  } catch (err) {
    fail(err, path);
  }
}

export async function withdrawDocumentAction(fd: FormData): Promise<void> {
  const documentId = String(fd.get("__documentId") ?? "");
  const applicationId = String(fd.get("__applicationId") ?? "");
  const path = back(fd, `/admin/applications/${applicationId}/documents`);
  const a = await actor("applications.review", fd);
  try {
    await withdrawDocument(a, documentId, (fd.get("reason") as string) || "");
    revalidatePath(path);
    flash(path, "ok", "Document withdrawn from the checklist");
  } catch (err) {
    fail(err, path);
  }
}

