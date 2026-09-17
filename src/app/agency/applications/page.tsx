import Link from "next/link";
import { EmptyState, PageHeader, Badge } from "@/components/admin/ui";
import { FilterBar, Pagination, Panel, StatusChip, Money } from "@/components/ops/ui";
import { listApplications } from "@/lib/applications";
import { opActorForPage } from "@/lib/page-auth";

export const dynamic = "force-dynamic";

type SP = { q?: string; status?: string; blocking?: string; page?: string };

/** The partner's own files only — the scope comes from the session membership. */
export default async function AgencyApplicationsPage({ searchParams }: { searchParams: SP }) {
  const actor = await opActorForPage("applications.read");
  const result = await listApplications(actor, {
    q: searchParams.q,
    statusCode: searchParams.status,
    onlyBlocking: searchParams.blocking === "1",
    page: searchParams.page ? Number(searchParams.page) : 1,
    pageSize: 20,
  });
  const base = "/agency/applications";
  const params: Record<string, string | undefined> = { q: searchParams.q, status: searchParams.status, blocking: searchParams.blocking };
  const href = (over: Record<string, string | undefined>) => {
    const merged = { ...params, ...over };
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `${base}?${s}` : base;
  };

  return (
    <div>
      <PageHeader
        title="Your applications"
        subtitle="Every file your agency has opened with ESSAFARIA. Document requirements and pricing are set per visa route by the ESSAFARIA desk."
        action={
          <Link href="/agency/applications/new" className="btn-brand text-sm">
            New application
          </Link>
        }
      />
      <FilterBar
        base={base}
        params={params}
        search={searchParams.q ?? ""}
        tabs={[
          { label: "All", count: result.total, href: href({ status: undefined, blocking: undefined }), active: !searchParams.status && !searchParams.blocking },
          { label: "Needs your documents", href: href({ blocking: "1", status: undefined }), active: searchParams.blocking === "1" },
          ...result.statusCounts.map((s) => ({ label: s.label, count: s.n, href: href({ status: s.code, blocking: undefined }), active: searchParams.status === s.code })),
        ]}
      />
      <Panel tight>
        {!result.rows.length ? (
          <EmptyState title="No applications yet" hint="Open your first file — you will be able to add travellers and upload their documents." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr>
                  <th className="th">Reference</th>
                  <th className="th">Route</th>
                  <th className="th">Status</th>
                  <th className="th">Your action</th>
                  <th className="th">Travellers</th>
                  <th className="th text-right">Billed</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50/70">
                    <td className="td">
                      <Link href={`/agency/applications/${r.id}`} className="font-semibold text-[var(--color-brand-primary)] hover:underline">
                        {r.reference}
                      </Link>
                      <p className="text-[11px] text-slate-400">{new Date(r.lastActivityAt).toLocaleDateString()}</p>
                    </td>
                    <td className="td">
                      <p className="text-xs font-medium text-slate-700">{r.visaTypeName}</p>
                      <p className="text-[11px] text-slate-400">{r.countryName}</p>
                    </td>
                    <td className="td">
                      <StatusChip label={r.statusLabel} color={r.statusColor} />
                    </td>
                    <td className="td">
                      {r.checklistComplete ? <Badge tone="green">documents complete</Badge> : <Badge tone="amber">upload needed</Badge>}
                    </td>
                    <td className="td text-xs tabular-nums text-slate-600">
                      {r.applicantCount}/{r.requestedCount}
                    </td>
                    <td className="td text-right text-xs">
                      {typeof r.totalAmountCents === "number" && r.totalAmountCents > 0 ? <Money cents={r.totalAmountCents} code={r.currencyCode ?? "EUR"} /> : <span className="text-slate-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={result.page} pageSize={result.pageSize} total={result.total} hrefFor={(p) => href({ page: String(p) })} />
      </Panel>
    </div>
  );
}
