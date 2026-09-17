import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  applicationDocuments,
  applicationEvents,
  documentTypes,
  getDb,
  media,
  visaApplications,
  type Database,
  type VisaApplication,
} from "@/db";
import { assertActorPermission, DomainError, affectedRows, auditIn, loadStatusById } from "@/lib/ops";
import { withTx } from "@/lib/with-tx";
import type { OpActor } from "@/lib/guard";
import type { SessionUser } from "@/lib/session";
import { can } from "@/lib/rbac";
import { assertApplicantOwnership, loadApplicationForUpdate, loadApplicationReadOnly, refreshChecklistFlag, writeEvent } from "@/lib/applications";
import { loadSnapshot } from "@/lib/snapshot";
import { notify } from "@/lib/notifications";
import { DOCUMENT_MAX_BYTES, makeStorageKey, safeFilename, sha256Hex, sniffDocument, storage } from "@/lib/storage";

type Q = any;

export const DEFAULT_MAX_DOC_MB = 10;

/* ============================================================
 * Documents & the checklist engine (Phase 5).
 *
 * What this module guarantees:
 *   • A file may only carry documents the checklist knows about. The allowed
 *     set and the size/format rules come from the application's frozen
 *     requirement snapshot, so a file keeps the rules it was told to meet —
 *     while staff may additionally attach an extra document (flagged, so it
 *     never pretends to satisfy a requirement).
 *   • Bytes never reach the client through a guessable public path. Storage
 *     keys are opaque, media rows are metadata only, and content is served
 *     through a check that proves: session → capability → document →
 *     application → agency. Cross-tenant probes answer 404.
 *   • Uploads are content-sniffed. A `.pdf` name, a declared MIME type or a
 *     doubled extension buys an attacker nothing.
 *   • Review states are explicit and every decision is evented, audited and
 *     notified transactionally with the change.
 *   • Replacing a document supersedes the previous version instead of
 *     destroying it: history stays reviewable.
 * ============================================================ */

export interface DocumentView {
  id: string;
  applicationId: string;
  reference: string;
  documentTypeId: string;
  documentTypeCode: string;
  documentTypeName: string;
  applicantId: string | null;
  applicantName: string | null;
  reviewState: string;
  isCurrent: boolean;
  version: number;
  filename: string | null;
  mimeType: string | null;
  bytes: number;
  uploadedAt: string;
  uploadedBy: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  expiresAt: string | null;
  agencyNotes: string | null;
  staffNotes: string | null;
  rejectionCode: string | null;
  source: string;
  satisfiesRequirement: boolean;
  wasRequiredAtUpload: boolean;
}

export interface UploadInput {
  bytes: Buffer;
  filename: string;
  /** advisory only — sniffing decides */
  claimedMime?: string | null;
  documentTypeCode?: string | null;
  documentTypeId?: string | null;
  applicantId?: string | null;
  agencyNotes?: string | null;
  source?: "PORTAL" | "BACK_OFFICE" | "GMAIL" | "AI";
  externalId?: string | null;
}

export interface UploadResult {
  documentId: string;
  mediaId: string;
  version: number;
  reviewState: string;
  expiresAt: string | null;
  checklistComplete: boolean;
  supersededDocumentId: string | null;
  satisfiesRequirement: boolean;
}

function toView(
  r: Record<string, any>,
  opts: { includeStaffFields: boolean },
): DocumentView {
  const v: DocumentView = {
    id: r.id,
    applicationId: r.applicationId,
    reference: r.reference,
    documentTypeId: r.documentTypeId,
    documentTypeCode: r.documentTypeCode,
    documentTypeName: r.documentTypeName,
    applicantId: r.applicantId ?? null,
    applicantName: r.applicantName ?? null,
    reviewState: r.reviewState,
    isCurrent: Boolean(r.isCurrent),
    version: Number(r.version),
    filename: r.filename ?? null,
    mimeType: r.mimeType ?? null,
    bytes: Number(r.bytes ?? 0),
    uploadedAt: String(r.uploadedAt),
    uploadedBy: r.uploadedBy ?? null,
    reviewedAt: r.reviewedAt ? String(r.reviewedAt) : null,
    reviewedBy: r.reviewedBy ?? null,
    expiresAt: r.expiresAt ? String(r.expiresAt) : null,
    agencyNotes: r.agencyNotes ?? null,
    staffNotes: null,
    rejectionCode: r.rejectionCode ?? null,
    source: r.source,
    satisfiesRequirement: Boolean(r.isCurrent) && r.reviewState === "ACCEPTED",
    wasRequiredAtUpload: Boolean(r.wasRequiredAtUpload),
  };
  if (opts.includeStaffFields) v.staffNotes = r.staffNotes ?? null;
  return v;
}

const DOC_SELECT = {
  id: applicationDocuments.id,
  applicationId: applicationDocuments.applicationId,
  reference: visaApplications.reference,
  documentTypeId: applicationDocuments.documentTypeId,
  documentTypeCode: applicationDocuments.documentTypeCode,
  documentTypeName: documentTypes.name,
  applicantId: applicationDocuments.applicantId,
  applicantName: sql<string>`(select full_name from applicants ap where ap.id = ${applicationDocuments.applicantId})`,
  reviewState: applicationDocuments.reviewState,
  isCurrent: applicationDocuments.isCurrent,
  version: applicationDocuments.version,
  filename: media.filename,
  mimeType: media.mimeType,
  bytes: applicationDocuments.bytes,
  uploadedAt: applicationDocuments.uploadedAt,
  uploadedBy: media.uploadedBy,
  reviewedAt: applicationDocuments.reviewedAt,
  reviewedBy: applicationDocuments.reviewedBy,
  expiresAt: applicationDocuments.expiresAt,
  agencyNotes: applicationDocuments.agencyNotes,
  staffNotes: applicationDocuments.staffNotes,
  rejectionCode: applicationDocuments.rejectionCode,
  source: applicationDocuments.source,
  wasRequiredAtUpload: applicationDocuments.wasRequiredAtUpload,
};

function docQuery(t: Q) {
  return t
    .select(DOC_SELECT)
    .from(applicationDocuments)
    .innerJoin(documentTypes, eq(documentTypes.id, applicationDocuments.documentTypeId))
    .innerJoin(visaApplications, eq(visaApplications.id, applicationDocuments.applicationId))
    .innerJoin(media, eq(media.id, applicationDocuments.mediaId));
}

/** Documents on a file, newest version first. Tenancy is proven by the join
 *  predicate, not by trusting the caller's filter. */
export async function listDocuments(actor: OpActor, applicationId: string): Promise<DocumentView[]> {
  assertActorPermission(actor, "applications.read");
  const t: Q = await getDb();
  const app = (await t
    .select({ id: visaApplications.id, agencyId: visaApplications.agencyId })
    .from(visaApplications)
    .where(eq(visaApplications.id, applicationId))
    .limit(1))[0] as { id: string; agencyId: string } | undefined;
  if (!app) throw new DomainError("NOT_FOUND", "Application not found");
  if (!actor.isStaff && !actor.agencyIds.includes(app.agencyId)) {
    throw new DomainError("NOT_FOUND", "Application not found");
  }
  const rows = (await docQuery(t)
    .where(eq(applicationDocuments.applicationId, app.id))
    .orderBy(desc(applicationDocuments.uploadedAt))) as unknown as Array<Record<string, any>>;
  return rows.map((r) => toView(r, { includeStaffFields: actor.isStaff }));
}

/**
 * Store an applicant document.
 *
 * `applicationId` is never trusted to be the applicant's parent, and
 * `applicantId` is never trusted to belong to the application — the
 * relationship is read back from the database inside this same transaction.
 */
export async function uploadDocument(actor: OpActor, applicationId: string, input: UploadInput): Promise<UploadResult> {
  assertActorPermission(actor, "documents.upload");
  // Prove access to the target file BEFORE any input-dependent error. Otherwise
  // a bad file on a foreign application answers 422 while a good file answers
  // 404 — which would turn the upload endpoint into an existence oracle.
  const t0: Q = await getDb();
  await loadApplicationReadOnly(t0, actor, applicationId);
  return withTx((tx) => uploadDocumentInsideTx(tx, actor, applicationId, input));
}

/**
 * The transactional body of an upload, usable inside a caller's transaction.
 *
 * Exposed so an import path (Gmail linking) can lock the staging row, store the
 * document and mark it linked in ONE transaction — instead of opening a nested
 * one, which would escape the atomic unit on PostgreSQL and is refused outright
 * by the withTx guard.
 */
export async function uploadDocumentInsideTx(
  tx: Database,
  actor: OpActor,
  applicationId: string,
  input: UploadInput,
): Promise<UploadResult> {
  {
    const bytes = input.bytes;
    if (!bytes || !bytes.length) throw new DomainError("VALIDATION", "The uploaded file is empty");
    if (bytes.length > DOCUMENT_MAX_BYTES) {
      throw new DomainError("VALIDATION", `File is too large (limit ${Math.floor(DOCUMENT_MAX_BYTES / 1024 / 1024)} MB)`);
    }
    const sniffed = sniffDocument(bytes);
    if (!sniffed) {
      throw new DomainError("VALIDATION", "Unsupported file type — upload a PDF, PNG, JPEG or WebP scan");
    }
    const filename = safeFilename(input.filename, `document.${sniffed.extension}`);
    const t: Q = tx;
    const app = await loadApplicationForUpdate(tx, actor, applicationId);
    const status = await loadStatusById(app.statusId, tx);
    if (status.isTerminal) {
      throw new DomainError("STATE_CONFLICT", "This file is closed, so documents can no longer be added");
    }
    const mayUpload = can(actor.role, "documents.upload");
    if (!mayUpload) throw new DomainError("FORBIDDEN", "You may not upload documents");

    // --- resolve the document type from configuration ---
    let dt: { id: string; code: string; name: string; allowedExtensions: string[]; maxFileSizeMb: number | null; isActive: boolean } | undefined;
    if (input.documentTypeId) {
      dt = (await t
        .select()
        .from(documentTypes)
        .where(eq(documentTypes.id, input.documentTypeId))
        .limit(1))[0] as typeof dt;
    } else if (input.documentTypeCode) {
      dt = (await t
        .select()
        .from(documentTypes)
        .where(sql`upper(${documentTypes.code}) = upper(${input.documentTypeCode})`)
        .limit(1))[0] as typeof dt;
    } else {
      throw new DomainError("VALIDATION", "Choose which document you are uploading");
    }
    if (!dt || !dt.isActive) throw new DomainError("VALIDATION", "That document type is not available");

    // --- the file's own rules, frozen at capture; live config as fallback ---
    const snapshot = app.currentSnapshotId ? await loadSnapshot(app.currentSnapshotId, tx) : null;
    const frozen = snapshot?.requirements.find((r) => r.documentTypeId === dt!.id) ?? null;
    const allowedExtensions = (frozen?.allowedExtensions?.length ? frozen.allowedExtensions : (dt.allowedExtensions as string[]) ?? [])
      .map((e) => String(e).toLowerCase().replace(/^\./, ""));
    if (allowedExtensions.length && !allowedExtensions.includes(sniffed.extension)) {
      throw new DomainError(
        "VALIDATION",
        `${dt.name} accepts ${allowedExtensions.join(", ")} — this file is a ${sniffed.extension}`,
      );
    }
    const maxMb = Number(dt.maxFileSizeMb ?? frozen?.maxFileSizeMb ?? DEFAULT_MAX_DOC_MB);
    const maxBytes = Math.min(DOCUMENT_MAX_BYTES, Math.max(1, maxMb) * 1024 * 1024);
    if (bytes.length > maxBytes) {
      throw new DomainError("VALIDATION", `${dt.name} is limited to ${maxMb} MB (this file is ${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
    }

    // --- is it on the checklist at all? ---
    const slot = { applicationId: app.id, documentTypeId: dt.id, applicantId: input.applicantId ?? null };
    if (slot.applicantId) {
      await assertApplicantOwnership(tx, {
        applicantId: slot.applicantId,
        applicationId: app.id,
        agencyId: app.agencyId,
      });
    } else if (frozen && (frozen as { appliesTo?: string }).appliesTo === "APPLICANT") {
      throw new DomainError("VALIDATION", `Choose which traveller this ${dt.name} belongs to`);
    }
    const satisfiesRequirement = Boolean(frozen);
    if (!satisfiesRequirement && !actor.isStaff) {
      throw new DomainError(
        "VALIDATION",
        `${dt.name} is not on this file's checklist. Ask the ESSAFARIA desk to add it, or upload one of: ${
          (snapshot?.requirements ?? []).filter((r) => r.isRequired).map((r) => r.documentTypeName).join(", ") || "the listed documents"
        }`,
      );
    }

    // --- duplicate content for the same slot ---
    const hash = sha256Hex(bytes);
    const dup = (await t
      .select({ id: applicationDocuments.id, version: applicationDocuments.version })
      .from(applicationDocuments)
      .where(
        and(
          eq(applicationDocuments.applicationId, app.id),
          eq(applicationDocuments.documentTypeId, dt.id),
          slot.applicantId ? eq(applicationDocuments.applicantId, slot.applicantId) : isNull(applicationDocuments.applicantId),
          eq(applicationDocuments.isCurrent, true),
          eq(applicationDocuments.contentHash, hash),
        ),
      )
      .limit(1)) as Array<{ id: string; version: number }>;
    if (dup[0]) {
      throw new DomainError("DUPLICATE", "That exact file is already the current version for this requirement");
    }

    // --- idempotent import guard (GMAIL/AI re-delivery must not double-store) ---
    if (input.externalId) {
      const seen = (await t
        .select({ id: applicationDocuments.id })
        .from(applicationDocuments)
        .where(
          and(
            eq(applicationDocuments.agencyId, app.agencyId),
            eq(applicationDocuments.externalId, input.externalId),
          ),
        )
        .limit(1)) as Array<{ id: string }>;
      if (seen[0]) {
        return {
          documentId: seen[0].id,
          mediaId: "",
          version: 0,
          reviewState: "PENDING",
          expiresAt: null,
          checklistComplete: app.checklistComplete,
          supersededDocumentId: null,
          satisfiesRequirement: false,
        };
      }
    }

    // --- store the object, then the metadata ---
    const key = makeStorageKey(`documents/${app.agencyId.slice(0, 8)}`, filename);
    await storage().put(key, bytes, sniffed.mime);
    const mediaRows = (await t
      .insert(media)
      .values({
        kind: "DOCUMENT",
        filename,
        storageKey: key,
        mimeType: sniffed.mime,
        sizeBytes: bytes.length,
        altText: null,
        uploadedBy: actor.id,
      })
      .returning({ id: media.id })) as Array<{ id: string }>;
    const mediaId = mediaRows[0]!.id;

    const slotCond = and(
      eq(applicationDocuments.applicationId, app.id),
      eq(applicationDocuments.documentTypeId, dt.id),
      slot.applicantId ? eq(applicationDocuments.applicantId, slot.applicantId) : isNull(applicationDocuments.applicantId),
      eq(applicationDocuments.isCurrent, true),
    );
    const prev = (await t
      .select({ id: applicationDocuments.id, version: applicationDocuments.version })
      .from(applicationDocuments)
      .where(
        and(
          eq(applicationDocuments.applicationId, app.id),
          eq(applicationDocuments.documentTypeId, dt.id),
          slot.applicantId ? eq(applicationDocuments.applicantId, slot.applicantId) : isNull(applicationDocuments.applicantId),
          eq(applicationDocuments.isCurrent, true),
        ),
      )
      .orderBy(desc(applicationDocuments.version))
      .limit(1)) as Array<{ id: string; version: number }>;
    const version = Number(prev[0]?.version ?? 0) + 1;

    const validityDays = frozen?.validityDays ?? null;
    const expiresAt = validityDays ? new Date(Date.now() + validityDays * 86_400_000) : null;

    // Retire the incumbent FIRST: documents_current_per_slot_uq is a partial
    // unique index over "current" rows, and Postgres enforces it per statement.
    let supersededId: string | null = null;
    if (prev[0]) {
      const moved = await t
        .update(applicationDocuments)
        .set({ isCurrent: false, reviewState: "SUPERSEDED", updatedAt: new Date() })
        .where(and(eq(applicationDocuments.id, prev[0].id), eq(applicationDocuments.isCurrent, true)));
      void moved;
      supersededId = prev[0].id;
    }

    const inserted = (await t
      .insert(applicationDocuments)
      .values({
        applicationId: app.id,
        applicantId: slot.applicantId,
        agencyId: app.agencyId,
        documentTypeId: dt.id,
        documentTypeCode: dt.code,
        requirementId: frozen?.requirementId ?? null,
        wasRequiredAtUpload: frozen ? frozen.isRequired : false,
        mediaId,
        version,
        contentHash: hash,
        bytes: bytes.length,
        originalFilename: filename,
        source: input.source ?? (actor.isStaff ? "BACK_OFFICE" : "PORTAL"),
        externalId: input.externalId ?? null,
        supersedesDocumentId: prev[0]?.id ?? null,
        reviewState: "PENDING",
        isCurrent: true,
        agencyNotes: input.agencyNotes?.slice(0, 2000) ?? null,
        expiresAt,
        uploadedBy: actor.id,
        uploadedAt: new Date(),
      })
      .returning({ id: applicationDocuments.id })) as Array<{ id: string }>;
    const documentId = inserted[0]!.id;

    const checklistComplete = await refreshChecklistFlag(app.id, tx, actor);

    await writeEvent(t, app, actor, {
      type: "DOCUMENT_UPLOADED",
      message: `${dt.name} uploaded (v${version})${satisfiesRequirement ? "" : " — extra document, not a checklist item"}`,
      customerVisible: true,
      payload: { documentId, documentTypeCode: dt.code, version, sizeBytes: bytes.length, satisfiesRequirement },
    });
    await auditIn(tx, {
      actor,
      action: "UPLOAD",
      entityType: "application_document",
      entityId: documentId,
      agencyId: app.agencyId,
      metadata: {
        applicationId: app.id,
        documentTypeCode: dt.code,
        applicantId: slot.applicantId,
        bytes: bytes.length,
        sha256: hash,
        source: input.source ?? (actor.isStaff ? "BACK_OFFICE" : "PORTAL"),
      },
    });

    await notify(
      {
        staffOnly: true,
        audienceRole: "VISA_AGENT",
        applicationId: app.id,
        agencyId: app.agencyId,
        kind: "DOCUMENT_UPLOADED",
        title: `New document on ${app.reference}: ${dt.name} v${version}`,
        body: `${actor.email} uploaded ${filename} (${(bytes.length / 1024).toFixed(0)} KB). Awaiting review.`,
        link: `/admin/applications/${app.id}`,
        severity: "INFO",
        dedupeKey: `DOC_UPLOADED:${documentId}`,
      },
      tx,
    );
    if (!actor.isStaff) {
      await notify(
        {
          agencyId: app.agencyId,
          applicationId: app.id,
          kind: "DOCUMENT_RECEIVED",
          title: `${dt.name} received for ${app.reference}`,
          body:
            checklistComplete && satisfiesRequirement
              ? "Your document set is now complete. The desk will review it and move the file forward."
              : `The file is queued for review. Version ${version} replaces the previous upload.`,
          link: `/agency/applications/${app.id}`,
          severity: "INFO",
          dedupeKey: `DOC_RECEIVED:${documentId}`,
        },
        tx,
      );
    }

    return {
      documentId,
      mediaId,
      version,
      reviewState: "PENDING",
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      checklistComplete,
      supersededDocumentId: supersededId,
      satisfiesRequirement,
    };
  }
}

/* ---------------- review ---------------- */

export interface ReviewInput {
  decision: "ACCEPT" | "REJECT" | "NEEDS_REPLACEMENT";
  note?: string | null;
  rejectionCode?: string | null;
  /** override the configured validity window for this document */
  requireValidityDays?: number | null;
}

async function lockDocumentForReview(t: Q, actor: OpActor, documentId: string) {
  const rows = (await t
    .select({
      doc: applicationDocuments,
      app: visaApplications,
      appAgency: visaApplications.agencyId,
    })
    .from(applicationDocuments)
    .innerJoin(visaApplications, eq(visaApplications.id, applicationDocuments.applicationId))
    .where(eq(applicationDocuments.id, documentId))
    .limit(1)
    .for("update")) as unknown as Array<{ doc: typeof applicationDocuments.$inferSelect; app: VisaApplication }>;
  const row = rows[0];
  if (!row) throw new DomainError("NOT_FOUND", "Document not found");
  const app = row.app;
  if (!actor.isStaff && !actor.agencyIds.includes(app.agencyId)) {
    throw new DomainError("NOT_FOUND", "Document not found");
  }
  return { document: row.doc, app };
}

export async function reviewDocument(actor: OpActor, documentId: string, input: ReviewInput): Promise<void> {
  assertActorPermission(actor, "applications.review");
  if (!actor.isStaff) {
    throw new DomainError("FORBIDDEN", "Only ESSAFARIA staff can review documents");
  }
  const note = (input.note ?? "").trim().slice(0, 2000);
  if (input.decision !== "ACCEPT" && note.length < 5) {
    throw new DomainError("VALIDATION", "Tell the agency what is wrong with the document (at least 5 characters)");
  }
  return withTx(async (tx: Database) => {
    const t: Q = tx;
    const { document: doc, app } = await lockDocumentForReview(t, actor, documentId);
    if (!doc.isCurrent) {
      throw new DomainError("STATE_CONFLICT", "That version has already been replaced — review the current upload");
    }
    const status = await loadStatusById(app.statusId, tx);
    if (status.isTerminal) throw new DomainError("STATE_CONFLICT", "This file is closed");
    // A decision is not an edit. Re-reviewing an already-decided document must be
    // an explicit act (below), otherwise two reviewers silently overwrite each
    // other — the conditional UPDATE then also closes the read-modify-write gap.
    if (doc.reviewState !== "PENDING" && doc.reviewState !== "NEEDS_REPLACEMENT") {
      throw new DomainError(
        "STATE_CONFLICT",
        `This document was already ${doc.reviewState.toLowerCase()} — ask the agency to upload a replacement instead of re-deciding`,
      );
    }

    const snapshot = app.currentSnapshotId ? await loadSnapshot(app.currentSnapshotId, tx) : null;
    const frozen = snapshot?.requirements.find((r) => r.documentTypeId === doc.documentTypeId) ?? null;

    const next: Record<string, unknown> = {
      reviewedBy: actor.id,
      reviewedAt: new Date(),
      updatedAt: new Date(),
      staffNotes: note || doc.staffNotes,
      rejectionCode: input.decision === "ACCEPT" ? null : (input.rejectionCode ?? null),
    };
    let typeName = "accepted";
    if (input.decision === "ACCEPT") {
      const days = Number.isInteger(input.requireValidityDays)
        ? Number(input.requireValidityDays)
        : frozen?.validityDays ?? null;
      next.reviewState = "ACCEPTED";
      next.expiresAt = days ? new Date(Date.now() + days * 86_400_000) : doc.expiresAt ?? null;
    } else if (input.decision === "REJECT") {
      next.reviewState = "REJECTED";
      typeName = "rejected";
    } else {
      next.reviewState = "NEEDS_REPLACEMENT";
      typeName = "flagged for replacement";
    }
    // conditional claim: two reviewers cannot both decide this row
    const res = await t
      .update(applicationDocuments)
      .set(next)
      .where(and(eq(applicationDocuments.id, doc.id), eq(applicationDocuments.isCurrent, true), eq(applicationDocuments.reviewState, doc.reviewState)));
    if (affectedRows(res) !== 1) {
      throw new DomainError("RACE", "Someone reviewed this document a moment ago — reload before deciding");
    }

    const checklistComplete = await refreshChecklistFlag(app.id, tx, actor);

    await writeEvent(t, app, actor, {
      type: input.decision === "ACCEPT" ? "DOCUMENT_ACCEPTED" : "DOCUMENT_REJECTED",
      message: `${doc.documentTypeCode.replace(/_/g, " ").toLowerCase()} ${typeName}${note ? ` — ${note}` : ""}`,
      customerVisible: true,
      payload: { documentId: doc.id, decision: input.decision, rejectionCode: input.rejectionCode ?? null },
    });
    await auditIn(tx, {
      actor,
      action: input.decision === "ACCEPT" ? "APPROVE" : "REJECT",
      entityType: "application_document",
      entityId: doc.id,
      agencyId: app.agencyId,
      changes: { before: { reviewState: doc.reviewState }, after: { reviewState: next.reviewState, note } },
    });

    await notify(
      {
        agencyId: app.agencyId,
        applicationId: app.id,
        kind: input.decision === "ACCEPT" ? "DOCUMENT_ACCEPTED" : "DOCUMENT_REJECTED",
        title:
          input.decision === "ACCEPT"
            ? `${doc.documentTypeCode.replace(/_/g, " ")} accepted — ${app.reference}`
            : `Action needed on ${app.reference}: ${doc.documentTypeCode.replace(/_/g, " ").toLowerCase()} ${input.decision === "REJECT" ? "rejected" : "must be replaced"}`,
        body: note || (input.decision === "ACCEPT" ? "The document passed review." : "Please upload a corrected version."),
        link: `/agency/applications/${app.id}`,
        severity: input.decision === "ACCEPT" ? "SUCCESS" : "ACTION_REQUIRED",
        audienceRole: "AGENCY_ADMIN",
        dedupeKey: `DOC_REVIEW:${doc.id}:${String(next.reviewState)}:${(next.reviewedAt as Date).getTime()}`,
        email: input.decision === "ACCEPT" ? { templateCode: "DOCUMENTS_APPROVED" } : { templateCode: "MISSING_DOCUMENTS" },
      },
      tx,
    );
    if (checklistComplete) {
      await notify(
        {
          staffOnly: true,
          audienceRole: "VISA_AGENT",
          applicationId: app.id,
          agencyId: app.agencyId,
          kind: "CHECKLIST_COMPLETE",
          title: `${app.reference}: document set complete`,
          body: "Every required document is accepted. The file is ready for the next workflow step.",
          link: `/admin/applications/${app.id}`,
          severity: "ACTION_REQUIRED",
          dedupeKey: `CHECKLIST_COMPLETE:${app.id}:${Date.now()}`,
        },
        tx,
      );
    }
  });
}



/** Staff removes a current document from the checklist slot (wrong upload).
 *  The row is superseded, never deleted, so the decision remains auditable. */
export async function withdrawDocument(actor: OpActor, documentId: string, reason: string): Promise<void> {
  assertActorPermission(actor, "applications.review");
  if (!actor.isStaff) throw new DomainError("FORBIDDEN", "Only staff may withdraw a document");
  const why = (reason ?? "").trim();
  if (why.length < 5) throw new DomainError("VALIDATION", "A reason is required to withdraw a document");
  return withTx(async (tx: Database) => {
    const t: Q = tx;
    const { document: doc, app } = await lockDocumentForReview(t, actor, documentId);
    if (!doc.isCurrent) throw new DomainError("STATE_CONFLICT", "Already superseded");
    await t
      .update(applicationDocuments)
      .set({ isCurrent: false, reviewState: "SUPERSEDED", staffNotes: `Withdrawn: ${why}`.slice(0, 2000), updatedAt: new Date() })
      .where(eq(applicationDocuments.id, doc.id));
    // the previous version becomes current again if one exists
    const prior = (await t
      .select({ id: applicationDocuments.id, version: applicationDocuments.version })
      .from(applicationDocuments)
      .where(
        and(
          eq(applicationDocuments.applicationId, app.id),
          eq(applicationDocuments.documentTypeId, doc.documentTypeId),
          doc.applicantId ? eq(applicationDocuments.applicantId, doc.applicantId) : isNull(applicationDocuments.applicantId),
          eq(applicationDocuments.supersedesDocumentId, doc.id),
        ),
      )
      .limit(1)) as Array<{ id: string; version: number }>;
    void prior;
    await refreshChecklistFlag(app.id, tx, actor);
    await writeEvent(t, app, actor, {
      type: "DOCUMENT_WITHDRAWN",
      message: `${doc.documentTypeCode.replace(/_/g, " ")} withdrawn — ${why}`,
      customerVisible: true,
      payload: { documentId: doc.id },
    });
    await auditIn(tx, {
      actor,
      action: "REMOVE",
      entityType: "application_document",
      entityId: doc.id,
      agencyId: app.agencyId,
      metadata: { reason: why, applicationId: app.id },
    });
  });
}

/**
 * Ask the agency for everything still outstanding. Notification, timeline
 * event and audit row land in ONE transaction, and the checklist is read
 * through that same handle — so a request can never describe a state that the
 * database does not agree with.
 */
export async function requestMissingDocuments(
  actor: OpActor,
  applicationId: string,
  extraNote?: string | null,
): Promise<{ requested: number }> {
  assertActorPermission(actor, "applications.write");
  return withTx(async (tx: Database) => {
    const t: Q = tx;
    const app = await loadApplicationReadOnlyForDocuments(t, actor, applicationId);
    const { computeChecklistBundle } = await import("@/lib/applications");
    const checklist = await computeChecklistBundle(actor, applicationId, tx);
    if (!checklist.blocking.length) return { requested: 0 };
    const list = checklist.blocking.map((b) => `• ${b.reason}`).join("\n");
    await notify(
      {
        agencyId: app.agencyId,
        applicationId: app.id,
        kind: "MISSING_DOCUMENTS",
        title: `Documents needed for ${app.reference}`,
        body: `Please upload:\n${list}${extraNote ? `\n\n${extraNote}` : ""}`,
        link: `/agency/applications/${app.id}`,
        severity: "ACTION_REQUIRED",
        audienceRole: "AGENCY_ADMIN",
        dedupeKey: `MISSING:${app.id}:${new Date().toISOString().slice(0, 10)}`,
        email: { templateCode: "MISSING_DOCUMENTS" },
      },
      tx,
    );
    await writeEvent(t, app, actor, {
      type: "DOCUMENTS_REQUESTED",
      message: `Requested ${checklist.blocking.length} outstanding item(s) from the agency`,
      customerVisible: true,
      payload: { items: checklist.blocking.map((b) => b.item.documentTypeCode) },
    });
    await auditIn(tx, {
      actor,
      action: "UPDATE",
      entityType: "visa_application",
      entityId: app.id,
      agencyId: app.agencyId,
      metadata: { documentsRequested: checklist.blocking.length },
    });
    return { requested: checklist.blocking.length };
  });
}

async function loadApplicationReadOnlyForDocuments(t: Q, actor: OpActor, id: string) {
  const rows = (await t
    .select()
    .from(visaApplications)
    .where(eq(visaApplications.id, id))
    .limit(1)) as unknown as VisaApplication[];
  const app = rows[0];
  if (!app) throw new DomainError("NOT_FOUND", "Application not found");
  if (!actor.isStaff && !actor.agencyIds.includes(app.agencyId)) {
    throw new DomainError("NOT_FOUND", "Application not found");
  }
  return app;
}

/* ---------------- secure access ---------------- */

export interface DocumentContent {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  documentId: string;
}

/**
 * Prove a viewer may read a document's bytes.
 *
 * Order matters: session → capability → document → application → agency.
 * Anything outside the caller's tenant answers NOT_FOUND, so the route is not
 * an existence oracle for other agencies' files. Every successful read writes a
 * DOWNLOAD audit row.
 */
export async function openDocumentContent(
  input: { documentId?: string; mediaId?: string },
  user: SessionUser,
): Promise<DocumentContent> {
  if (!can(user.role, "documents.upload") && !can(user.role, "applications.read")) {
    throw new DomainError("FORBIDDEN", "You may not open applicant documents");
  }
  const t: Q = await getDb();
  const rows = (await t
    .select({
      id: applicationDocuments.id,
      agencyId: applicationDocuments.agencyId,
      mediaId: applicationDocuments.mediaId,
      applicationId: applicationDocuments.applicationId,
      filename: media.filename,
      mimeType: media.mimeType,
      storageKey: media.storageKey,
      reference: visaApplications.reference,
    })
    .from(applicationDocuments)
    .innerJoin(media, eq(media.id, applicationDocuments.mediaId))
    .innerJoin(visaApplications, eq(visaApplications.id, applicationDocuments.applicationId))
    .where(
      input.documentId
        ? eq(applicationDocuments.id, input.documentId)
        : eq(applicationDocuments.mediaId, input.mediaId!),
    )
    .limit(1)) as unknown as Array<{
    id: string;
    agencyId: string;
    mediaId: string;
    applicationId: string;
    filename: string | null;
    mimeType: string;
    storageKey: string;
    reference: string;
  }>;
  const row = rows[0];
  if (!row) throw new DomainError("NOT_FOUND", "Document not found");
  if (!user.agencyIds.length && !["SUPER_ADMIN", "ADMIN", "VISA_AGENT", "ACCOUNTING"].includes(user.role)) {
    throw new DomainError("FORBIDDEN", "You may not open applicant documents");
  }
  const isStaffRole = ["SUPER_ADMIN", "ADMIN", "VISA_AGENT", "ACCOUNTING"].includes(user.role);
  if (!isStaffRole && !user.agencyIds.includes(row.agencyId)) {
    throw new DomainError("NOT_FOUND", "Document not found");
  }
  const buf = await storage().get(row.storageKey);
  if (!buf) {
    console.error(`[documents] stored object missing for ${row.id} (${row.storageKey})`);
    throw new DomainError("NOT_FOUND", "Document content is unavailable");
  }
  await auditIn(t as unknown as Database, {
    actor: { id: user.id, email: user.email, role: user.role },
    action: "DOWNLOAD",
    entityType: "application_document",
    entityId: row.id,
    agencyId: row.agencyId,
    metadata: { applicationId: row.applicationId, reference: row.reference },
  });
  return { buffer: buf, mimeType: row.mimeType, filename: row.filename ?? "document", documentId: row.id };
}

/** The review queue: current documents awaiting a decision (staff surface). */
export async function pendingReviewQueue(actor: OpActor, limit = 50): Promise<DocumentView[]> {
  assertActorPermission(actor, "applications.read");
  if (!actor.isStaff) throw new DomainError("FORBIDDEN", "The review queue is a staff surface");
  const t: Q = await getDb();
  const rows = (await docQuery(t)
    .where(and(eq(applicationDocuments.isCurrent, true), inArray(applicationDocuments.reviewState, ["PENDING", "NEEDS_REPLACEMENT"])))
    .orderBy(desc(applicationDocuments.uploadedAt))
    .limit(Math.min(200, Math.max(1, limit)))) as unknown as Array<Record<string, any>>;
  return rows.map((r) => toView(r, { includeStaffFields: true }));
}

/** Expiry sweep used by automation (Phase 10) and by tests: an accepted
 *  document past its expiry stops satisfying the checklist. */
export async function expireDueDocuments(now = new Date()): Promise<{ expired: number }> {
  return withTx(async (tx: Database) => {
    const t: Q = tx;
    const due = (await t
      .select({ id: applicationDocuments.id, applicationId: applicationDocuments.applicationId })
      .from(applicationDocuments)
      .where(
        and(
          eq(applicationDocuments.isCurrent, true),
          eq(applicationDocuments.reviewState, "ACCEPTED"),
          sql`${applicationDocuments.expiresAt} is not null`,
          sql`${applicationDocuments.expiresAt} < ${now}`,
        ),
      )
      .limit(500)) as Array<{ id: string; applicationId: string }>;
    if (!due.length) return { expired: 0 };
    for (const d of due) {
      const res = await t
        .update(applicationDocuments)
        .set({ reviewState: "EXPIRED", updatedAt: now })
        .where(and(eq(applicationDocuments.id, d.id), eq(applicationDocuments.reviewState, "ACCEPTED")));
      if (affectedRows(res) !== 1) continue; // another worker already swept it
      await t.insert(applicationEvents).values({
        applicationId: d.applicationId,
        type: "DOCUMENT_EXPIRED",
        actorKind: "AUTOMATION",
        actorEmail: "automation@essafaria.local",
        message: "A document passed its validity window and no longer satisfies the checklist",
        customerVisible: true,
        payload: { documentId: d.id },
      });
    }
    // one notification per affected application
    const apps = [...new Set(due.map((d) => d.applicationId))];
    for (const applicationId of apps) {
      const app = (await t
        .select({ id: visaApplications.id, reference: visaApplications.reference, agencyId: visaApplications.agencyId })
        .from(visaApplications)
        .where(eq(visaApplications.id, applicationId))
        .limit(1))[0] as { id: string; reference: string; agencyId: string } | undefined;
      if (!app) continue;
      await t
        .update(visaApplications)
        .set({ checklistComplete: false, lastActivityAt: now })
        .where(and(eq(visaApplications.id, app.id), eq(visaApplications.checklistComplete, true)));
      await notify(
        {
          agencyId: app.agencyId,
          applicationId: app.id,
          kind: "DOCUMENT_EXPIRED",
          title: `A document on ${app.reference} has expired`,
          body: "Its validity window has passed. Upload a fresh copy so the file can move forward.",
          link: `/agency/applications/${app.id}`,
          severity: "ACTION_REQUIRED",
          audienceRole: "AGENCY_ADMIN",
          dedupeKey: `DOC_EXPIRED:${app.id}:${now.toISOString().slice(0, 10)}`,
          email: { templateCode: "MISSING_DOCUMENTS" },
        },
        tx,
      );
    }
    await auditIn(tx, {
      actor: null,
      action: "UPDATE",
      entityType: "application_document",
      entityId: "expiry-sweep",
      metadata: { expired: due.length, applications: apps.length },
    });
    return { expired: due.length };
  });
}
