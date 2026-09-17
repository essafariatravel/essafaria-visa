import Link from "next/link";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  applicationDocuments,
  applicationStatuses,
  agencies,
  getDb,
  invoiceItems,
  invoices,
  notifications,
  visaApplications,
} from "@/db";
import { getSessionUser } from "@/lib/session";
import { resolveAgencyContext } from "@/lib/tenancy";
import { getWallet } from "@/lib/billing";
import { getBranding } from "@/lib/config-service";
import { Money, Notice, Panel, StatCard, StatusChip } from "@/components/ops/ui";
import { Badge, EmptyState, PageHeader } from "@/components/admin/ui";
import { SiteMark } from "@/components/site/mark";
import { LogoutForm } from "@/app/admin/logout-form";

export const dynamic = "force-dynamic";

type Q = any;

/**
 * Partner dashboard: real aggregates over the agency's own rows only.
 *
 * Every query below carries the tenant predicate (agency_id = session agency),
 * so the numbers cannot leak across tenants even if the UI were reused.
 */
export default async function AgencyDashboard() {
  const user = await getSessionUser();
  if (!user) {
    // The layout normally handles auth; kept explicit so the page is safe standalone.
    return (
      <div className="flex min-h-screen items-center justify-center">
        <EmptyState title="Sign in required" hint="Open the partner portal from /login." />
      </div>
    );
  }
  const branding = await getBranding().catch(() => null);
  const agencyId = await resolveAgencyContext(user);
  if (!agencyId) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <PageHeader title="No agency linked yet" subtitle="ESSAFARIA assigns portal users to an agency code. Contact your account manager." />
      </div>
    );
  }
  const t: Q = await getDb();
  const [agency] = (await t.select().from(agencies).where(eq(agencies.id, agencyId)).limit(1)) as Array<Record<string, any>>;

  const [byStatus, blocking, needsAction, recent, wallet, unread, outstanding] = await Promise.all([
    t
      .select({ code: applicationStatuses.code, label: applicationStatuses.label, color: applicationStatuses.color, n: sql<number>`count(*)::int` })
      .from(visaApplications)
      .innerJoin(applicationStatuses, eq(applicationStatuses.id, visaApplications.statusId))
      .where(and(eq(visaApplications.agencyId, agencyId), eq(applicationStatuses.customerVisible, true)))
      // displayOrder must be in the GROUP BY: PostgreSQL rejects (42803) ordering by a
      // column that is neither grouped nor aggregated, which would break this page
      // on real Postgres while a permissive driver would let it slide.
      .groupBy(
        applicationStatuses.code,
        applicationStatuses.label,
        applicationStatuses.color,
        applicationStatuses.displayOrder,
      )
      .orderBy(asc(applicationStatuses.displayOrder)),
    t
      .select({ n: sql<number>`count(*)::int` })
      .from(visaApplications)
      .where(and(eq(visaApplications.agencyId, agencyId), eq(visaApplications.checklistComplete, false))),
    t
      .select({ n: sql<number>`count(*)::int` })
      .from(applicationDocuments)
      .where(and(eq(applicationDocuments.agencyId, agencyId), inArray(applicationDocuments.reviewState, ["REJECTED", "NEEDS_REPLACEMENT"]))),
    t
      .select({
        id: visaApplications.id,
        reference: visaApplications.reference,
        visaTypeName: visaApplications.visaTypeName,
        countryName: visaApplications.countryName,
        lastActivityAt: visaApplications.lastActivityAt,
        statusLabel: applicationStatuses.label,
        statusColor: applicationStatuses.color,
        statusCode: applicationStatuses.code,
        checklistComplete: visaApplications.checklistComplete,
      })
      .from(visaApplications)
      .innerJoin(applicationStatuses, eq(applicationStatuses.id, visaApplications.statusId))
      .where(and(eq(visaApplications.agencyId, agencyId), eq(applicationStatuses.customerVisible, true)))
      .orderBy(desc(visaApplications.lastActivityAt))
      .limit(6),
    getWallet(agencyId).catch(() => null),
    t
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.agencyId, agencyId), sql`${notifications.readAt} is null`)),
    t
      .select({
        dueCents: sql<number>`coalesce(sum(${invoices.subtotalCents} - ${invoices.paidCents}), 0)::bigint`,
        currencyCode: invoices.currencyCode,
      })
      .from(invoices)
      .where(and(eq(invoices.agencyId, agencyId), inArray(invoices.status, ["PENDING", "PARTIALLY_PAID"])))
      .groupBy(invoices.currencyCode),
  ]);

  const totalFiles = (byStatus as Array<{ n: number }>).reduce((s, r) => s + Number(r.n), 0);
  const walletNegative = wallet ? wallet.balanceCents < 0 : false;

  return (
    <div className="min-h-screen" style={{ background: "var(--color-brand-background)" }}>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4">
          <div className="flex items-center gap-4">
            <SiteMark branding={branding} />
            <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">Partner portal</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-xs text-slate-500 md:inline">{user.name}</span>
            <LogoutForm />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <PageHeader
          title={agency.name}
          subtitle={`Agency code ${agency.code} · ${agency.city ?? "—"}`}
          action={
            <div className="flex items-center gap-2">
              <Link href="/agency/applications/new" className="btn-brand text-sm">
                New application
              </Link>
              <Link href="/agency/applications" className="rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100">
                All files
              </Link>
            </div>
          }
        />
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Applications" value={totalFiles} hint="all time, this agency only" />
          <StatCard label="Waiting on you" value={Number(blocking[0]?.n ?? 0)} tone={Number(blocking[0]?.n ?? 0) ? "warn" : "ok"} hint="files with an open document checklist" />
          <StatCard label="Rejected / replace" value={Number(needsAction[0]?.n ?? 0)} tone={Number(needsAction[0]?.n ?? 0) ? "warn" : undefined} hint="documents the desk sent back" />
          <StatCard label="Unread messages" value={Number(unread[0]?.n ?? 0)} hint="from ESSAFARIA" />
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Panel title="Recent activity" subtitle="Your six most recently touched files.">
              {!(recent as Array<unknown>).length ? (
                <EmptyState title="No applications yet" hint="Open your first file — travellers and documents follow on the same screen." />
              ) : (
                <ul className="divide-y divide-slate-100">
                  {(recent as Array<Record<string, any>>).map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <Link href={`/agency/applications/${r.id}`} className="text-sm font-semibold text-[var(--color-brand-primary)] hover:underline">
                          {r.reference}
                        </Link>
                        <p className="text-[11px] text-slate-500">
                          {r.visaTypeName} · {r.countryName}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {r.checklistComplete ? null : <Badge tone="amber">documents needed</Badge>}
                        <StatusChip label={r.statusLabel} color={r.statusColor} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
          <div>
            <Panel title="Wallet" subtitle="Prepaid balance managed by ESSAFARIA. There is no online top-up by design.">
              {wallet ? (
                <>
                  <p className={`text-3xl font-black tabular-nums ${walletNegative ? "text-red-600" : ""}`} style={walletNegative ? undefined : { color: "var(--color-brand-primary)" }}>
                    <Money cents={wallet.balanceCents} code={wallet.currencyCode} />
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    Available to charge against new applications.
                    {wallet.lastTransactionAt ? ` Last movement ${new Date(wallet.lastTransactionAt).toLocaleDateString()}.` : ""}
                  </p>
                </>
              ) : (
                <Notice kind="warn">Wallet unavailable</Notice>
              )}
              {(outstanding as Array<Record<string, any>>).length ? (
                <dl className="mt-4 space-y-2 border-t border-slate-100 pt-3 text-xs">
                  {(outstanding as Array<Record<string, any>>).map((o) => (
                    <div key={o.currencyCode} className="flex items-center justify-between">
                      <dt className="text-slate-500">Outstanding invoices</dt>
                      <dd className="font-semibold text-red-700">
                        <Money cents={Number(o.dueCents)} code={o.currencyCode} />
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-emerald-700">No outstanding invoices.</p>
              )}
              <Link href="/agency/wallet" className="mt-4 block text-xs font-semibold text-[var(--color-brand-primary)] hover:underline">
                Open wallet & invoice history →
              </Link>
            </Panel>
            <Panel title="Your pipeline" subtitle="Live configuration — the desk can change these at any time.">
              <ul className="space-y-1.5 text-xs">
                {(byStatus as Array<{ code: string; label: string; color: string | null; n: number }>).map((s) => (
                  <li key={s.code} className="flex items-center justify-between">
                    <StatusChip label={s.label} color={s.color} />
                    <span className="tabular-nums font-semibold text-slate-600">{Number(s.n)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </div>
      </main>
    </div>
  );
}
