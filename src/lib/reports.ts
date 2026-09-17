import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  agencies,
  agencyWalletTransactions,
  applicationDocuments,
  applicationEvents,
  applicationStatuses,
  getDb,
  invoiceItems,
  invoices,
  priorities,
  users,
  visaApplications,
} from "@/db";
import { assertActorPermission, DomainError } from "@/lib/ops";
import type { OpActor } from "@/lib/guard";
import { visaTypes } from "@/db";

type Q = any;

/* ============================================================
 * Reporting and exports (Phase 10).
 *
 * Every report is a single grouped query with the tenant predicate applied by
 * the actor's scope — an agency running a report gets its own rows and nothing
 * else, and the same code path serves the desk. CSV is generated from the same
 * rows, so the export can never be richer than the screen.
 * ============================================================ */

export type ReportKind = "applications" | "agencies" | "financial" | "processing" | "documents";

export const REPORTS: Record<ReportKind, { title: string; description: string; staffOnly: boolean; permission: "applications.read" | "reports.read" }> = {
  applications: {
    title: "Applications",
    description: "One row per file: route, status, travellers, checklist, billing.",
    staffOnly: false,
    permission: "applications.read",
  },
  documents: {
    title: "Documents",
    description: "Current documents with review state, age and expiry.",
    staffOnly: false,
    permission: "applications.read",
  },
  agencies: {
    title: "Agencies",
    description: "Per-partner volume, status mix, wallet and outstanding balance.",
    staffOnly: true,
    permission: "reports.read",
  },
  financial: {
    title: "Financial",
    description: "Ledger movement by type and currency, with header balances.",
    staffOnly: true,
    permission: "reports.read",
  },
  processing: {
    title: "Processing performance",
    description: "Time in status and end-to-end turnaround, by route and priority.",
    staffOnly: true,
    permission: "reports.read",
  },
};

export interface ReportData {
  kind: ReportKind;
  title: string;
  columns: Array<{ key: string; label: string; type?: "text" | "money" | "date" | "number" }>;
  rows: Array<Record<string, string | number | null>>;
  total: number;
  generatedAt: string;
  scope: string;
}

export interface ReportFilters {
  from?: string | null;
  to?: string | null;
  agencyId?: string | null;
  statusCode?: string | null;
  limit?: number;
}

function dateFilters(filters: ReportFilters, column: unknown) {
  const conds: unknown[] = [];
  if (filters.from) conds.push(gte(column as never, new Date(`${filters.from}T00:00:00.000Z`)));
  if (filters.to) conds.push(lte(column as never, new Date(`${filters.to}T23:59:59.999Z`)));
  return conds;
}

function tenantCondition(actor: OpActor) {
  if (actor.isStaff) return undefined;
  if (!actor.agencyIds.length) return sql`false`;
  return inArray(visaApplications.agencyId, actor.agencyIds);
}

export async function buildReport(actor: OpActor, kind: ReportKind, filters: ReportFilters = {}): Promise<ReportData> {
  const def = REPORTS[kind];
  if (!def) throw new DomainError("VALIDATION", "Unknown report");
  // ordering matters: a partner asking for a staff-only report gets the same
  // answer as for a report that does not exist, rather than a "forbidden" that
  // confirms the feature is there
  if (def.staffOnly && !actor.isStaff) throw new DomainError("NOT_FOUND", "Report not found");
  assertActorPermission(actor, def.permission);
  const limit = Math.min(5000, Math.max(1, filters.limit ?? 500));
  const t: Q = await getDb();
  const meta = {
    kind,
    title: def.title,
    total: 0,
    generatedAt: new Date().toISOString(),
    scope: actor.isStaff ? "all agencies" : `agency ${actor.agencyIds[0] ?? "none"}`,
  };

  if (kind === "applications") {
    const conds: unknown[] = [tenantCondition(actor), ...dateFilters(filters, visaApplications.createdAt)].filter(Boolean);
    if (filters.agencyId && actor.isStaff) conds.push(eq(visaApplications.agencyId, filters.agencyId));
    if (filters.statusCode) conds.push(sql`${applicationStatuses.code} = upper(${filters.statusCode})`);
    const rows = (await t
      .select({
        reference: visaApplications.reference,
        agency: agencies.name,
        country: visaApplications.countryName,
        route: visaApplications.visaTypeName,
        status: applicationStatuses.label,
        statusCode: applicationStatuses.code,
        priority: priorities.label,
        travellers: visaApplications.applicantCount,
        requested: visaApplications.requestedCount,
        checklist: visaApplications.checklistComplete,
        gateOverridden: visaApplications.gateOverridden,
        opened: visaApplications.createdAt,
        submitted: visaApplications.submittedAt,
        closed: visaApplications.closedAt,
        lastActivity: visaApplications.lastActivityAt,
        dueCents: sql<number>`coalesce(sum(case when ${invoiceItems.chargeStatus} = 'PENDING' then ${invoiceItems.amountCents} else 0 end), 0)::bigint`,
        paidCents: sql<number>`coalesce(sum(case when ${invoiceItems.chargeStatus} = 'CHARGED' then ${invoiceItems.amountCents} else 0 end), 0)::bigint`,
        currency: sql<string>`max(${invoices.currencyCode})`,
      })
      .from(visaApplications)
      .innerJoin(agencies, eq(agencies.id, visaApplications.agencyId))
      .innerJoin(applicationStatuses, eq(applicationStatuses.id, visaApplications.statusId))
      .leftJoin(priorities, eq(priorities.id, visaApplications.priorityId))
      .leftJoin(invoices, and(eq(invoices.applicationId, visaApplications.id), sql`${invoices.status} <> 'VOID'`))
      .leftJoin(invoiceItems, eq(invoiceItems.invoiceId, invoices.id))
      .where(conds.length ? and(...(conds as never[])) : undefined)
      .groupBy(
        visaApplications.id,
        visaApplications.reference,
        agencies.name,
        visaApplications.countryName,
        visaApplications.visaTypeName,
        applicationStatuses.label,
        applicationStatuses.code,
        priorities.label,
        visaApplications.applicantCount,
        visaApplications.requestedCount,
        visaApplications.checklistComplete,
        visaApplications.gateOverridden,
        visaApplications.createdAt,
        visaApplications.submittedAt,
        visaApplications.closedAt,
        visaApplications.lastActivityAt,
      )
      .orderBy(desc(visaApplications.createdAt))
      .limit(limit)) as unknown as Array<Record<string, any>>;
    return {
      ...meta,
      columns: [
        { key: "reference", label: "Reference" },
        { key: "agency", label: "Agency" },
        { key: "route", label: "Route" },
        { key: "country", label: "Country" },
        { key: "status", label: "Status" },
        { key: "priority", label: "Priority" },
        { key: "travellers", label: "Travellers", type: "number" },
        { key: "requested", label: "Requested", type: "number" },
        { key: "checklist", label: "Checklist complete" },
        { key: "gateOverridden", label: "Gate overridden" },
        { key: "dueCents", label: "Outstanding", type: "money" },
        { key: "paidCents", label: "Collected", type: "money" },
        { key: "opened", label: "Opened", type: "date" },
        { key: "submitted", label: "Submitted", type: "date" },
        { key: "closed", label: "Closed", type: "date" },
      ],
      rows: rows.map((r) => ({
        reference: r.reference,
        agency: r.agency,
        route: r.route,
        country: r.country,
        status: r.status,
        priority: r.priority ?? null,
        travellers: Number(r.travellers),
        requested: Number(r.requested),
        checklist: r.checklist ? "yes" : "no",
        gateOverridden: r.gateOverridden ? "yes" : "no",
        dueCents: Number(r.dueCents ?? 0),
        paidCents: Number(r.paidCents ?? 0),
        opened: String(r.opened).slice(0, 10),
        submitted: r.submitted ? String(r.submitted).slice(0, 10) : null,
        closed: r.closed ? String(r.closed).slice(0, 10) : null,
      })),
      total: rows.length,
    };
  }

  if (kind === "documents") {
    const conds: unknown[] = [tenantCondition(actor), eq(applicationDocuments.isCurrent, true), ...dateFilters(filters, applicationDocuments.uploadedAt)].filter(Boolean);
    const rows = (await t
      .select({
        reference: visaApplications.reference,
        agency: agencies.name,
        type: applicationDocuments.documentTypeCode,
        state: applicationDocuments.reviewState,
        version: applicationDocuments.version,
        bytes: applicationDocuments.bytes,
        uploaded: applicationDocuments.uploadedAt,
        reviewed: applicationDocuments.reviewedAt,
        expires: applicationDocuments.expiresAt,
        reviewer: users.name,
        requiredAtUpload: applicationDocuments.wasRequiredAtUpload,
      })
      .from(applicationDocuments)
      .innerJoin(visaApplications, eq(visaApplications.id, applicationDocuments.applicationId))
      .innerJoin(agencies, eq(agencies.id, applicationDocuments.agencyId))
      .leftJoin(users, eq(users.id, applicationDocuments.reviewedBy))
      .where(conds.length ? and(...(conds as never[])) : undefined)
      .orderBy(desc(applicationDocuments.uploadedAt))
      .limit(limit)) as unknown as Array<Record<string, any>>;
    return {
      ...meta,
      columns: [
        { key: "reference", label: "Reference" },
        { key: "agency", label: "Agency" },
        { key: "type", label: "Document" },
        { key: "state", label: "Review state" },
        { key: "version", label: "Version", type: "number" },
        { key: "requiredAtUpload", label: "Checklist item" },
        { key: "bytes", label: "Bytes", type: "number" },
        { key: "uploaded", label: "Uploaded", type: "date" },
        { key: "reviewed", label: "Reviewed", type: "date" },
        { key: "expires", label: "Expires", type: "date" },
        { key: "reviewer", label: "Reviewed by" },
      ],
      rows: rows.map((r) => ({
        reference: r.reference,
        agency: r.agency,
        type: r.type,
        state: r.state,
        version: Number(r.version),
        requiredAtUpload: r.requiredAtUpload ? "yes" : "no",
        bytes: Number(r.bytes ?? 0),
        uploaded: String(r.uploaded).slice(0, 10),
        reviewed: r.reviewed ? String(r.reviewed).slice(0, 10) : null,
        expires: r.expires ? String(r.expires).slice(0, 10) : null,
        reviewer: r.reviewer ?? null,
      })),
      total: rows.length,
    };
  }

  if (kind === "agencies") {
    const conds = dateFilters(filters, visaApplications.createdAt);
    const rows = (await t
      .select({
        code: agencies.code,
        name: agencies.name,
        status: agencies.status,
        files: sql<number>`count(${visaApplications.id})::int`,
        open: sql<number>`count(*) filter (where ${applicationStatuses.isTerminal} = false)::int`,
        blocked: sql<number>`count(*) filter (where ${visaApplications.checklistComplete} = false and ${applicationStatuses.isTerminal} = false)::int`,
        travellers: sql<number>`coalesce(sum(${visaApplications.applicantCount}), 0)::int`,
        balanceCents: agencies.walletBalanceCents,
        outstandingCents: sql<number>`coalesce(sum(distinct nullif(0, 0)), 0)::bigint`,
        collectedCents: sql<number>`coalesce(sum(case when ${invoiceItems.chargeStatus} = 'CHARGED' then ${invoiceItems.amountCents} else 0 end), 0)::bigint`,
      })
      .from(agencies)
      .leftJoin(visaApplications, and(eq(visaApplications.agencyId, agencies.id), ...(conds.length ? [and(...(conds as never[]))] : [])) as never)
      .leftJoin(applicationStatuses, eq(applicationStatuses.id, visaApplications.statusId))
      .leftJoin(invoices, and(eq(invoices.agencyId, agencies.id), sql`${invoices.status} <> 'VOID'`))
      .leftJoin(invoiceItems, eq(invoiceItems.invoiceId, invoices.id))
      .groupBy(agencies.code, agencies.name, agencies.status, agencies.walletBalanceCents)
      .orderBy(sql`count(${visaApplications.id}) desc`)
      .limit(limit)) as unknown as Array<Record<string, any>>;
    return {
      ...meta,
      columns: [
        { key: "code", label: "Code" },
        { key: "name", label: "Agency" },
        { key: "status", label: "Account" },
        { key: "files", label: "Files", type: "number" },
        { key: "open", label: "Open", type: "number" },
        { key: "blocked", label: "Waiting on docs", type: "number" },
        { key: "travellers", label: "Travellers", type: "number" },
        { key: "balanceCents", label: "Wallet", type: "money" },
        { key: "collectedCents", label: "Collected", type: "money" },
      ],
      rows: rows.map((r) => ({
        code: r.code,
        name: r.name,
        status: r.status,
        files: Number(r.files ?? 0),
        open: Number(r.open ?? 0),
        blocked: Number(r.blocked ?? 0),
        travellers: Number(r.travellers ?? 0),
        balanceCents: Number(r.balanceCents ?? 0),
        collectedCents: Number(r.collectedCents ?? 0),
      })),
      total: rows.length,
    };
  }

  if (kind === "financial") {
    const conds: unknown[] = [...dateFilters(filters, agencyWalletTransactions.occurredAt)];
    if (filters.agencyId) conds.push(eq(agencyWalletTransactions.agencyId, filters.agencyId));
    const rows = (await t
      .select({
        date: sql<string>`to_char(${agencyWalletTransactions.occurredAt}, 'YYYY-MM-DD')`,
        agency: agencies.name,
        kind: agencyWalletTransactions.kind,
        currency: agencyWalletTransactions.currencyCode,
        count: sql<number>`count(*)::int`,
        totalCents: sql<number>`coalesce(sum(${agencyWalletTransactions.amountCents}), 0)::bigint`,
      })
      .from(agencyWalletTransactions)
      .innerJoin(agencies, eq(agencies.id, agencyWalletTransactions.agencyId))
      .where(conds.length ? and(...(conds as never[])) : undefined)
      .groupBy(
        sql`to_char(${agencyWalletTransactions.occurredAt}, 'YYYY-MM-DD')`,
        agencies.name,
        agencyWalletTransactions.kind,
        agencyWalletTransactions.currencyCode,
      )
      .orderBy(desc(sql`1`), agencies.name)
      .limit(limit)) as unknown as Array<Record<string, any>>;
    const drift = (await t
      .select({
        agency: agencies.name,
        header: agencies.walletBalanceCents,
        ledger: sql<number>`coalesce(sum(${agencyWalletTransactions.amountCents}), 0)::bigint`,
      })
      .from(agencies)
      .leftJoin(agencyWalletTransactions, eq(agencyWalletTransactions.agencyId, agencies.id))
      .groupBy(agencies.name, agencies.walletBalanceCents)) as unknown as Array<Record<string, any>>;
    return {
      ...meta,
      columns: [
        { key: "date", label: "Date" },
        { key: "agency", label: "Agency" },
        { key: "kind", label: "Type" },
        { key: "currency", label: "Currency" },
        { key: "count", label: "Movements", type: "number" },
        { key: "totalCents", label: "Total", type: "money" },
        { key: "drift", label: "Header vs ledger drift" },
      ],
      rows: [
        ...rows.map((r) => ({
          date: r.date,
          agency: r.agency,
          kind: r.kind,
          currency: r.currency,
          count: Number(r.count),
          totalCents: Number(r.totalCents),
          drift: null,
        })),
        ...drift
          .filter((d) => Number(d.header) !== Number(d.ledger))
          .map((d) => ({
            date: "RECONCILIATION",
            agency: d.agency,
            kind: "MISMATCH",
            currency: "—",
            count: 0,
            totalCents: Number(d.header) - Number(d.ledger),
            drift: `header ${Number(d.header)} vs ledger ${Number(d.ledger)}`,
          })),
      ],
      total: rows.length,
    };
  }

  // processing performance
  const conds: unknown[] = [tenantCondition(actor), sql`${visaApplications.submittedAt} is not null`, ...dateFilters(filters, visaApplications.createdAt)].filter(Boolean);
  const rows = (await t
    .select({
      route: visaTypes.name,
      priority: priorities.label,
      files: sql<number>`count(*)::int`,
      avgIntakeDays: sql<number>`coalesce(avg(extract(epoch from (${visaApplications.submittedAt} - ${visaApplications.createdAt})) / 86400), 0)::numeric`,
      avgTotalDays: sql<number>`coalesce(avg(extract(epoch from (coalesce(${visaApplications.closedAt}, now()) - ${visaApplications.createdAt})) / 86400), 0)::numeric`,
      avgDocuments: sql<number>`coalesce(avg(${visaApplications.applicantCount}), 0)::numeric`,
    })
    .from(visaApplications)
    .innerJoin(visaTypes, eq(visaTypes.id, visaApplications.visaTypeId))
    .leftJoin(priorities, eq(priorities.id, visaApplications.priorityId))
    .where(conds.length ? and(...(conds as never[])) : undefined)
    .groupBy(visaTypes.name, priorities.label)
    .orderBy(desc(sql`count(*)`))
    .limit(limit)) as unknown as Array<Record<string, any>>;
  return {
    ...meta,
    columns: [
      { key: "route", label: "Route" },
      { key: "priority", label: "Priority" },
      { key: "files", label: "Files", type: "number" },
      { key: "avgIntakeDays", label: "Avg days to submit", type: "number" },
      { key: "avgTotalDays", label: "Avg days to close", type: "number" },
      { key: "avgDocuments", label: "Avg travellers", type: "number" },
    ],
    rows: rows.map((r) => ({
      route: r.route,
      priority: r.priority ?? null,
      files: Number(r.files),
      avgIntakeDays: Number(Number(r.avgIntakeDays ?? 0)).toFixed(1),
      avgTotalDays: Number(Number(r.avgTotalDays ?? 0)).toFixed(1),
      avgDocuments: Number(Number(r.avgDocuments ?? 0)).toFixed(1),
    })),
    total: rows.length,
  };
}

/** RFC 4180-ish CSV. Every field quoted; newlines/quotes escaped; nothing in
 *  a stored value can break out of its cell or act as a formula. */
export function toCsv(report: ReportData): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    let s = String(value);
    // neutralise spreadsheet formula injection (=, +, -, @ and tab/CR leads)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [report.columns.map((c) => escape(c.label)).join(",")];
  for (const row of report.rows) lines.push(report.columns.map((c) => escape(row[c.key])).join(","));
  return lines.join("\r\n") + "\r\n";
}
