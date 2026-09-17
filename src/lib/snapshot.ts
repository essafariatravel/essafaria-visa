import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  applicationSnapshots,
  documentTypes,
  priorities,
  siteSettings,
  visaFees,
  visaRequirements,
  visaApplications,
  type ChecklistItem,
  type Database,
} from "@/db";
import { DomainError, MAX_MONEY_CENTS, applySurcharge } from "@/lib/ops";
import { getSettingIn } from "@/lib/config-service";

type Q = any;

/* ============================================================
 * Snapshots & checklist derivation (Phase 3).
 *
 * WHY A SNAPSHOT: the checklist and the price of a file must mean the
 * same thing in 2027 that they meant the day it was submitted, even after
 * an admin renames a document type, retires a requirement or reprices a
 * visa. So the requirement set and the fee set are frozen as JSON at
 * meaningful moments, and the live configuration drives only *forward*
 * behaviour (gates, which next statuses are legal).
 *
 * WHY DERIVE THE CHECKLIST: one source of truth (snapshot + documents)
 * means no materialized checklist can drift out of sync with a document
 * being re-reviewed a second later.
 * ============================================================ */

export interface RequirementSnapshotRow {
  requirementId: string;
  documentTypeId: string;
  documentTypeCode: string;
  documentTypeName: string;
  isRequired: boolean;
  instructions: string | null;
  validityDays: number | null;
  /** document type constraints, frozen so uploads stay valid after re-config */
  allowedExtensions: string[];
  maxFileSizeMb: number | null;
  displayOrder: number;
}

export interface FeeSnapshotRow {
  visaFeeId: string | null;
  feeType: string;
  amountCents: number;
  currencyCode: string;
  effectiveFrom: string;
  description: string;
}

export interface CapturedSnapshot {
  id: string;
  requirements: RequirementSnapshotRow[];
  fees: FeeSnapshotRow[];
  config: SnapshotConfig;
  totalAmountCents: number;
  currencyCode: string;
}

/** A configured fee line as it will be billed: unit price (surcharge already
 *  applied), quantity, and the line total. All integer cents. */
export interface PricedFeeLine {
  visaFeeId: string | null;
  feeType: string;
  description: string;
  unitAmountCents: number;
  quantity: number;
  amountCents: number;
  currencyCode: string;
  effectiveFrom: string;
}

export interface SnapshotConfig {
  /** currency selected for this file, from visa.defaultCurrency + fee data */
  billingCurrency: string;
  /** whether an agency may submit without a clean checklist (live value at capture) */
  agencySelfSubmit: boolean;
  /** how many applicants must hold an applicant-level document before the
   *  requirement counts as satisfied (live policy, recorded for the audit trail) */
  perApplicantPolicy: "ALL" | "ANY";
  capturedFromConfigAt: string;
}

export interface DocumentStateRow {
  id: string;
  documentTypeId: string;
  applicantId: string | null;
  reviewState: string;
  version: number;
  uploadedAt: string | Date;
  expiresAt: string | Date | null;
  isCurrent: boolean;
}

/* ---------------- capture ---------------- */

async function readRequirements(visaTypeId: string, t: Q): Promise<RequirementSnapshotRow[]> {
  const rows = ((await t
    .select({
      requirementId: visaRequirements.id,
      documentTypeId: documentTypes.id,
      documentTypeCode: documentTypes.code,
      documentTypeName: documentTypes.name,
      isRequired: visaRequirements.isRequired,
      instructions: visaRequirements.instructions,
      validityDays: visaRequirements.validityDays,
      allowedExtensions: documentTypes.allowedExtensions,
      maxFileSizeMb: documentTypes.maxFileSizeMb,
      displayOrder: visaRequirements.displayOrder,
    })
    .from(visaRequirements)
    .innerJoin(documentTypes, eq(documentTypes.id, visaRequirements.documentTypeId))
    .where(and(eq(visaRequirements.visaTypeId, visaTypeId), eq(documentTypes.isActive, true)))
    .orderBy(asc(visaRequirements.displayOrder)))) as unknown as Array<RequirementSnapshotRow & {
    allowedExtensions: unknown;
  }>;
  return rows.map((r) => ({
    ...r,
    allowedExtensions: Array.isArray(r.allowedExtensions) ? (r.allowedExtensions as string[]) : [],
  }));
}

/**
 * Resolve the effective fee for each configured fee type in one currency.
 * "Effective" = active, in that currency, effective_from <= asOfDate, latest
 * such row wins. Missing rows are skipped, never invented.
 */
async function readFees(
  visaTypeId: string,
  currencyCode: string,
  asOfDate: string,
  t: Q,
): Promise<FeeSnapshotRow[]> {
  const rows = (await t
    .select()
    .from(visaFees)
    .where(
      and(
        eq(visaFees.visaTypeId, visaTypeId),
        eq(visaFees.currencyCode, currencyCode),
        eq(visaFees.isActive, true),
        sql`${visaFees.effectiveFrom}::date <= ${asOfDate}::date`,
      ),
    )
    .orderBy(asc(visaFees.feeType), sql`${visaFees.effectiveFrom} desc`)) as Array<typeof visaFees.$inferSelect>;
  const best = new Map<string, (typeof visaFees.$inferSelect) & object>();
  for (const r of rows) if (!best.has(r.feeType)) best.set(r.feeType, r);
  return [...best.values()].map((r) => ({
    visaFeeId: r.id,
    feeType: r.feeType,
    amountCents: r.amountCents,
    currencyCode: r.currencyCode,
    effectiveFrom: r.effectiveFrom,
    description: `${labelForFeeType(r.feeType)}`,
  }));
}

export function labelForFeeType(feeType: string): string {
  switch (feeType) {
    case "VISA_FEE":
      return "Consular visa fee";
    case "SERVICE_FEE":
      return "ESSAFARIA service fee";
    case "B2B_PRICE":
      return "B2B package price";
    default:
      return feeType;
  }
}

async function readSnapshotConfig(t: Q): Promise<SnapshotConfig> {
  const defaultCurrency = await getSettingIn<string>(t, "visa.defaultCurrency", "EUR");
  const selfSubmit = await getSettingIn<boolean>(t, "ops.agencySelfSubmit", true);
  const perApplicant = await getSettingIn<"ALL" | "ANY">(t, "ops.perApplicantDocumentPolicy", "ALL");
  return {
    billingCurrency: typeof defaultCurrency === "string" ? defaultCurrency.toUpperCase() : "EUR",
    agencySelfSubmit: selfSubmit !== false,
    perApplicantPolicy: perApplicant === "ANY" ? "ANY" : "ALL",
    capturedFromConfigAt: new Date().toISOString(),
  };
}

/** Compute the billable total for a file from fees + priority surcharge.
 *  Exported so a UI can show an honest estimate before the snapshot exists. */
export function computeAmounts(input: {
  fees: FeeSnapshotRow[];
  applicantCount: number;
  surchargePercent: number;
}): { lines: PricedFeeLine[]; totalCents: number } {
  const n = Math.max(1, input.applicantCount);
  const lines: PricedFeeLine[] = input.fees.map((f) => {
    // A priority surcharge applies to ESSAFARIA's own money, never to the
    // consular fee the government charges.
    const unit =
      f.feeType === "VISA_FEE" ? f.amountCents : applySurcharge(f.amountCents, input.surchargePercent);
    const amount = unit * n;
    if (amount > MAX_MONEY_CENTS) {
      throw new DomainError("VALIDATION", "Computed amount exceeds the supported range");
    }
    return {
      visaFeeId: f.visaFeeId,
      feeType: f.feeType,
      description: f.description,
      unitAmountCents: unit,
      quantity: n,
      amountCents: amount,
      currencyCode: f.currencyCode,
      effectiveFrom: f.effectiveFrom,
    };
  });
  const total = lines.reduce((sum, l) => sum + l.amountCents, 0);
  if (total > MAX_MONEY_CENTS) {
    throw new DomainError("VALIDATION", "Computed total exceeds the supported range");
  }
  return { lines, totalCents: total };
}

/** Read the configured priority surcharge (0 when unset — never guessed). */
export async function readPrioritySurcharge(priorityId: string | null, t: Q): Promise<number> {
  if (!priorityId) return 0;
  const rows = (await t
    .select({ surchargePercent: priorities.surchargePercent, code: priorities.code })
    .from(priorities)
    .where(eq(priorities.id, priorityId))
    .limit(1)) as Array<{ surchargePercent: number; code: string }>;
  const row = rows[0];
  if (!row) throw new DomainError("CONFIG", "Priority is missing from configuration");
  return Number.isInteger(row.surchargePercent) ? row.surchargePercent : 0;
}

/**
 * Capture (and persist) a snapshot for an application. Never mutates an older
 * snapshot row — history is append-only.
 */
export async function captureSnapshot(
  input: {
    applicationId: string;
    reason: "CREATED" | "SUBMITTED" | "CONFIG_CHANGED" | "RECHECK";
    actorId?: string | null;
  },
  tx?: Database,
): Promise<CapturedSnapshot> {
  const t: Q = tx ?? (await getDb());
  const apps = (await t
    .select()
    .from(visaApplications)
    .where(eq(visaApplications.id, input.applicationId))
    .limit(1)) as Array<typeof visaApplications.$inferSelect>;
  const app = apps[0];
  if (!app) throw new DomainError("NOT_FOUND", "Application not found");

  const requirements = await readRequirements(app.visaTypeId, t);
  const config = await readSnapshotConfig(t);
  let fees = await readFees(app.visaTypeId, config.billingCurrency, new Date().toISOString().slice(0, 10), t);
  if (!fees.length) {
    // Currency has no pricing for this route: fall back to the configured
    // base currency so the file is still processable, and record the fact.
    const alt = (await t
      .select({ currencyCode: visaFees.currencyCode })
      .from(visaFees)
      .where(and(eq(visaFees.visaTypeId, app.visaTypeId), eq(visaFees.isActive, true)))
      .limit(1)) as Array<{ currencyCode: string }>;
    if (alt[0]?.currencyCode) {
      fees = await readFees(app.visaTypeId, alt[0].currencyCode, new Date().toISOString().slice(0, 10), t);
      if (fees.length) config.billingCurrency = alt[0].currencyCode;
    }
  }
  const surcharge = await readPrioritySurcharge(app.priorityId, t);
  const { lines, totalCents } = computeAmounts({
    fees,
    applicantCount: Math.max(1, app.requestedCount || 1),
    surchargePercent: surcharge,
  });

  const inserted = (await t
    .insert(applicationSnapshots)
    .values({
      applicationId: app.id,
      reason: input.reason,
      requirements,
      // persist the priced lines (quantity + line total), not just the raw fee
      fees: lines,
      config: { ...config, prioritySurchargePercent: surcharge },
      totalAmountCents: totalCents,
      currencyCode: config.billingCurrency,
      capturedBy: input.actorId ?? null,
    })
    .returning({ id: applicationSnapshots.id })) as Array<{ id: string }>;
  const id = inserted[0]!.id;

  await t
    .update(visaApplications)
    .set({ currentSnapshotId: id, updatedAt: new Date() })
    .where(eq(visaApplications.id, app.id));

  return {
    id,
    requirements,
    fees: lines,
    config,
    totalAmountCents: totalCents,
    currencyCode: config.billingCurrency,
  };
}

export async function loadSnapshot(snapshotId: string, tx?: Database): Promise<CapturedSnapshot | null> {
  const t: Q = tx ?? (await getDb());
  const rows = (await t
    .select()
    .from(applicationSnapshots)
    .where(eq(applicationSnapshots.id, snapshotId))
    .limit(1)) as Array<typeof applicationSnapshots.$inferSelect>;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    requirements: ((row.requirements ?? []) as unknown) as RequirementSnapshotRow[],
    fees: ((row.fees ?? []) as unknown) as FeeSnapshotRow[],
    config: ((row.config ?? {}) as unknown) as SnapshotConfig,
    totalAmountCents: row.totalAmountCents,
    currencyCode: row.currencyCode ?? "EUR",
  };
}

/* ---------------- checklist derivation ---------------- */

export interface ChecklistOptions {
  /** applicants that must each hold applicant-level documents */
  applicantIds: string[];
  /** ids of documents that are current for this slot, with review state */
  documents: DocumentStateRow[];
  now?: Date;
}

export interface ChecklistResult {
  items: ChecklistItem[];
  requiredTotal: number;
  requiredSatisfied: number;
  blocking: Array<{ item: ChecklistItem; reason: string }>;
  complete: boolean;
  optionalOutstanding: number;
}

function asDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Merge the frozen requirement set with live document state.
 *
 *  • Application-level requirement → one item.
 *  • Applicant-level requirement  → one item PER applicant (a passport for
 *    applicant 1 never covers applicant 2) — policy is `ops.perApplicantDocumentPolicy`.
 *  • Expired = expires_at in the past, computed from the requirement's
 *    configured validityDays at upload time (frozen in the snapshot).
 */
export function deriveChecklist(snapshot: CapturedSnapshot, opts: ChecklistOptions): ChecklistResult {
  const now = opts.now ?? new Date();
  const applicantIds = opts.applicantIds.length ? opts.applicantIds : [null];
  const items: ChecklistItem[] = [];
  const perApplicant = snapshot.config.perApplicantPolicy !== "ANY";

  for (const req of snapshot.requirements) {
    const slots = req.isRequired && perApplicant ? applicantIds : [null as string | null];
    for (const applicantId of slots) {
      const candidates = opts.documents.filter(
        (d) =>
          d.documentTypeId === req.documentTypeId &&
          d.isCurrent &&
          (applicantId ? d.applicantId === applicantId : true),
      );
      // Rejected/expired/needs-replacement do NOT satisfy a requirement, but
      // they remain the "current" document so the UI can show what happened.
      const best = candidates[0] ?? null;
      let state: ChecklistItem["state"];
      if (!req.isRequired && !best) state = "NOT_APPLICABLE";
      else if (!best) state = "MISSING";
      else if (best.reviewState === "ACCEPTED") {
        const exp = asDate(best.expiresAt);
        state = exp && exp.getTime() < now.getTime() ? "EXPIRED" : "ACCEPTED";
      } else if (best.reviewState === "EXPIRED") state = "EXPIRED";
      else if (best.reviewState === "REJECTED") state = "REJECTED";
      else if (best.reviewState === "NEEDS_REPLACEMENT") state = "NEEDS_REPLACEMENT";
      else state = "PENDING_REVIEW";

      const satisfied = state === "ACCEPTED";
      items.push({
        requirementId: req.requirementId,
        documentTypeId: req.documentTypeId,
        documentTypeCode: req.documentTypeCode,
        documentTypeName: req.documentTypeName,
        isRequired: req.isRequired,
        instructions: req.instructions,
        validityDays: req.validityDays,
        allowedExtensions: req.allowedExtensions,
        maxFileSizeMb: req.maxFileSizeMb,
        state,
        documentId: best?.id ?? null,
        documentVersion: best?.version ?? null,
        documentReviewState: best?.reviewState ?? null,
        reviewedAt: null,
        expiresAt: best?.expiresAt ? String(best.expiresAt) : null,
        applicantId: applicantId ?? (best?.applicantId ?? null),
        satisfiedByCurrentDocument: satisfied,
      });
    }
  }

  const required = items.filter((i) => i.isRequired);
  const requiredSatisfied = required.filter((i) => i.satisfiedByCurrentDocument).length;
  const blocking = required
    .filter((i) => !i.satisfiedByCurrentDocument)
    .map((i) => ({
      item: i,
      reason:
        i.state === "MISSING"
          ? `${i.documentTypeName} not uploaded`
          : i.state === "PENDING_REVIEW"
            ? `${i.documentTypeName} awaiting review`
            : i.state === "REJECTED"
              ? `${i.documentTypeName} was rejected`
              : i.state === "EXPIRED"
                ? `${i.documentTypeName} has expired`
                : `${i.documentTypeName} must be replaced`,
    }));

  return {
    items,
    requiredTotal: required.length,
    requiredSatisfied,
    blocking,
    complete: required.length > 0 ? requiredSatisfied === required.length : true,
    optionalOutstanding: items.filter((i) => !i.isRequired && i.documentId && i.state !== "ACCEPTED").length,
  };
}

/** Current documents for a set of applications, grouped in memory (no N+1). */
export async function loadDocumentStates(applicationIds: string[], tx?: Database): Promise<Map<string, DocumentStateRow[]>> {
  const out = new Map<string, DocumentStateRow[]>();
  if (!applicationIds.length) return out;
  const t: Q = tx ?? (await getDb());
  const { applicationDocuments } = await import("@/db");
  const rows = (await t
    .select({
      id: applicationDocuments.id,
      applicationId: applicationDocuments.applicationId,
      documentTypeId: applicationDocuments.documentTypeId,
      applicantId: applicationDocuments.applicantId,
      reviewState: applicationDocuments.reviewState,
      version: applicationDocuments.version,
      uploadedAt: applicationDocuments.uploadedAt,
      expiresAt: applicationDocuments.expiresAt,
      isCurrent: applicationDocuments.isCurrent,
    })
    .from(applicationDocuments)
    .where(inArray(applicationDocuments.applicationId, applicationIds))) as Array<DocumentStateRow & { applicationId: string }>;
  for (const r of rows) {
    const list = out.get(r.applicationId) ?? [];
    list.push({
      id: r.id,
      documentTypeId: r.documentTypeId,
      applicantId: r.applicantId,
      reviewState: r.reviewState,
      version: r.version,
      uploadedAt: r.uploadedAt,
      expiresAt: r.expiresAt,
      isCurrent: r.isCurrent,
    });
    out.set(r.applicationId, list);
  }
  // newest first — the checklist reads the current head of each slot
  for (const list of out.values()) {
    list.sort((a, b) => new Date(b.uploadedAt as never).getTime() - new Date(a.uploadedAt as never).getTime());
  }
  return out;
}

/** The requirement set currently configured for a visa type — used to detect
 *  that configuration moved on since a file's snapshot (a re-check hint). */
export async function currentRequirementsFor(
  visaTypeId: string,
  tx?: Database,
): Promise<RequirementSnapshotRow[]> {
  const t: Q = tx ?? (await getDb());
  return readRequirements(visaTypeId, t);
}

/** Stable fingerprint of a requirement set: code:required:validity:order */
export function signatureOf(rows: RequirementSnapshotRow[]): string {
  return sqlSignature(rows);
}

export function sqlSignature(rows: RequirementSnapshotRow[]): string {
  return rows
    .map((r) => `${r.documentTypeCode}:${r.isRequired ? "R" : "o"}:${r.validityDays ?? "-"}:${r.displayOrder}`)
    .join("|");
}

/** Settings a workflow gate needs, read through the config service (no
 *  hardcoded business rules in this module). */
export async function readOpsSettings(handle?: unknown): Promise<{
  agencySelfSubmit: boolean;
  requireCleanChecklistOnSubmit: boolean;
  perApplicantPolicy: "ALL" | "ANY";
  allowLateAgencyEdits: boolean;
}> {
  const t = (handle as Q) ?? (await getDb());
  const [selfSubmit, requireClean, policy, lateEdits] = await Promise.all([
    getSettingIn<boolean>(t, "ops.agencySelfSubmit", true),
    getSettingIn<boolean>(t, "ops.requireCleanChecklistOnSubmit", true),
    getSettingIn<string>(t, "ops.perApplicantDocumentPolicy", "ALL"),
    getSettingIn<boolean>(t, "ops.allowLateAgencyEdits", false),
  ]);
  return {
    agencySelfSubmit: selfSubmit !== false,
    requireCleanChecklistOnSubmit: requireClean !== false,
    perApplicantPolicy: policy === "ANY" ? "ANY" : "ALL",
    allowLateAgencyEdits: lateEdits === true,
  };
}

export async function settingRow(key: string, tx?: Database): Promise<unknown | null> {
  const t: Q = tx ?? (await getDb());
  const rows = (await t
    .select()
    .from(siteSettings)
    .where(eq(siteSettings.key, key))
    .limit(1)) as Array<{ value: unknown }>;
  return rows[0] ? rows[0].value : null;
}
