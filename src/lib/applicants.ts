import { and, asc, eq, sql } from "drizzle-orm";
import {
  getDb,
  applicants,
  applicationDocuments,
  countries,
  visaApplications,
  type Database,
} from "@/db";
import { DomainError, assertActorPermission, auditIn, loadStatusById } from "@/lib/ops";
import { applicantUpsertSchema } from "@/lib/validation";
import { withTx } from "@/lib/with-tx";
import type { OpActor } from "@/lib/guard";
import {
  assertApplicantOwnership,
  loadApplicationForUpdate,
  refreshChecklistFlag,
  writeEvent,
} from "@/lib/applications";
import { notify } from "@/lib/notifications";
import { captureSnapshot, readOpsSettings } from "@/lib/snapshot";
import { recomputeInvoiceTotals } from "@/lib/billing";

type Q = any;

export const MAX_APPLICANTS = 50;

/* ============================================================
 * Applicants (Phase 4).
 *
 * An applicant is always a child of an application, and the child carries the
 * agency id too — so a tenant check never depends on a join being present.
 * The rule that matters here: when a client sends an `applicantId`, it is
 * never trusted as "this applicant belongs to that file". The relationship is
 * read back from the database inside the same transaction as the write
 * (`assertApplicantOwnership`), and a mismatch answers exactly like a typo.
 * ============================================================ */

export interface ApplicantView {
  id: string;
  applicationId: string;
  fullName: string;
  dateOfBirth: string | null;
  gender: string | null;
  nationality: string | null;
  passportNumber: string | null;
  passportExpiryDate: string | null;
  intendedEntryDate: string | null;
  intendedExitDate: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  isPrimary: boolean;
  displayOrder: number;
  notes: string | null;
  documentsAttached: number;
  createdAt: string;
}

function shape(
  r: Record<string, any>,
  documentCount: number,
): ApplicantView {
  return {
    id: r.id,
    applicationId: r.applicationId,
    fullName: r.fullName,
    dateOfBirth: r.dateOfBirth ?? null,
    gender: r.gender ?? null,
    nationality: r.nationalityName ?? null,
    passportNumber: r.passportNumber ?? null,
    passportExpiryDate: r.passportExpiryDate ?? null,
    intendedEntryDate: r.intendedEntryDate ?? null,
    intendedExitDate: r.intendedExitDate ?? null,
    phone: r.phone ?? null,
    email: r.email ?? null,
    address: r.address ?? null,
    isPrimary: Boolean(r.isPrimary),
    displayOrder: Number(r.displayOrder ?? 0),
    notes: r.notes ?? null,
    documentsAttached: documentCount,
    createdAt: String(r.createdAt),
  };
}

export async function listApplicants(
  actor: OpActor,
  applicationId: string,
): Promise<ApplicantView[]> {
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
  const rows = (await t
    .select({
      a: applicants,
      nationalityName: countries.name,
    })
    .from(applicants)
    .leftJoin(countries, eq(countries.id, applicants.nationalityCountryId))
    .where(and(eq(applicants.applicationId, app.id), eq(applicants.isActive, true)))
    .orderBy(asc(applicants.displayOrder), asc(applicants.createdAt))) as unknown as Array<Record<string, any>>;
  const counts = (await t
    .select({
      applicantId: applicationDocuments.applicantId,
      n: sql<number>`count(*)::int`,
    })
    .from(applicationDocuments)
    .where(and(eq(applicationDocuments.applicationId, app.id), eq(applicationDocuments.isCurrent, true)))
    .groupBy(applicationDocuments.applicantId)) as Array<{ applicantId: string | null; n: number }>;
  const byApplicant = new Map(counts.map((c) => [c.applicantId ?? "", Number(c.n)]));
  return rows.map((r) => shape({ ...r.a, nationalityName: r.nationalityName }, byApplicant.get(r.a.id) ?? 0));
}

export interface ApplicantInput {
  fullName: string;
  firstName?: string | null;
  lastName?: string | null;
  dateOfBirth?: string | null;
  gender?: "MALE" | "FEMALE" | "OTHER" | null;
  maritalStatus?: string | null;
  nationalityCountryCode?: string | null;
  birthCountryCode?: string | null;
  passportNumber?: string | null;
  passportIssueDate?: string | null;
  passportExpiryDate?: string | null;
  passportIssueCountryCode?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  intendedEntryDate?: string | null;
  intendedExitDate?: string | null;
  isPrimary?: boolean;
  notes?: string | null;
}

/** Country codes are the admin-facing handle; ids are what we store. Unknown
 *  codes are rejected rather than silently dropped. */
async function resolveCountryCode(t: Q, code: string | null | undefined, field: string): Promise<string | null> {
  if (!code) return null;
  const rows = (await t
    .select({ id: countries.id })
    .from(countries)
    .where(sql`upper(${countries.code}) = upper(${code})`)
    .limit(1)) as Array<{ id: string }>;
  if (!rows[0]) throw new DomainError("VALIDATION", `${field}: unknown country code “${code}”`);
  return rows[0].id;
}

/**
 * Add or update an applicant.
 *
 * Enforced here: tenant ownership, the configured file-size limit, passport
 * uniqueness inside a tenant, date ordering (validated in the schema), the
 * "closed file is frozen" rule, and — because the applicant count feeds the
 * checklist and the invoice — the snapshot re-check + checklist flag refresh.
 */
export async function upsertApplicant(
  actor: OpActor,
  applicationId: string,
  rawInput: ApplicantInput,
  applicantId?: string | null,
): Promise<{ id: string }> {
  assertActorPermission(actor, "applications.write");
  return withTx((tx) => upsertApplicantInsideTx(tx, actor, applicationId, rawInput, applicantId));
}

/**
 * The transactional body, exposed for callers that already hold a transaction
 * (an accepted AI suggestion writes through this, so the applicant change, the
 * checklist refresh and the suggestion status flip commit together).
 */
export async function upsertApplicantInsideTx(
  tx: Database,
  actor: OpActor,
  applicationId: string,
  rawInput: ApplicantInput,
  applicantId?: string | null,
): Promise<{ id: string }> {
  // Validated HERE, not only at the edge: a service can be called by a route, a
  // server action, an automation task or a future integration, and every one of
  // them must meet the same rules (dates, formats, bounds). The transport layer
  // validates too — defence in depth, never as the only gate.
  const parsed = applicantUpsertSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new DomainError(
      "VALIDATION",
      "Applicant details need attention",
      parsed.error.issues.map((i) => `${i.path.join(".") || "applicant"}: ${i.message}`),
    );
  }
  const input = parsed.data as ApplicantInput;
  {
    const t: Q = tx;
    const app = await loadApplicationForUpdate(tx, actor, applicationId);
    const st = await loadStatusById(app.statusId, tx);
    if (st.isTerminal) {
      throw new DomainError("STATE_CONFLICT", "A closed file has no applicant changes — reopen it first");
    }
    if (!actor.isStaff) {
      const ops = await readOpsSettings(tx);
      if (st.code !== "NEW" && !ops.allowLateAgencyEdits) {
        throw new DomainError(
          "STATE_CONFLICT",
          "The ESSAFARIA desk already picked this file up — ask them to send it back before changing travellers",
        );
      }
    }

    const nationalityId = await resolveCountryCode(t, input.nationalityCountryCode, "Nationality");
    const birthId = await resolveCountryCode(t, input.birthCountryCode, "Birth country");
    const passportIssueCountryId = await resolveCountryCode(t, input.passportIssueCountryCode, "Passport issued in");

    if (input.passportNumber) {
      const clash = (await t
        .select({ id: applicants.id, reference: visaApplications.reference })
        .from(applicants)
        .innerJoin(visaApplications, eq(visaApplications.id, applicants.applicationId))
        .where(
          and(
            eq(applicants.agencyId, app.agencyId),
            eq(applicants.isActive, true),
            sql`upper(${applicants.passportNumber}) = upper(${input.passportNumber})`,
            applicantId ? sql`${applicants.id} <> ${applicantId}` : undefined,
          ),
        )
        .limit(1)) as Array<{ id: string; reference: string }>;
      if (clash[0]) {
        throw new DomainError(
          "DUPLICATE",
          `Passport ${input.passportNumber} is already used on ${clash[0].reference}`,
        );
      }
    }

    const values: Record<string, unknown> = {
      fullName: input.fullName.trim(),
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      dateOfBirth: input.dateOfBirth ?? null,
      gender: input.gender ?? null,
      maritalStatus: input.maritalStatus ?? null,
      nationalityCountryId: nationalityId,
      birthCountryId: birthId,
      passportNumber: input.passportNumber ?? null,
      passportIssueDate: input.passportIssueDate ?? null,
      passportExpiryDate: input.passportExpiryDate ?? null,
      passportIssueCountryId,
      phone: input.phone ?? null,
      email: input.email ?? null,
      address: input.address ?? null,
      intendedEntryDate: input.intendedEntryDate ?? null,
      intendedExitDate: input.intendedExitDate ?? null,
      notes: input.notes ?? null,
      updatedAt: new Date(),
    };

    let id: string;
    let isNew = false;
    if (applicantId) {
      // PROVE the relationship before writing: applicant → application → agency
      await assertApplicantOwnership(tx, {
        applicantId,
        applicationId: app.id,
        agencyId: app.agencyId,
      });
      await t.update(applicants).set(values).where(eq(applicants.id, applicantId));
      id = applicantId;
      if (input.isPrimary) {
        await t.update(applicants).set({ isPrimary: false }).where(and(eq(applicants.applicationId, app.id), sql`id <> ${applicantId}`));
        await t.update(applicants).set({ isPrimary: true }).where(eq(applicants.id, applicantId));
      }
    } else {
      const live = (await t
        .select({ n: sql<number>`count(*)::int` })
        .from(applicants)
        .where(and(eq(applicants.applicationId, app.id), eq(applicants.isActive, true)))) as Array<{ n: number }>;
      const existing = Number(live[0]?.n ?? 0);
      if (existing >= MAX_APPLICANTS) {
        throw new DomainError("VALIDATION", `A single file holds at most ${MAX_APPLICANTS} applicants — open another file`);
      }
      const maxOrder = (await t
        .select({ m: sql<number>`coalesce(max(${applicants.displayOrder}), 0)::int` })
        .from(applicants)
        .where(eq(applicants.applicationId, app.id))) as Array<{ m: number }>;
      const isFirst = existing === 0;
      const inserted = (await t
        .insert(applicants)
        .values({
          ...values,
          applicationId: app.id,
          agencyId: app.agencyId,
          displayOrder: Number(maxOrder[0]?.m ?? 0) + 1,
          isPrimary: input.isPrimary ?? isFirst,
          isActive: true,
        })
        .returning({ id: applicants.id })) as Array<{ id: string }>;
      id = inserted[0]!.id;
      isNew = true;
      if (!isFirst && input.isPrimary) {
        await t.update(applicants).set({ isPrimary: false }).where(and(eq(applicants.applicationId, app.id), sql`id <> ${id}`));
        await t.update(applicants).set({ isPrimary: true }).where(eq(applicants.id, id));
      }
    }

    // keep the two counters honest: applicants on file, and requested headcount
    const counted = (await t
      .select({ n: sql<number>`count(*)::int` })
      .from(applicants)
      .where(and(eq(applicants.applicationId, app.id), eq(applicants.isActive, true)))) as Array<{ n: number }>;
    const count = Number(counted[0]?.n ?? 0);
    const nextApp: Record<string, unknown> = { applicantCount: count, lastActivityAt: new Date(), updatedAt: new Date() };
    if (isNew && count > app.requestedCount) nextApp.requestedCount = Math.min(MAX_APPLICANTS, count);
    await t.update(visaApplications).set(nextApp).where(eq(visaApplications.id, app.id));

    // A headcount change moves both the checklist (per-applicant slots) and the
    // price, so re-snapshot and re-price while nothing has been collected.
    if (isNew) {
      await captureSnapshot({ applicationId: app.id, reason: "CONFIG_CHANGED", actorId: actor.id }, tx);
      await recomputeInvoiceTotals(app.id, tx);
    }
    await refreshChecklistFlag(app.id, tx, actor);

    await writeEvent(t, app, actor, {
      type: applicantId ? "APPLICANT_UPDATED" : "APPLICANT_ADDED",
      message: `${applicantId ? "Updated" : "Added"} applicant ${input.fullName.trim()}`,
      customerVisible: true,
      payload: { applicantId: id, count },
    });
    await auditIn(tx, {
      actor,
      action: applicantId ? "UPDATE" : "CREATE",
      entityType: "applicant",
      entityId: id,
      agencyId: app.agencyId,
      changes: { after: { applicationId: app.id, fullName: input.fullName, passport: input.passportNumber ? "***" : null } },
    });
    if (applicantId) {
      // documents reference the applicant slot; nothing to re-point, but the
      // checklist must be recomputed for any added/removed person
    } else {
      await notify(
        {
          agencyId: app.agencyId,
          applicationId: app.id,
          kind: "APPLICANT_ADDED",
          title: `Applicant added to ${app.reference}`,
          body: `${input.fullName.trim()} is now on this file. Their document checklist has been updated.`,
          link: `/agency/applications/${app.id}`,
          severity: "ACTION_REQUIRED",
          dedupeKey: `APPLICANT_ADDED:${app.id}:${id}`,
        },
        tx,
      );
    }
    return { id };
  }
}

/** Soft removal — history (and any documents already reviewed) is preserved. */
export async function removeApplicant(
  actor: OpActor,
  applicationId: string,
  applicantId: string,
  reason?: string | null,
): Promise<void> {
  assertActorPermission(actor, "applications.write");
  return withTx(async (tx: Database) => {
    const t: Q = tx;
    const app = await loadApplicationForUpdate(tx, actor, applicationId);
    const st = await loadStatusById(app.statusId, tx);
    if (st.isTerminal) throw new DomainError("STATE_CONFLICT", "A closed file cannot lose applicants");
    await assertApplicantOwnership(tx, { applicantId, applicationId: app.id, agencyId: app.agencyId });
    const docs = (await t
      .select({ n: sql<number>`count(*)::int` })
      .from(applicationDocuments)
      .where(and(eq(applicationDocuments.applicantId, applicantId), eq(applicationDocuments.isCurrent, true)))) as Array<{ n: number }>;
    const hasDocs = Number(docs[0]?.n ?? 0) > 0;
    if (hasDocs && !actor.isStaff) {
      throw new DomainError(
        "STATE_CONFLICT",
        "This traveller already has documents on the file — ask the ESSAFARIA desk to remove them",
      );
    }
    await t
      .update(applicants)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(applicants.id, applicantId));
    const counted = (await t
      .select({ n: sql<number>`count(*)::int` })
      .from(applicants)
      .where(and(eq(applicants.applicationId, app.id), eq(applicants.isActive, true)))) as Array<{ n: number }>;
    const remaining = Number(counted[0]?.n ?? 0);
    await t
      .update(visaApplications)
      .set({ applicantCount: remaining, lastActivityAt: new Date(), updatedAt: new Date() })
      .where(eq(visaApplications.id, app.id));
    // documents of a removed person no longer satisfy an open slot → recompute
    await t
      .update(applicationDocuments)
      .set({ isCurrent: false, updatedAt: new Date() })
      .where(and(eq(applicationDocuments.applicantId, applicantId), eq(applicationDocuments.isCurrent, true)));
    await captureSnapshot({ applicationId: app.id, reason: "RECHECK", actorId: actor.id }, tx);
    await recomputeInvoiceTotals(app.id, tx);
    await refreshChecklistFlag(app.id, tx, actor);
    await writeEvent(t, app, actor, {
      type: "APPLICANT_REMOVED",
      message: `Applicant removed${reason ? `: ${reason}` : ""}`,
      customerVisible: true,
      payload: { applicantId, remaining },
    });
    await auditIn(tx, {
      actor,
      action: "DEACTIVATE",
      entityType: "applicant",
      entityId: applicantId,
      agencyId: app.agencyId,
      metadata: { applicationId: app.id, reason: reason ?? null },
    });
  });
}

/** Reorder a traveller within the file (UI convenience; pure ordering change). */
export async function moveApplicant(
  actor: OpActor,
  applicationId: string,
  applicantId: string,
  direction: "up" | "down",
): Promise<void> {
  assertActorPermission(actor, "applications.write");
  return withTx(async (tx: Database) => {
    const t: Q = tx;
    const app = await loadApplicationForUpdate(tx, actor, applicationId);
    await assertApplicantOwnership(tx, { applicantId, applicationId: app.id, agencyId: app.agencyId });
    const rows = (await t
      .select({ id: applicants.id, displayOrder: applicants.displayOrder })
      .from(applicants)
      .where(and(eq(applicants.applicationId, app.id), eq(applicants.isActive, true)))
      .orderBy(asc(applicants.displayOrder))) as Array<{ id: string; displayOrder: number }>;
    const idx = rows.findIndex((r) => r.id === applicantId);
    const swap = direction === "up" ? idx - 1 : idx + 1;
    if (idx === -1 || swap < 0 || swap >= rows.length) return;
    const a = rows[idx]!;
    const b = rows[swap]!;
    await t.update(applicants).set({ displayOrder: b.displayOrder }).where(eq(applicants.id, a.id));
    await t.update(applicants).set({ displayOrder: a.displayOrder }).where(eq(applicants.id, b.id));
    await auditIn(tx, {
      actor,
      action: "REORDER",
      entityType: "applicant",
      entityId: applicantId,
      agencyId: app.agencyId,
      metadata: { direction },
    });
  });
}
