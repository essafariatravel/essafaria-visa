import Link from "next/link";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  agencies,
  applicationDocuments,
  applicationStatuses,
  gmailMessages,
  getDb,
  invoiceItems,
  invoices,
  users,
  visaApplications,
} from "@/db";
import { requireStaff } from "@/lib/authorization";
import { can } from "@/lib/rbac";
import { getBranding, getSetting } from "@/lib/config-service";
import { deliveryStats } from "@/lib/notifications";
import { Badge, EmptyState, PageHeader } from "@/components/admin/ui";
import { Money, Notice, Panel, StatCard, StatusChip } from "@/components/ops/ui";
import { listApplications } from "@/lib/applications";
import { staffActorForPage } from "@/lib/page-auth";

export const dynamic = "force-dynamic";

type Q = any;

/**
 * The desk dashboard. Every number is one aggregate query with the tenant
 * predicate built in, so the page is honest and cheap: no per-card fan-out, no
 * counting in JavaScript over whole tables.
 */
export default async function AdminDashboard() {
  const user = await requireStaff();
  const branding = await getBranding().catch(() => null);
  void branding;
  const t: Q = await getDb();

  const [pipeline, workload, money, health, docsQueue, mailQueue, recent] = await Promise.all([
    t
      .select({
        code: applicationStatuses.code,
        label: applicationStatuses.label,
        color: applicationStatuses.color,
        n: sql<number>`count(*)::int`,
        blocked: sql<number>`count(*) filter (where ${visaApplications.checklistComplete} = false)::int`,
      })
      .from(visaApplications)
      .innerJoin(applicationStatuses, eq(applicationStatuses.id, visaApplications.statusId))
      .groupBy(applicationStatuses.code, applicationStatuses.label, applicationStatuses.color, applicationStatuses.displayOrder)
      .orderBy(asc(applicationStatuses.displayOrder)),
    t
      .select({
        id: users.id,
        name: users.name,
        role: users.role,
        open: sql<number>`count(*) filter (where ${applicationStatuses.isTerminal} = false)::int`,
        blocked: sql<number>`count(*) filter (where ${applicationStatuses.isTerminal} = false and ${visaApplications.checklistComplete} = false)::int`,
        closed: sql<number>`count(*) filter (where ${applicationStatuses.isTerminal} = true)::int`,
      })
      .from(users)
      .leftJoin(visaApplications, eq(visaApplications.caseOfficerUserId, users.id))
      .leftJoin(applicationStatuses, eq(applicationStatuses.id, visaApplications.statusId))
      .where(inArray(users.role, ["SUPER_ADMIN", "ADMIN", "VISA_AGENT"]))
      .groupBy(users.id, users.name, users.role)
      .orderBy(sql`count(*) filter (where ${applicationStatuses.isTerminal} = false) desc`)
      .limit(8),
    t
      .select({
        outstanding: sql<number>`coalesce(sum(${invoices.subtotalCents} - ${invoices.paidCents}), 0)::bigint`,
        collected30: sql<number>`coalesce(sum(case when ${invoiceItems.chargedAt} > now() - interval '30 days' then ${invoiceItems.amountCents} else 0 end), 0)::bigint`,
        openInvoices: sql<number>`count(*) filter (where ${invoices.status} = 'PENDING')::int`,
      })
      .from(invoices)
      .leftJoin(invoiceItems, eq(invoiceItems.invoiceId, invoices.id)),
    t
      .select({
        agencies: sql<number>`(select count(*) from agencies)::int`,
        negativeWallets: sql<number>`(select count(*) from agencies where wallet_balance_cents < 0)::int`,
        docsPending: sql<number>`(select count(*) from application_documents where is_current = true and review_state = 'PENDING')::int`,
        mailUnreviewed: sql<number>`(select count(*) from gmail_messages where requires_review = true)::int`,
        tasksFailed: sql<number>`(select count(*) from task_runs where status = 'FAILED')::int`,
      })
      .from(agencies)
      .limit(1),
    t
      .select({
        id: applicationDocuments.id,
        applicationId: applicationDocuments.applicationId,
        type: applicationDocuments.documentTypeCode,
        uploaded: applicationDocuments.uploadedAt,
        reference: visaApplications.reference,
        agency: agencies.name,
      })
      .from(applicationDocuments)
      .innerJoin(visaApplications, eq(visaApplications.id, applicationDocuments.applicationId))
      .innerJoin(agencies, eq(agencies.id, applicationDocuments.agencyId))
      .where(and(eq(applicationDocuments.isCurrent, true), eq(applicationDocuments.reviewState, "PENDING")))
      .orderBy(desc(applicationDocuments.uploadedAt))
      .limit(6),
    t
      .select({
        id: gmailMessages.id,
        subject: gmailMessages.subject,
        fromAddress: gmailMessages.fromAddress,
        received: gmailMessages.receivedAt,
      })
      .from(gmailMessages)
      .where(eq(gmailMessages.requiresReview, true))
      .orderBy(desc(gmailMessages.receivedAt))
      .limit(5),
    listApplications(await staffActorForPage("applications.read"), { onlyOpen: true, pageSize: 6 }),
  ]);

  const stats = health[0] ?? { agencies: 0, negativeWallets: 0, docsPending: 0, mailUnreviewed: 0, tasksFailed: 0 };
  const totals = (pipeline as Array<Record<string, string | number>>).reduce<{ open: number; blocked: number }>(
    (acc, r) => ({ open: acc.open + Number(r.n ?? 0), blocked: acc.blocked + Number(r.blocked ?? 0) }),
    { open: 0, blocked: 0 },
  );
  const deliveries = await deliveryStats().catch(() => ({} as Record<string, number>));
  const staleDays = Number(await getSetting<number>("ops.staleAfterDays", 7));
  const walletOut = (money[0] ?? { outstanding: 0, collected30: 0, openInvoices: 0 }) as Record<string, number | string>;
  const mayWallet = can(user.role, "wallet.read");

  return (
    <div>
      <PageHeader
        title={`Desk — ${user.name.split(" ")[0]}`}
        subtitle="Live operational picture across every partner agency. Statuses, gates, thresholds and pricing are configuration, so this page follows what the platform is set to do."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/admin/applications/new" className="btn-brand text-sm">
              New application
            </Link>
            <Link href="/admin/copilot" className="rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100">
              Ask the copilot
            </Link>
          </div>
        }
      />

      {Number(stats.negativeWallets) > 0 ? (
        <div className="mb-5">
          <Notice kind="error">
            {Number(stats.negativeWallets)} agency wallet(s) are below zero. Fund them or pause submissions for those partners.
          </Notice>
        </div>
      ) : null}
      {Number(stats.tasksFailed) > 0 ? (
        <div className="mb-5">
          <Notice kind="warn">{Number(stats.tasksFailed)} automation run(s) failed — check the automation log.</Notice>
        </div>
      ) : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Open files" value={totals.open} hint="not in a terminal status" />
        <StatCard label="Waiting on documents" value={totals.blocked} tone={totals.blocked ? "warn" : "ok"} hint={`${staleDays}d threshold for stale follow-up`} />
        <StatCard label="Documents to review" value={Number(stats.docsPending)} tone={Number(stats.docsPending) ? "warn" : undefined} hint="current uploads awaiting a decision" />
        <StatCard label="Mail to review" value={Number(stats.mailUnreviewed)} hint="staged inbound messages and attachments" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Panel title="Pipeline" subtitle="Counts straight from the status configuration — rename or add a status and this follows." action={
            <Link href="/admin/applications" className="text-[11px] font-semibold text-[var(--color-brand-primary)] hover:underline">
              Open the queue →
            </Link>
          }>
            {!pipeline.length ? (
              <EmptyState title="No files yet" hint="Open the first application for a partner agency." />
            ) : (
              <ul className="space-y-2">
                {pipeline.map((r: Record<string, string | number>) => (
                  <li key={String(r.code)} className="flex items-center justify-between gap-3">
                    <Link href={`/admin/applications?status=${r.code}`} className="flex items-center gap-2 hover:underline">
                      <StatusChip label={String(r.label)} color={r.color == null ? null : String(r.color)} />
                      {Number(r.blocked) > 0 ? <span className="text-[11px] text-amber-700">{Number(r.blocked)} waiting on docs</span> : null}
                    </Link>
                    <span className="tabular-nums text-sm font-bold text-slate-700">{Number(r.n)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Needs attention" subtitle="Six most recently touched open files, across all agencies.">
            {!recent.rows.length ? (
              <EmptyState title="Nothing open" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {recent.rows.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <Link href={`/admin/applications/${r.id}`} className="text-sm font-semibold text-[var(--color-brand-primary)] hover:underline">
                      {r.reference}
                    </Link>
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-600">
                      {r.visaTypeName} · {r.agencyName}
                    </span>
                    <StatusChip label={r.statusLabel} color={r.statusColor} />
                    {r.checklistComplete ? null : <Badge tone="amber">docs</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Workload" subtitle="Files owned per desk member; blocked counts still need documents." action={
            <Link href="/admin/applications?mine=1" className="text-[11px] font-semibold text-[var(--color-brand-primary)] hover:underline">
              My queue →
            </Link>
          }>
            {!workload.length ? (
              <EmptyState title="No staff accounts" />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th scope="col" className="th">Officer</th>
                    <th scope="col" className="th text-right">Open</th>
                    <th scope="col" className="th text-right">Blocked</th>
                    <th scope="col" className="th text-right">Closed</th>
                  </tr>
                </thead>
                <tbody>
                  {workload.map((w: Record<string, string | number>) => (
                    <tr key={String(w.id)} className="border-t border-slate-100">
                      <td className="td">
                        {String(w.name)}
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400">{String(w.role).replace(/_/g, " ").toLowerCase()}</span>
                      </td>
                      <td className="td text-right tabular-nums">{Number(w.open)}</td>
                      <td className={`td text-right tabular-nums ${Number(w.blocked) ? "font-semibold text-amber-700" : ""}`}>{Number(w.blocked)}</td>
                      <td className="td text-right tabular-nums text-slate-500">{Number(w.closed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          {mayWallet ? (
            <Panel title="Money" action={
              <Link href="/admin/wallet" className="text-[11px] font-semibold text-[var(--color-brand-primary)] hover:underline">
                Wallet desk →
              </Link>
            }>
              <ul className="space-y-2 text-xs">
                <li className="flex items-center justify-between">
                  <span className="text-slate-500">Outstanding invoices</span>
                  <span className="font-bold text-red-700 tabular-nums">
                    <Money cents={Number(walletOut.outstanding ?? 0)} code="EUR" />
                  </span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-slate-500">Collected (30 days)</span>
                  <span className="font-bold tabular-nums text-emerald-700">
                    <Money cents={Number(walletOut.collected30 ?? 0)} code="EUR" />
                  </span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-slate-500">Open invoices</span>
                  <span className="font-bold tabular-nums">{Number(walletOut.openInvoices ?? 0)}</span>
                </li>
              </ul>
            </Panel>
          ) : (
            <Panel title="Money">
              <p className="text-xs text-slate-500">Billing figures are visible to accounting and administrators.</p>
            </Panel>
          )}

          <Panel title="Document queue" action={
            <Link href="/admin/applications" className="text-[11px] font-semibold text-[var(--color-brand-primary)] hover:underline">
              All files →
            </Link>
          }>
            {!docsQueue.length ? (
              <p className="text-xs text-slate-500">Nothing waiting on a decision.</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {docsQueue.map((d: Record<string, string>) => (
                  <li key={d.id as string} className="flex items-center justify-between gap-2">
                    <Link href={`/admin/applications/${d.applicationId}/documents`} className="font-semibold text-[var(--color-brand-primary)] hover:underline">
                      {d.reference}
                    </Link>
                    <span className="truncate text-slate-500">{String(d.type).toLowerCase()}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Gmail intake" action={
            <Link href="/admin/inbox" className="text-[11px] font-semibold text-[var(--color-brand-primary)] hover:underline">
              Inbox →
            </Link>
          }>
            {!mailQueue.length ? (
              <p className="text-xs text-slate-500">No inbound mail awaiting review.</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {mailQueue.map((m: Record<string, string | null>) => (
                  <li key={String(m.id)} className="flex items-center justify-between gap-2">
                    <Link href={`/admin/inbox?message=${m.id}`} className="truncate font-semibold text-[var(--color-brand-primary)] hover:underline">
                      {m.subject ?? "(no subject)"}
                    </Link>
                    <span className="shrink-0 text-slate-400">{m.received ? new Date(m.received).toLocaleDateString() : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="System" subtitle="Queue depth from the outbox, not a guess.">
            <ul className="space-y-1.5 text-xs">
              <li className="flex justify-between">
                <span className="text-slate-500">Agencies</span>
                <span className="tabular-nums font-semibold">{Number(stats.agencies)}</span>
              </li>
              <li className="flex justify-between">
                <span className="text-slate-500">Email queued</span>
                <span className="tabular-nums font-semibold">{Number(deliveries.QUEUED ?? 0)}</span>
              </li>
              <li className="flex justify-between">
                <span className="text-slate-500">Skipped (no transport)</span>
                <span className="tabular-nums font-semibold">{Number(deliveries.SKIPPED ?? 0)}</span>
              </li>
              <li className="flex justify-between">
                <span className="text-slate-500">Delivery failures</span>
                <span className={`tabular-nums font-semibold ${Number(deliveries.FAILED ?? 0) ? "text-red-700" : ""}`}>{Number(deliveries.FAILED ?? 0)}</span>
              </li>
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href="/admin/automation" className="rounded-md border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100">
                Run automation
              </Link>
              <Link href="/admin/reports" className="rounded-md border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100">
                Reports
              </Link>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
