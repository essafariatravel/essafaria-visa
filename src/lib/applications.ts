import { and, asc, desc, eq, inArray, ilike, or, sql } from "drizzle-orm";
import {
  getDb,
  agencies,
  applicants,
  applicationEvents,
  applicationStatuses,
  countries,
  invoices,
  priorities,
  users,
  visaApplications,
  visaTypes,
  type Database,
  type VisaApplication,
} from "@/db";
import { ADMIN_ROLES, can } from "@/lib/rbac";
import {
  DomainError,
  affectedRows,
  assertActorPermission,
  assertApplicationTenant,
  auditIn,
  formatApplicationReference,
  loadStatusById,
  loadStatusCode,
  nextSequence,
  resolveInitialStatus,
  type Actor,
} from "@/lib/ops";
import type { OpActor } from "@/lib/guard";
import {
  captureSnapshot,
  currentRequirementsFor,
  deriveChecklist,
  loadDocumentStates,
  loadSnapshot,
  readOpsSettings,
  signatureOf,
  type CapturedSnapshot,
} from "@/lib/snapshot";
import { recomputeInvoiceTotals } from "@/lib/billing";
import { notify } from "@/lib/notifications";
import { withTx } from "@/lib/with-tx";

type Q = any;

/* ============================================================
 * Applications service — the Phase 3 core.
 *
 * Every public function here follows one contract:
 *
 *   actor check → tenant check → business-state check → validated write
 *   → audit row + timeline event + outbox notification, ALL inside ONE
 *   transaction → config cache invalidation.
 *
 * The rule that matters most for a multi-tenant platform: a client-supplied
 * id (agencyId, applicantId, documentTypeId, priorityId, caseOfficerUserId…)
 * is NEVER used as a fact. It is resolved to a row and the RELATIONSHIP is
 * re-proved from the database inside the same transaction that writes. A
 * forged id yields the same NOT_FOUND as a typo, so the API never becomes an
 * existence oracle for other tenants.
 *
 * Transaction discipline: every read/write inside `db.transaction` goes
 * through the passed `tx` handle. Resolving a second connection mid-transaction
 * would (on PostgreSQL) read and write OUTSIDE the atomic unit, and on the
 * embedded driver would deadlock — so helpers take a handle, always.
 * ============================================================ */

export interface ApplicationView {
  id: string;
  reference: string;
  agencyId: string;
  agencyName: string;
  countryName: string;
  visaTypeName: string;
  visaTypeCode: string;
  statusCode: string;
  statusLabel: string;
  statusColor: string | null;
  isTerminal: boolean;
  priorityCode: string | null;
  priorityLabel: string | null;
  requestedCount: number;
  applicantCount: number;
  travelDate: string | null;
  dueAt: string | null;
  submittedAt: string | null;
  checklistComplete: boolean;
  gateOverridden: boolean;
  notes: string | null;
  /** staff-only fields — absent from agency views entirely */
  staffNotes?: string | null;
  caseOfficerName?: string | null;
  consulateRef?: string | null;
  totalAmountCents?: number;
  currencyCode?: string;
  createdAt: string;
  lastActivityAt: string;
}

/* ---------------- shared query shape ---------------- */

const SELECT_FIELDS = {
  id: visaApplications.id,
  reference: visaApplications.reference,
  agencyId: visaApplications.agencyId,
  agencyName: agencies.name,
  countryName: visaApplications.countryName,
  visaTypeName: visaApplications.visaTypeName,
  visaTypeCode: visaApplications.visaTypeCode,
  statusCode: applicationStatuses.code,
  statusLabel: applicationStatuses.label,
  statusColor: applicationStatuses.color,
  isTerminal: applicationStatuses.isTerminal,
  priorityCode: priorities.code,
  priorityLabel: priorities.label,
  requestedCount: visaApplications.requestedCount,
  applicantCount: visaApplications.applicantCount,
  travelDate: visaApplications.travelDate,
  dueAt: visaApplications.dueAt,
  submittedAt: visaApplications.submittedAt,
  checklistComplete: visaApplications.checklistComplete,
  gateOverridden: visaApplications.gateOverridden,
  notes: visaApplications.notes,
  staffNotes: visaApplications.staffNotes,
  caseOfficerName: users.name,
  consulateRef: visaApplications.consulateRef,
  totalAmountCents: sql<number>`coalesce(${invoices.subtotalCents}, 0)`,
  currencyCode: invoices.currencyCode,
  createdAt: visaApplications.createdAt,
  lastActivityAt: visaApplications.lastActivityAt,
  statusId: visaApplications.statusId,
  visaTypeId: visaApplications.visaTypeId,
  currentSnapshotId: visaApplications.currentSnapshotId,
};

function baseQuery(t: Q) {
  return t
    .select(SELECT_FIELDS)
    .from(visaApplications)
    .innerJoin(agencies, eq(agencies.id, visaApplications.agencyId))
    .innerJoin(applicationStatuses, eq(applicationStatuses.id, visaApplications.statusId))
    .leftJoin(priorities, eq(priorities.id, visaApplications.priorityId))
    .leftJoin(users, eq(users.id, visaApplications.caseOfficerUserId))
    .leftJoin(
      invoices,
      and(eq(invoices.applicationId, visaApplications.id), sql`${invoices.status} <> 'VOID'`),
    );
}

function mapRow(r: Record<string, any>, includeStaffFields: boolean): ApplicationView {
  const base: ApplicationView = {
    id: r.id,
    reference: r.reference,
    agencyId: r.agencyId,
    agencyName: r.agencyName,
    countryName: r.countryName,
    visaTypeName: r.visaTypeName,
    visaTypeCode: r.visaTypeCode,
    statusCode: r.statusCode,
    statusLabel: r.statusLabel,
    statusColor: r.statusColor ?? null,
    isTerminal: Boolean(r.isTerminal),
    priorityCode: r.priorityCode ?? null,
    priorityLabel: r.priorityLabel ?? null,
    requestedCount: Number(r.requestedCount),
    applicantCount: Number(r.applicantCount),
    travelDate: r.travelDate ?? null,
    dueAt: r.dueAt ? String(r.dueAt) : null,
    submittedAt: r.submittedAt ? String(r.submittedAt) : null,
    checklistComplete: Boolean(r.checklistComplete),
    gateOverridden: Boolean(r.gateOverridden),
    notes: r.notes ?? null,
    createdAt: String(r.createdAt),
    lastActivityAt: String(r.lastActivityAt),
  };
  if (includeStaffFields) {
    base.staffNotes = r.staffNotes ?? null;
    base.caseOfficerName = r.caseOfficerName ?? null;
    base.consulateRef = r.consulateRef ?? null;
    base.totalAmountCents = Number(r.totalAmountCents ?? 0);
    base.currencyCode = r.currencyCode ?? "EUR";
  }
  return base;
}

/** Tenant scope applied to EVERY list and single-row read. Staff see the whole
 *  book of work; agency users see only their own rows, and only statuses the
 *  platform marked customer-visible. */
function scopeCondition(actor: OpActor): unknown {
  if (actor.isStaff) return undefined;
  if (!actor.agencyIds.length) return sql`false`;
  return inArray(visaApplications.agencyId, actor.agencyIds);
}

/* ---------------- reads ---------------- */

export interface ListApplicationsInput {
  /** every filter accepts null so a validated-and-emptied optional field can be
   *  passed straight through without a `?? undefined` dance at each call site */
  q?: string | null;
  statusCode?: string | null;
  agencyId?: string | null;
  visaTypeId?: string | null;
  priorityId?: string | null;
  onlyBlocking?: boolean;
  onlyOpen?: boolean;
  assignedToMe?: boolean;
  page?: number;
  pageSize?: number;
}

export interface PagedApplications {
  rows: ApplicationView[];
  page: number;
  pageSize: number;
  total: number;
  statusCounts: Array<{ code: string; label: string; color: string | null; n: number }>;
}

export async function listApplications(
  actor: OpActor,
  input: ListApplicationsInput = {},
): Promise<PagedApplications> {
  assertActorPermission(actor, "applications.read");
  const t: Q = await getDb();
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(5, input.pageSize ?? 25));
  const conds: unknown[] = [];
  const scope = scopeCondition(actor);
  if (scope) conds.push(scope);
  if (!actor.isStaff) conds.push(eq(applicationStatuses.customerVisible, true));
  if (input.q) {
    const like = `%${input.q.trim().replace(/[%_]/g, "")}%`;
    conds.push(
      or(
        ilike(visaApplications.reference, like),
        ilike(visaApplications.visaTypeName, like),
        ilike(visaApplications.countryName, like),
        ilike(visaApplications.notes, like),
        actor.isStaff ? ilike(visaApplications.staffNotes, like) : undefined,
      ),
    );
  }
  if (input.statusCode) conds.push(sql`${applicationStatuses.code} = upper(${input.statusCode})`);
  if (input.visaTypeId) conds.push(eq(visaApplications.visaTypeId, input.visaTypeId));
  if (input.priorityId) conds.push(eq(visaApplications.priorityId, input.priorityId));
  if (input.onlyBlocking) conds.push(eq(visaApplications.checklistComplete, false));
  if (input.onlyOpen) conds.push(eq(applicationStatuses.isTerminal, false));
  if (input.assignedToMe && actor.isStaff) conds.push(eq(visaApplications.caseOfficerUserId, actor.id));
  if (input.agencyId && actor.isStaff) conds.push(eq(visaApplications.agencyId, input.agencyId));

  const where = conds.length ? and(...(conds as never[])) : undefined;

  const rowsQ = where
    ? baseQuery(t)
        .where(where)
        .orderBy(desc(visaApplications.lastActivityAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
    : baseQuery(t).orderBy(desc(visaApplications.lastActivityAt)).limit(pageSize).offset((page - 1) * pageSize);
  const rows = (await rowsQ) as Array<Record<string, any>>;

  const countQ = t
    .select({ n: sql<number>`count(distinct ${visaApplications.id})::int` })
    .from(visaApplications)
    .innerJoin(applicationStatuses, eq(applicationStatuses.id, visaApplications.statusId))
    .innerJoin(agencies, eq(agencies.id, visaApplications.agencyId));
  const counted = (where ? await countQ.where(where) : await countQ) as Array<{ n: number }>;

  // status facet counts: one grouped query, not one per status
  const facetConds: unknown[] = [];
  if (scope) facetConds.push(scope);
  if (!actor.isStaff) facetConds.push(eq(applicationStatuses.customerVisible, true));
  const facetRows = (await t
    .select({
      code: applicationStatuses.code,
      label: applicationStatuses.label,
      color: applicationStatuses.color,
      n: sql<number>`count(*)::int`,
    })
    .from(visaApplications)
    .innerJoin(applicationStatuses, eq(applicationStatuses.id, visaApplications.statusId))
    .where(facetConds.length ? and(...(facetConds as never[])) : undefined)
    .groupBy(
      applicationStatuses.code,
      applicationStatuses.label,
      applicationStatuses.color,
      applicationStatuses.displayOrder,
    )
    .orderBy(asc(applicationStatuses.displayOrder))) as Array<{
    code: string;
    label: string;
    color: string | null;
    n: number;
  }>;

  return {
    rows: rows.map((r) => mapRow(r, actor.isStaff)),
    page,
    pageSize,
    total: Number(counted[0]?.n ?? 0),
    statusCounts: facetRows.map((f) => ({ code: f.code, label: f.label, color: f.color ?? null, n: Number(f.n) })),
  };
}

export async function getApplication(
  actor: OpActor,
  id: string,
): Promise<{ app: VisaApplication; view: ApplicationView }> {
  assertActorPermission(actor, "applications.read");
  const t: Q = await getDb();
  const [row] = (await baseQuery(t).where(eq(visaApplications.id, id)).limit(1)) as Array<Record<string, any>>;
  if (!row) throw new DomainError("NOT_FOUND", "Application not found");
  if (!actor.isStaff) {
    if (!actor.agencyIds.includes(row.agencyId)) throw new DomainError("NOT_FOUND", "Application not found");
    const st = await loadStatusCode(row.statusCode);
    // an internal status is invisible to the agency — same answer as "missing"
    if (st && !st.customerVisible) throw new DomainError("NOT_FOUND", "Application not found");
  }
  return { app: row as unknown as VisaApplication, view: mapRow(row, actor.isStaff) };
}

/** Row lock + tenant proof. Used by every mutation. */
async function loadApplicationForUpdate(t: Q, actor: OpActor, id: string): Promise<VisaApplication> {
  const rows = (await t
    .select()
    .from(visaApplications)
    .where(eq(visaApplications.id, id))
    .limit(1)
    .for("update")) as unknown as VisaApplication[];
  const app = rows[0];
  if (!app) throw new DomainError("NOT_FOUND", "Application not found");
  if (!actor.isStaff && !actor.agencyIds.includes(app.agencyId)) {
    throw new DomainError("NOT_FOUND", "Application not found");
  }
  return app;
}

async function loadApplicationReadOnly(t: Q, actor: OpActor, id: string): Promise<VisaApplication> {
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

/* ---------------- timeline ---------------- */

export interface TimelineEntry {
  id: string;
  type: string;
  message: string | null;
  actorEmail: string | null;
  actorKind: string;
  createdAt: string;
  fromStatusCode: string | null;
  toStatusCode: string | null;
  payload: Record<string, unknown> | null;
}

export async function listTimeline(
  actor: OpActor,
  applicationId: string,
  opts: { customerView?: boolean; limit?: number } = {},
): Promise<TimelineEntry[]> {
  assertActorPermission(actor, "applications.read");
  const t: Q = await getDb();
  const app = await loadApplicationReadOnly(t, actor, applicationId);
  const conds: unknown[] = [eq(applicationEvents.applicationId, app.id)];
  if (opts.customerView) conds.push(eq(applicationEvents.customerVisible, true));
  const rows = (await t
    .select({
      id: applicationEvents.id,
      type: applicationEvents.type,
      message: applicationEvents.message,
      actorEmail: applicationEvents.actorEmail,
      actorKind: applicationEvents.actorKind,
      createdAt: applicationEvents.createdAt,
      fromStatusId: applicationEvents.fromStatusId,
      toStatusId: applicationEvents.toStatusId,
      payload: applicationEvents.payload,
    })
    .from(applicationEvents)
    .where(and(...(conds as never[])))
    .orderBy(desc(applicationEvents.createdAt))
    .limit(Math.min(200, opts.limit ?? 60))) as unknown as Array<Record<string, any>>;

  // resolve status codes for the whole page in ONE query (no N+1)
  const statusIds = [...new Set(rows.flatMap((r) => [r.fromStatusId, r.toStatusId]).filter(Boolean) as string[])];
  const codeById = new Map<string, string>();
  if (statusIds.length) {
    const sts = (await t
      .select({ id: applicationStatuses.id, code: applicationStatuses.code })
      .from(applicationStatuses)
      .where(inArray(applicationStatuses.id, statusIds))) as Array<{ id: string; code: string }>;
    for (const s of sts) codeById.set(s.id, s.code);
  }
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    message: r.message ?? null,
    actorEmail: r.actorEmail ?? null,
    actorKind: r.actorKind,
    createdAt: String(r.createdAt),
    fromStatusCode: r.fromStatusId ? codeById.get(r.fromStatusId) ?? null : null,
    toStatusCode: r.toStatusId ? codeById.get(r.toStatusId) ?? null : null,
    payload: (r.payload as Record<string, unknown> | null) ?? null,
  }));
}

/* ---------------- event writer ---------------- */

export interface EventInput {
  type: string;
  message?: string | null;
  payload?: Record<string, unknown> | null;
  customerVisible?: boolean;
  actorKind?: "USER" | "SYSTEM" | "AUTOMATION" | "GMAIL" | "AI";
  fromStatusId?: string | null;
  toStatusId?: string | null;
}

export async function writeEvent(
  t: Q,
  app: { id: string; agencyId: string },
  actor: Actor | null,
  e: EventInput,
): Promise<string> {
  const rows = (await t
    .insert(applicationEvents)
    .values({
      applicationId: app.id,
      agencyId: app.agencyId,
      type: e.type,
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      actorKind: e.actorKind ?? (actor ? "USER" : "SYSTEM"),
      message: e.message ?? null,
      payload: e.payload ?? null,
      customerVisible: e.customerVisible ?? false,
      fromStatusId: e.fromStatusId ?? null,
      toStatusId: e.toStatusId ?? null,
    })
    .returning({ id: applicationEvents.id })) as Array<{ id: string }>;
  return rows[0]!.id;
}

/* ---------------- create ---------------- */

export interface CreateApplicationInput {
  /** resolved by configured code OR by stable id — both are admin handles */
  visaTypeCode?: string | null;
  visaTypeId?: string | null;
  requestedCount?: number;
  priorityCode?: string | null;
  travelDate?: string | null;
  notes?: string | null;
  /** staff only: open a file on behalf of an agency */
  agencyId?: string | null;
}

export async function createApplication(
  actor: OpActor,
  input: CreateApplicationInput,
): Promise<{ id: string; reference: string }> {
  assertActorPermission(actor, "applications.write");
  return withTx(async (tx: Database) => {
    const q: Q = tx;

    // 1. resolve the visa type FROM CONFIGURATION (never from a client label)
    const pick = (extra: unknown) =>
      q
        .select({
          id: visaTypes.id,
          code: visaTypes.code,
          name: visaTypes.name,
          countryId: visaTypes.countryId,
          countryName: countries.name,
          categoryId: visaTypes.categoryId,
          isActive: visaTypes.isActive,
        })
        .from(visaTypes)
        .innerJoin(countries, eq(countries.id, visaTypes.countryId))
        .where(extra as never)
        .limit(1);
    let visaType:
      | { id: string; code: string; name: string; countryId: string; countryName: string; categoryId: string | null; isActive: boolean }
      | undefined;
    if (input.visaTypeId) visaType = (await pick(eq(visaTypes.id, input.visaTypeId)))[0] as typeof visaType;
    else if (input.visaTypeCode)
      visaType = (await pick(sql`${visaTypes.code} = upper(${input.visaTypeCode})`))[0] as typeof visaType;
    if (!visaType || !visaType.isActive) {
      throw new DomainError("VALIDATION", "Choose an active visa route");
    }

    // 2. resolve the tenant: agency users are pinned to their membership
    const agencyId = actor.isStaff ? (input.agencyId ?? actor.actingAgencyId) : actor.actingAgencyId;
    if (!agencyId) throw new DomainError("VALIDATION", "An agency is required to open a file");
    if (!actor.isStaff && !actor.agencyIds.includes(agencyId)) {
      throw new DomainError("NOT_FOUND", "Agency not found");
    }
    const agency = (await q
      .select({ id: agencies.id, status: agencies.status })
      .from(agencies)
      .where(eq(agencies.id, agencyId))
      .limit(1))[0] as { id: string; status: string } | undefined;
    if (!agency) throw new DomainError("NOT_FOUND", "Agency not found");
    if (!actor.isStaff && agency.status !== "ACTIVE") {
      throw new DomainError("STATE_CONFLICT", "This agency account is not active — contact your ESSAFARIA desk");
    }
    if (actor.isStaff && !actor.mayCreateForAgency) {
      throw new DomainError("FORBIDDEN", "You may not open files on behalf of agencies");
    }

    // 3. optional priority, also resolved from configuration
    let priorityId: string | null = null;
    if (input.priorityCode) {
      const p = (await q
        .select({ id: priorities.id, isActive: priorities.isActive })
        .from(priorities)
        .where(sql`${priorities.code} = upper(${input.priorityCode})`)
        .limit(1))[0] as { id: string; isActive: boolean } | undefined;
      if (!p || !p.isActive) throw new DomainError("VALIDATION", "Choose an active priority");
      priorityId = p.id;
    }

    const initial = await resolveInitialStatus(tx);
    const requestedCount = Math.min(50, Math.max(1, input.requestedCount ?? 1));

    // 4. mint a reference under a row lock; unique index is the backstop
    const period = String(new Date().getUTCFullYear());
    let reference = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const n = await nextSequence(period, tx);
      reference = formatApplicationReference(period, n);
      const clash = await q
        .select({ id: visaApplications.id })
        .from(visaApplications)
        .where(eq(visaApplications.reference, reference))
        .limit(1);
      if (!clash.length) break;
      if (attempt === 1) throw new DomainError("RACE", "Reference collision — please retry");
    }

    const inserted = (await q
      .insert(visaApplications)
      .values({
        reference,
        agencyId: agency.id,
        createdByUserId: actor.id,
        origin: actor.isStaff ? "BACK_OFFICE" : "AGENCY_PORTAL",
        countryId: visaType.countryId,
        visaTypeId: visaType.id,
        categoryId: visaType.categoryId ?? null,
        countryName: visaType.countryName,
        visaTypeName: visaType.name,
        visaTypeCode: visaType.code,
        statusId: initial.id,
        priorityId,
        requestedCount,
        applicantCount: 0,
        travelDate: input.travelDate ?? null,
        notes: input.notes ?? null,
        checklistComplete: false,
        lastActivityAt: new Date(),
      })
      .returning({ id: visaApplications.id })) as Array<{ id: string }>;
    const id = inserted[0]!.id;
    const app = { id, agencyId: agency.id };

    // 5. freeze the requirement + fee set this file starts life with
    const snap = await captureSnapshot({ applicationId: id, reason: "CREATED", actorId: actor.id }, tx);

    await writeEvent(q, app, actor, {
      type: "APPLICATION_CREATED",
      message: `File ${reference} opened for ${visaType.name} (${visaType.countryName})`,
      customerVisible: true,
      payload: { visaTypeCode: visaType.code, snapshotId: snap.id, requestedCount },
    });
    await auditIn(tx, {
      actor,
      action: "CREATE",
      entityType: "visa_application",
      entityId: id,
      agencyId: agency.id,
      changes: { after: { reference, visaTypeCode: visaType.code, requestedCount } },
    });
    await notify(
      {
        agencyId: agency.id,
        applicationId: id,
        kind: "APPLICATION_RECEIVED",
        title: `Application ${reference} received`,
        body: `Your application for ${visaType.name} (${visaType.countryName}) is open. ${
          snap.requirements.filter((r) => r.isRequired).length
        } required document group(s) are listed on the checklist.`,
        link: `/agency/applications/${id}`,
        severity: "ACTION_REQUIRED",
        dedupeKey: `APPLICATION_RECEIVED:${id}`,
        email: { templateCode: "APPLICATION_RECEIVED", subject: `Application ${reference} received` },
      },
      tx,
    );
    return { id, reference };
  });
}

/* ---------------- update (state-aware) ---------------- */

export async function updateApplication(
  actor: OpActor,
  id: string,
  patch: {
    requestedCount?: number;
    priorityId?: string | null;
    travelDate?: string | null;
    notes?: string | null;
    caseOfficerUserId?: string | null;
    consulateRef?: string | null;
    staffNotes?: string | null;
  },
): Promise<void> {
  assertActorPermission(actor, "applications.write");
  await withTx(async (tx: Database) => {
    const q: Q = tx;
    const app = await loadApplicationForUpdate(tx, actor, id);
    const status = await loadStatusById(app.statusId, tx);
    if (status.isTerminal) {
      throw new DomainError("STATE_CONFLICT", "A closed file cannot be edited — reopen it first");
    }

    const staffOnlyFields = ["caseOfficerUserId", "staffNotes", "consulateRef"] as const;
    if (!actor.isStaff) {
      for (const f of staffOnlyFields) {
        if (patch[f] !== undefined) {
          // A client must not be able to write staff-only columns even by accident.
          throw new DomainError("FORBIDDEN", "That field is managed by ESSAFARIA staff");
        }
      }
      // agencies may only edit before the desk takes the file onward
      const editable = await q
        .select({ allowAgencyEdits: applicationStatuses.code })
        .from(applicationStatuses)
        .where(eq(applicationStatuses.id, app.statusId))
        .limit(1) as Array<{ allowAgencyEdits: string }>;
      const ops = await readOpsSettings(tx);
      if (editable[0]?.allowAgencyEdits !== "NEW" && !ops.allowLateAgencyEdits) {
        throw new DomainError(
          "STATE_CONFLICT",
          "This file has moved past intake — ask the ESSAFARIA desk to send it back before editing",
        );
      }
    }

    const next: Record<string, unknown> = { updatedAt: new Date(), lastActivityAt: new Date() };
    if (patch.requestedCount !== undefined) {
      const count = Math.min(50, Math.max(1, patch.requestedCount));
      const live = (await q
        .select({ n: sql<number>`count(*)::int` })
        .from(applicants)
        .where(and(eq(applicants.applicationId, app.id), eq(applicants.isActive, true)))) as Array<{ n: number }>;
      const existing = Number(live[0]?.n ?? 0);
      if (count < existing) {
        throw new DomainError("VALIDATION", `Requested count cannot drop below the ${existing} applicant(s) on file`);
      }
      next.requestedCount = count;
    }
    if (patch.priorityId !== undefined) {
      if (patch.priorityId === null) next.priorityId = null;
      else {
        const p = (await q
          .select({ id: priorities.id, isActive: priorities.isActive })
          .from(priorities)
          .where(eq(priorities.id, patch.priorityId as string))
          .limit(1)) as Array<{ id: string; isActive: boolean }>;
        if (!p[0]?.isActive) throw new DomainError("VALIDATION", "Choose an active priority");
        next.priorityId = p[0].id;
      }
    }
    if (patch.travelDate !== undefined) next.travelDate = patch.travelDate;
    if (patch.notes !== undefined) next.notes = patch.notes;
    if (actor.isStaff) {
      if (patch.caseOfficerUserId !== undefined) {
        if (patch.caseOfficerUserId === null) next.caseOfficerUserId = null;
        else {
          const u = (await q
            .select({ id: users.id, isActive: users.isActive, role: users.role })
            .from(users)
            .where(eq(users.id, patch.caseOfficerUserId as string))
            .limit(1)) as Array<{ id: string; isActive: boolean; role: string }>;
          if (!u[0]?.isActive || !can(u[0].role as never, "applications.read")) {
            throw new DomainError("VALIDATION", "Assign files only to active staff members");
          }
          next.caseOfficerUserId = u[0].id;
        }
      }
      if (patch.consulateRef !== undefined) next.consulateRef = patch.consulateRef;
      if (patch.staffNotes !== undefined) next.staffNotes = patch.staffNotes;
    }

    const changed = Object.keys(next).filter((k) => k !== "updatedAt" && k !== "lastActivityAt");
    if (!changed.length) return;

    await q.update(visaApplications).set(next).where(eq(visaApplications.id, app.id));

    // Pricing depends on count + priority → re-snapshot so the bill follows
    // THIS file's new configuration without rewriting earlier snapshots.
    if (changed.includes("requestedCount") || changed.includes("priorityId")) {
      await captureSnapshot({ applicationId: app.id, reason: "CONFIG_CHANGED", actorId: actor.id }, tx);
      await recomputeInvoiceTotals(app.id, tx);
    }
    await writeEvent(q, app, actor, {
      type: "APPLICATION_UPDATED",
      message: `Updated: ${changed.join(", ")}`,
      customerVisible: changed.some((k) => !staffOnlyFields.includes(k as never)),
      payload: { fields: changed },
    });
    await auditIn(tx, {
      actor,
      action: "UPDATE",
      entityType: "visa_application",
      entityId: app.id,
      agencyId: app.agencyId,
      changes: { before: { statusId: app.statusId }, after: next },
    });
  });
}

/* ---------------- status transitions (configured state machine) ---------------- */

export interface TransitionResult {
  fromStatusCode: string;
  toStatusCode: string;
  overrodeGate: boolean;
}

/**
 * Workflow rules, all read from configuration:
 *   • the target status must exist and be active; an agency may not even
 *     address a status flagged internal
 *   • the current status' allowedNextStatusCodes governs the graph
 *     (null = permissive, [] = no exits, list = exactly those)
 *   • a terminal file is frozen unless an override authority reopens it
 *   • a status flagged requires_documents_complete enforces a clean checklist;
 *     staff may bypass it ONLY with a mandatory reason, and the bypass is
 *     permanently flagged on the file and audited
 *   • the write is conditional on the status we validated, so two reviewers
 *     cannot silently overwrite each other
 */
export async function transitionStatus(
  actor: OpActor,
  applicationId: string,
  input: { toStatusCode: string; reason?: string | null; forceOverride?: boolean },
): Promise<TransitionResult> {
  return withTx(async (tx: Database) => {
    const q: Q = tx;
    const app = await loadApplicationForUpdate(tx, actor, applicationId);
    const from = await loadStatusById(app.statusId, tx);
    const to = await loadStatusCode(input.toStatusCode, tx);
    if (!to) throw new DomainError("VALIDATION", `Unknown status: ${input.toStatusCode}`);
    if (to.id === from.id) throw new DomainError("STATE_CONFLICT", `This file is already “${from.label}”`);
    if (!actor.isStaff && !to.customerVisible) throw new DomainError("NOT_FOUND", "Application not found");

    if (from.isTerminal && !(actor.isStaff && can(actor.role, "applications.override"))) {
      throw new DomainError("STATE_CONFLICT", "This file is closed — a supervisor must reopen it");
    }
    if (from.allowedNextStatusCodes && !from.allowedNextStatusCodes.includes(to.code)) {
      throw new DomainError(
        "STATE_CONFLICT",
        from.allowedNextStatusCodes.length
          ? `“${from.label}” can only move to: ${from.allowedNextStatusCodes.join(", ")}`
          : `“${from.label}” has no configured next step`,
      );
    }

    let overrodeGate = false;
    let overrideReason: string | null = null;
    if (to.requiresDocumentsComplete) {
      const ops = await readOpsSettings(tx);
      const checklist = await buildChecklistFromApp(app, tx, actor.id);
      if (!checklist.complete) {
        const outstanding = checklist.blocking.map((b) => b.reason).join("; ");
        if (!actor.isStaff) {
          throw new DomainError(
            "GATE_FAILED",
            ops.agencySelfSubmit
              ? `Checklist incomplete: ${outstanding}`
              : `Submission is handled by the ESSAFARIA desk. Outstanding: ${outstanding}`,
            checklist.blocking.map((b) => b.reason),
          );
        }
        if (!input.forceOverride) {
          throw new DomainError("GATE_FAILED", `Checklist incomplete: ${outstanding}`, checklist.blocking.map((b) => b.reason));
        }
        if (!can(actor.role, "applications.override")) {
          throw new DomainError("FORBIDDEN", "You may not override a document gate");
        }
        const reason = (input.reason ?? "").trim();
        if (reason.length < 20) {
          throw new DomainError(
            "VALIDATION",
            "An override reason of at least 20 characters is mandatory and stays on the file",
          );
        }
        overrodeGate = true;
        overrideReason = reason.slice(0, 2000);
        await q
          .update(visaApplications)
          .set({
            submissionOverrideReason: overrideReason,
            submissionOverrideBy: actor.id,
            submissionOverrideAt: new Date(),
            gateOverridden: true,
          })
          .where(eq(visaApplications.id, app.id));
      }
    }

    const next: Record<string, unknown> = {
      statusId: to.id,
      statusSnapshotAt: new Date(),
      updatedAt: new Date(),
      lastActivityAt: new Date(),
      checklistComplete: checklistCompleteFor(to, await buildChecklistFromApp(app, tx, actor.id)),
    };
    if (!app.submittedAt && (to.code === "SUBMITTED" || to.requiresDocumentsComplete)) {
      next.submittedAt = new Date();
      next.submittedByUserId = actor.id;
    }
    if (to.isTerminal) next.closedAt = new Date();
    if (!to.isTerminal && app.closedAt) next.closedAt = null; // reopened

    const res = await q
      .update(visaApplications)
      .set(next)
      .where(and(eq(visaApplications.id, app.id), eq(visaApplications.statusId, from.id)));
    if (affectedRows(res) !== 1) {
      throw new DomainError("RACE", "The file changed while you were working — reload and try again");
    }

    await writeEvent(q, app, actor, {
      type: "STATUS_CHANGED",
      message: overrodeGate
        ? `Status moved ${from.label} → ${to.label} (document gate overridden by staff)`
        : `Status moved ${from.label} → ${to.label}`,
      customerVisible: to.customerVisible,
      fromStatusId: from.id,
      toStatusId: to.id,
      payload: { override: overrodeGate ? { reason: overrideReason } : null, note: input.reason ?? null },
    });
    await auditIn(tx, {
      actor,
      action: overrodeGate ? "OVERRIDE" : "TRANSITION",
      entityType: "visa_application",
      entityId: app.id,
      agencyId: app.agencyId,
      changes: {
        before: { status: from.code },
        after: { status: to.code, overrideReason },
      },
    });
    await notify(
      {
        agencyId: app.agencyId,
        applicationId: app.id,
        kind: "STATUS_CHANGED",
        title: `Application ${app.reference} — ${to.label}`,
        body: input.reason ? `${to.label}. ${input.reason}` : `Current status: ${to.label}.`,
        link: `/agency/applications/${app.id}`,
        severity: to.code === "REFUSED" ? "WARNING" : to.isTerminal ? "SUCCESS" : "INFO",
        audienceRole: "AGENCY_ADMIN",
        // one notification per (file, status, instant): returning to the same
        // status later is a new event and must notify again
        dedupeKey: `STATUS:${app.id}:${to.id}:${(next.statusSnapshotAt as Date).toISOString()}`,
        email: { templateCode: "PROCESSING_UPDATE" },
      },
      tx,
    );
    // Billing at the submission gate: raise the invoice from the frozen
    // snapshot, and charge the wallet only if the platform is configured to
    // auto-charge (otherwise the desk charges it deliberately).
    if (to.code === "SUBMITTED" || to.requiresDocumentsComplete) {
      const { applySubmissionBilling } = await import("@/lib/billing");
      await applySubmissionBilling(actor, app.id, tx);
    }

    if (overrodeGate) {
      await notify(
        {
          staffOnly: true,
          applicationId: app.id,
          agencyId: app.agencyId,
          kind: "GATE_OVERRIDE",
          title: `Document gate overridden on ${app.reference}`,
          body: `${actor.email} moved this file to ${to.label} with an incomplete checklist: ${overrideReason}`,
          link: `/admin/applications/${app.id}`,
          severity: "WARNING",
          dedupeKey: `GATE_OVERRIDE:${app.id}:${(next.statusSnapshotAt as Date).toISOString()}`,
        },
        tx,
      );
    }
    return { fromStatusCode: from.code, toStatusCode: to.code, overrodeGate };
  });
}

/** A status flagged requires_documents_complete can only be ENTERED when the
 *  checklist is clean (or a staff override was recorded), so while a file sits
 *  in such a status completeness is true by definition. Anywhere else we store
 *  the computed value, keeping the list filter honest. */
function checklistCompleteFor(
  to: { requiresDocumentsComplete: boolean },
  checklist: { complete: boolean },
): boolean {
  return to.requiresDocumentsComplete ? true : checklist.complete;
}

/* ---------------- checklist ---------------- */

async function buildChecklistFromApp(app: VisaApplication, tx?: Database, actorId?: string | null) {
  const t: Q = tx ?? (await getDb());
  let snapshot = app.currentSnapshotId ? await loadSnapshot(app.currentSnapshotId, tx) : null;
  if (!snapshot) {
    // A file always receives a snapshot at creation; if the pointer is gone we
    // capture a fresh one rather than inventing requirements.
    snapshot = await captureSnapshot({ applicationId: app.id, reason: "RECHECK", actorId: actorId ?? null }, tx);
  }
  const applicantRows = (await t
    .select({ id: applicants.id })
    .from(applicants)
    .where(and(eq(applicants.applicationId, app.id), eq(applicants.isActive, true)))) as Array<{ id: string }>;
  const docMap = await loadDocumentStates([app.id], tx);
  return deriveChecklist(snapshot, {
    applicantIds: applicantRows.map((a) => a.id),
    documents: docMap.get(app.id) ?? [],
  });
}

export interface ChecklistBundle {
  snapshot: CapturedSnapshot | null;
  items: Awaited<ReturnType<typeof deriveChecklist>>["items"];
  requiredTotal: number;
  requiredSatisfied: number;
  blocking: Awaited<ReturnType<typeof deriveChecklist>>["blocking"];
  complete: boolean;
  configDrifted: boolean;
  agencySelfSubmit: boolean;
}

/**
 * The checklist, its blocking reasons and the drift hint. `tx` is accepted so
 * this can run INSIDE another service's transaction — a checklist read that
 * grabbed its own connection mid-transaction would see pre-commit state (and
 * on the embedded driver would deadlock), which is precisely the bug class
 * withTx exists to prevent.
 */
export async function computeChecklistBundle(
  actor: OpActor,
  applicationId: string,
  tx?: Database,
): Promise<ChecklistBundle> {
  const t: Q = tx ?? (await getDb());
  const app = await loadApplicationReadOnly(t, actor, applicationId);
  const snapshot = app.currentSnapshotId ? await loadSnapshot(app.currentSnapshotId, tx) : null;
  const result = await buildChecklistFromApp(app, tx, actor.id);
  let configDrifted = false;
  if (snapshot) {
    const live = await currentRequirementsFor(app.visaTypeId, tx);
    configDrifted = signatureOf(snapshot.requirements) !== signatureOf(live);
  }
  const ops = await readOpsSettings(tx);
  return {
    snapshot,
    items: result.items,
    requiredTotal: result.requiredTotal,
    requiredSatisfied: result.requiredSatisfied,
    blocking: result.blocking,
    complete: result.complete,
    configDrifted,
    agencySelfSubmit: ops.agencySelfSubmit,
  };
}

export async function getChecklist(actor: OpActor, applicationId: string): Promise<ChecklistBundle> {
  assertActorPermission(actor, "applications.read");
  return computeChecklistBundle(actor, applicationId);
}

/**
 * HTTP projection of a checklist bundle.
 *
 * The bundle is computed once and reused, so the raw object carries more than a
 * partner needs: `snapshot` is the whole frozen configuration (platform fee lines
 * with their internal descriptions, `config.agencySelfSubmit`, `perApplicantPolicy`,
 * `prioritySurchargePercent`, when the config was captured) and `configDrifted` is a
 * desk signal meaning “this file was frozen before the last configuration change”.
 * None of that changes what the partner must upload, and publishing it would teach
 * them which settings to lean on. So: the API answers with items + blocking reasons +
 * counts for partners, and with the full bundle for staff, who need the snapshot to
 * explain a decision.
 *
 * Pages read the service directly and are unaffected — this is a transport concern,
 * not a domain one. The authorization check that matters stays in the service.
 */
export function publicChecklistBundle(actor: OpActor, bundle: ChecklistBundle): ChecklistBundle | Omit<ChecklistBundle, "snapshot" | "configDrifted" | "agencySelfSubmit"> {
  if (actor.isStaff) return bundle;
  const { snapshot: _snapshot, configDrifted: _drift, agencySelfSubmit: _selfSubmit, ...partnerView } = bundle;
  void _snapshot;
  void _drift;
  void _selfSubmit;
  return partnerView;
}

/** Recompute + persist the denormalized gate flag. Called by every document
 *  mutation so the "waiting on documents" filter stays truthful. */
export async function refreshChecklistFlag(
  applicationId: string,
  tx: Database,
  actor: Actor | null,
): Promise<boolean> {
  const q: Q = tx;
  const app = (await q
    .select()
    .from(visaApplications)
    .where(eq(visaApplications.id, applicationId))
    .limit(1))[0] as VisaApplication | undefined;
  if (!app) return false;
  const result = await buildChecklistFromApp(app, tx, actor?.id ?? null);
  await q
    .update(visaApplications)
    .set({ checklistComplete: result.complete })
    .where(eq(visaApplications.id, applicationId));
  return result.complete;
}

/* ---------------- notes ---------------- */

export async function appendNote(
  actor: OpActor,
  applicationId: string,
  input: { body: string; customerVisible?: boolean },
): Promise<void> {
  assertActorPermission(actor, "applications.write");
  const body = (input.body ?? "").trim();
  if (body.length < 2) throw new DomainError("VALIDATION", "Write a real note (2 characters minimum)");
  if (body.length > 8000) throw new DomainError("VALIDATION", "Note is too long (8000 characters max)");
  const customerVisible = Boolean(input.customerVisible);
  if (!actor.isStaff && !customerVisible) {
    throw new DomainError("FORBIDDEN", "Agency notes are always visible to the agency");
  }
  await withTx(async (tx: Database) => {
    const q: Q = tx;
    const app = await loadApplicationForUpdate(tx, actor, applicationId);
    await writeEvent(q, app, actor, {
      type: customerVisible ? "NOTE_AGENCY" : "NOTE_INTERNAL",
      message: body,
      customerVisible,
    });
    await auditIn(tx, {
      actor,
      action: "CREATE",
      entityType: "application_note",
      entityId: app.id,
      agencyId: app.agencyId,
      metadata: { customerVisible, characters: body.length },
    });
    if (customerVisible) {
      await notify(
        {
          agencyId: app.agencyId,
          applicationId: app.id,
          kind: "NEW_MESSAGE",
          title: `New message on ${app.reference}`,
          body: body.slice(0, 1000),
          link: `/agency/applications/${app.id}`,
          severity: "ACTION_REQUIRED",
          dedupeKey: `NOTE:${app.id}:${Date.now()}`,
        },
        tx,
      );
    }
  });
}

/* ---------------- assignment ---------------- */

export async function assignCaseOfficer(
  actor: OpActor,
  applicationId: string,
  userId: string | null,
): Promise<void> {
  assertActorPermission(actor, "applications.assign");
  if (!actor.isStaff) throw new DomainError("FORBIDDEN", "Only staff may assign files");
  await withTx(async (tx: Database) => {
    const q: Q = tx;
    const app = await loadApplicationForUpdate(tx, actor, applicationId);
    let label: string | null = null;
    if (userId) {
      const u = (await q
        .select({ id: users.id, name: users.name, role: users.role, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)) as Array<{ id: string; name: string; role: string; isActive: boolean }>;
      if (!u[0]?.isActive) throw new DomainError("VALIDATION", "Choose an active staff member");
      // A capability test is NOT enough: agency admins may also read
      // applications. Owning a case must stay with ESSAFARIA staff.
      if (!ADMIN_ROLES.includes(u[0].role as never)) {
        throw new DomainError("VALIDATION", "A file can only be assigned to ESSAFARIA staff");
      }
      label = u[0].name;
    }
    await q
      .update(visaApplications)
      .set({ caseOfficerUserId: userId, lastActivityAt: new Date(), updatedAt: new Date() })
      .where(eq(visaApplications.id, app.id));
    await writeEvent(q, app, actor, {
      type: "ASSIGNED",
      message: label ? `Assigned to ${label}` : "Case officer cleared",
      customerVisible: false,
      payload: { userId },
    });
    await auditIn(tx, {
      actor,
      action: "ASSIGN",
      entityType: "visa_application",
      entityId: app.id,
      agencyId: app.agencyId,
      metadata: { userId },
    });
    if (userId) {
      await notify(
        {
          userIds: [userId],
          applicationId: app.id,
          agencyId: app.agencyId,
          staffOnly: true,
          kind: "ASSIGNED",
          title: `You own ${app.reference}`,
          body: `Assigned to you by ${actor.email}.`,
          link: `/admin/applications/${app.id}`,
          severity: "ACTION_REQUIRED",
          dedupeKey: `ASSIGNED:${app.id}:${Date.now()}`,
        },
        tx,
      );
    }
  });
}

/* ---------------- cross-service helpers ---------------- */

/**
 * Prove that an applicant belongs to this application AND this agency.
 *
 * This is the answer to "the client sent us an applicantId": the relationship is
 * read back from the database inside the same transaction as the write. A
 * foreign or mismatched id is indistinguishable from a missing one.
 */
export async function assertApplicantOwnership(
  tx: Database | undefined,
  input: { applicantId: string | null | undefined; applicationId: string; agencyId: string },
): Promise<void> {
  if (!input.applicantId) return; // application-level record: no applicant link
  const t: Q = tx ?? (await getDb());
  const rows = (await t
    .select({ id: applicants.id })
    .from(applicants)
    .where(
      and(
        eq(applicants.id, input.applicantId),
        eq(applicants.applicationId, input.applicationId),
        eq(applicants.agencyId, input.agencyId),
        eq(applicants.isActive, true),
      ),
    )
    .limit(1)) as Array<{ id: string }>;
  if (!rows.length) throw new DomainError("NOT_FOUND", "Applicant not found for this application");
}

export async function requireApplicationAgency(actor: OpActor, applicationId: string): Promise<string> {
  const t: Q = await getDb();
  const app = await loadApplicationReadOnly(t, actor, applicationId);
  return app.agencyId;
}

export { loadApplicationReadOnly, loadApplicationForUpdate, assertApplicationTenant };

/* ---------------- available transitions (drives the UI, not the rules) ---------------- */

export interface TransitionOption {
  code: string;
  label: string;
  color: string | null;
  requiresDocumentsComplete: boolean;
  isTerminal: boolean;
  /** null → the actor may use it now; otherwise the honest reason it is not offered */
  blockedReason: string | null;
  /** staff with override rights may force it, with a reason */
  overridable: boolean;
}

/**
 * Which workflow states THIS actor may move the file into right now.
 *
 * The UI renders what this returns; it never decides anything. transitionStatus()
 * re-checks every one of these rules on submit, so a hand-crafted request cannot
 * use a state that is not listed here.
 */
export async function availableTransitions(actor: OpActor, applicationId: string): Promise<TransitionOption[]> {
  assertActorPermission(actor, "applications.read");
  const t: Q = await getDb();
  const app = await loadApplicationReadOnly(t, actor, applicationId);
  const from = await loadStatusById(app.statusId);
  const maySubmit = can(actor.role, actor.isStaff ? "applications.submit" : "applications.submit");
  const mayOverride = actor.isStaff && can(actor.role, "applications.override");
  const candidates = (await t
    .select({
      id: applicationStatuses.id,
      code: applicationStatuses.code,
      label: applicationStatuses.label,
      color: applicationStatuses.color,
      isTerminal: applicationStatuses.isTerminal,
      requiresDocumentsComplete: applicationStatuses.requiresDocumentsComplete,
      customerVisible: applicationStatuses.customerVisible,
      isActive: applicationStatuses.isActive,
      displayOrder: applicationStatuses.displayOrder,
    })
    .from(applicationStatuses)
    .where(eq(applicationStatuses.isActive, true))
    .orderBy(asc(applicationStatuses.displayOrder))) as Array<Record<string, any>>;

  let checklistComplete = app.checklistComplete;
  if (candidates.some((c) => c.requiresDocumentsComplete && c.id !== from.id)) {
    checklistComplete = (await buildChecklistFromApp(app, undefined, actor.id)).complete;
  }

  const out: TransitionOption[] = [];
  for (const c of candidates) {
    if (c.id === from.id) continue;
    if (!actor.isStaff && !c.customerVisible) continue;
    if (from.allowedNextStatusCodes && !from.allowedNextStatusCodes.includes(c.code)) continue;
    let blocked: string | null = null;
    if (!maySubmit) blocked = "Your role does not move files between statuses";
    else if (from.isTerminal && !mayOverride) blocked = "This file is closed — a supervisor must reopen it";
    else if (c.requiresDocumentsComplete && !checklistComplete) {
      blocked = "The document checklist is not clean yet";
    }
    out.push({
      code: c.code,
      label: c.label,
      color: c.color ?? null,
      requiresDocumentsComplete: Boolean(c.requiresDocumentsComplete),
      isTerminal: Boolean(c.isTerminal),
      blockedReason: blocked,
      overridable: Boolean(c.requiresDocumentsComplete && !checklistComplete) && mayOverride,
    });
  }
  return out;
}
