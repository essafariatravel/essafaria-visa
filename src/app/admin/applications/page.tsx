import Link from "next/link";
import { PageHeader, EmptyState, Badge } from "@/components/admin/ui";
import { FilterBar, Pagination, Panel, StatusChip, Money } from "@/components/ops/ui";
import { listApplications } from "@/lib/applications";
import { staffActorForPage } from "@/lib/page-auth";
import { getDb, agencies } from "@/db";
import { asc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

type SP = {
  q?: string;
  status?: string;
  agency?: string;
  blocking?: string;
  mine?: string;
  page?: string;
};

/** The desk's book of work: filterable, paginated, tenant-safe. */
export default async function AdminApplicationsPage({ searchParams }: { searchParams: SP }) {
  const actor = await staffActorForPage("applications.read");
  const result = await listApplications(actor, {
    q: searchParams.q,
    statusCode: searchParams.status,
    agencyId: searchParams.agency,
    onlyBlocking: searchParams.blocking === "1",
    assignedToMe: searchParams.mine === "1",
    page: searchParams.page ? Number(searchParams.page) : 1,
    pageSize: 25,
  });

  const db = (await getDb()) as unknown as { select: (v: unknown) => any };
  const agencyRows = (await db
    .select({ id: agencies.id, name: agencies.name })
    .from(agencies)
    .where(eq(agencies.status, "ACTIVE"))
    .orderBy(asc(agencies.name))) as Array<{ id: string; name: string }>;

  const base = "/admin/applications";
  const params: Record<string, string | undefined> = {
    q: searchParams.q,
    status: searchParams.status,
    agency: searchParams.agency,
    blocking: searchParams.blocking,
    mine: searchParams.mine,
  };
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
        title="Applications"
        subtitle="Every file across all partner agencies. Statuses, gates and pricing come from configuration, so this list follows the workflow you set — not a hard-coded pipeline."
        action={
          <Link href="/admin/applications/new" className="btn-brand text-sm">
            New application
          </Link>
        }
      />

      <FilterBar
        base={base}
        params={params}
        search={searchParams.q ?? ""}
        tabs={[
          { label: "All", count: result.total, href: href({ status: undefined, blocking: undefined, mine: undefined }), active: !searchParams.status && !searchParams.blocking && !searchParams.mine },
          { label: "Waiting on documents", href: href({ blocking: "1", status: undefined, mine: undefined }), active: searchParams.blocking === "1" },
          { label: "Assigned to me", href: href({ mine: "1", status: undefined, blocking: undefined }), active: searchParams.mine === "1" },
          ...result.statusCounts.map((s) => ({
            label: s.label,
            count: s.n,
            href: href({ status: s.code, blocking: undefined }),
            active: searchParams.status === s.code,
          })),
        ]}
      />

      {searchParams.agency ? (
        <p className="mb-3 text-xs text-slate-500">
          Filtered to one agency ·{" "}
          <Link href={href({ agency: undefined })} className="font-semibold text-[var(--color-brand-primary)]">
            clear
          </Link>
        </p>
      ) : (
        <form action={base} className="mb-4 flex flex-wrap items-center gap-2">
          {Object.entries(params).filter(([k]) => k !== "agency").map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500" htmlFor="agency">
            Agency
          </label>
          <select id="agency" name="agency" className="input !w-64 !py-1.5 text-xs" defaultValue={searchParams.agency ?? ""}>
            <option value="">All agencies</option>
            {agencyRows.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button type="submit" className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100">
            Apply
          </button>
        </form>
      )}

      <Panel tight>
        {!result.rows.length ? (
          <EmptyState title="No applications match" hint="Loosen the filters, or open the first file for this agency." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-sm">
              <thead>
                <tr>
                  <th className="th">Reference</th>
                  <th className="th">Agency</th>
                  <th className="th">Route</th>
                  <th className="th">Status</th>
                  <th className="th">Docs</th>
                  <th className="th">Travellers</th>
                  <th className="th text-right">Billed</th>
                  <th className="th text-right">Activity</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50/70">
                    <td className="td">
                      <Link href={`/admin/applications/${r.id}`} className="font-semibold text-[var(--color-brand-primary)] hover:underline">
                        {r.reference}
                      </Link>
                      {r.gateOverridden ? <span className="ml-2 align-middle"><Badge tone="amber">override</Badge></span> : null}
                    </td>
                    <td className="td">
                      <Link href={href({ agency: r.agencyId, status: undefined })} className="text-xs text-slate-500 hover:underline">
                        {r.agencyName}
                      </Link>
                    </td>
                    <td className="td">
                      <p className="text-xs font-medium text-slate-700">{r.visaTypeName}</p>
                      <p className="text-[11px] text-slate-400">{r.countryName}</p>
                    </td>
                    <td className="td">
                      <StatusChip label={r.statusLabel} color={r.statusColor} />
                    </td>
                    <td className="td">
                      {r.checklistComplete ? <Badge tone="green">complete</Badge> : <Badge tone="red">outstanding</Badge>}
                    </td>
                    <td className="td text-xs tabular-nums text-slate-600">
                      {r.applicantCount}/{r.requestedCount}
                    </td>
                    <td className="td text-right text-xs">
                      {typeof r.totalAmountCents === "number" && r.totalAmountCents > 0 ? (
                        <Money cents={r.totalAmountCents} code={r.currencyCode ?? "EUR"} />
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="td text-right text-[11px] text-slate-500">{new Date(r.lastActivityAt).toLocaleDateString()}</td>
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
