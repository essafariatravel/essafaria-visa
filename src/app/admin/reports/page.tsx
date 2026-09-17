import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { agencies, applicationStatuses, getDb } from "@/db";
import { Badge, EmptyState, PageHeader } from "@/components/admin/ui";
import { Money, Notice, Panel } from "@/components/ops/ui";
import { REPORTS, buildReport, type ReportKind } from "@/lib/reports";
import { staffActorForPage } from "@/lib/page-auth";
import { can } from "@/lib/rbac";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Q = any;
type SP = { report?: string; from?: string; to?: string; agency?: string; status?: string; flash?: string };

/** Reports and exports. Preview and CSV come from one tenant-scoped query. */
export default async function ReportsPage({ searchParams }: { searchParams: SP }) {
  const actor = await staffActorForPage("reports.read");
  const t: Q = await getDb();
  const kind = (Object.keys(REPORTS).includes(String(searchParams.report)) ? searchParams.report : "applications") as ReportKind;
  const def = REPORTS[kind];
  const report = await buildReport(actor, kind, {
    from: searchParams.from,
    to: searchParams.to,
    agencyId: searchParams.agency,
    statusCode: searchParams.status,
    limit: 200,
  });
  const [agencyRows, statusRows] = await Promise.all([
    t.select({ id: agencies.id, name: agencies.name }).from(agencies).orderBy(asc(agencies.name)),
    t.select({ code: applicationStatuses.code, label: applicationStatuses.label }).from(applicationStatuses).where(eq(applicationStatuses.isActive, true)).orderBy(asc(applicationStatuses.displayOrder)),
  ]);
  const hrefFor = (over: Record<string, string | undefined>) => {
    const merged = { report: kind, from: searchParams.from, to: searchParams.to, agency: searchParams.agency, status: searchParams.status, ...over };
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `/admin/reports?${s}` : "/admin/reports";
  };
  const csvHref = `/api/reports/${kind}?format=csv&limit=5000` + [searchParams.from ? `&from=${searchParams.from}` : "", searchParams.to ? `&to=${searchParams.to}` : "", searchParams.agency ? `&agencyId=${searchParams.agency}` : "", searchParams.status ? `&status=${searchParams.status}` : ""].join("");
  const flash = searchParams.flash ? decodeURIComponent(searchParams.flash).replace(/^(ok|err):/, "") : null;

  return (
    <div className="pb-16">
      <PageHeader
        title="Reports & exports"
        subtitle="Aggregated from live data with the same permission and tenant rules as the screens. Agencies running the applications report through the API see only their own rows."
        action={
          can(actor.role, "reports.export") ? (
            <a href={csvHref} className="btn-brand text-sm">
              Download CSV
            </a>
          ) : null
        }
      />
      {flash ? (
        <div className="mb-4">
          <Notice kind={searchParams.flash?.startsWith("err") ? "error" : "info"}>{flash}</Notice>
        </div>
      ) : null}
      <div className="mb-5 flex flex-wrap gap-1.5">
        {(Object.keys(REPORTS) as ReportKind[]).map((k) => (
          <Link
            key={k}
            href={hrefFor({ report: k })}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ${k === kind ? "bg-[var(--color-brand-secondary)] text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}
          >
            {REPORTS[k].title}
          </Link>
        ))}
      </div>
      <Panel subtitle={def.description} title={def.title}>
        <form action="/admin/reports" className="mb-4 flex flex-wrap items-end gap-2">
          <input type="hidden" name="report" value={kind} />
          <div>
            <label className="label" htmlFor="from">From</label>
            <input id="from" name="from" type="date" defaultValue={searchParams.from ?? ""} className="input !w-40 text-xs" />
          </div>
          <div>
            <label className="label" htmlFor="to">To</label>
            <input id="to" name="to" type="date" defaultValue={searchParams.to ?? ""} className="input !w-40 text-xs" />
          </div>
          {actor.isStaff ? (
            <div>
              <label className="label" htmlFor="agency">Agency</label>
              <select id="agency" name="agency" className="input !w-52 text-xs" defaultValue={searchParams.agency ?? ""}>
                <option value="">All</option>
                {(agencyRows as Array<{ id: string; name: string }>).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {kind === "applications" ? (
            <div>
              <label className="label" htmlFor="status">Status</label>
              <select id="status" name="status" className="input !w-44 text-xs" defaultValue={searchParams.status ?? ""}>
                <option value="">Any</option>
                {(statusRows as Array<{ code: string; label: string }>).map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <button type="submit" className="btn-brand !px-4 !py-2 text-xs">
            Apply
          </button>
          <Link href={hrefFor({ from: undefined, to: undefined, agency: undefined, status: undefined })} className="rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100">
            Reset
          </Link>
        </form>
        <p className="mb-3 text-[11px] text-slate-500">
          Scope: {report.scope} · rows {report.total} · generated {new Date(report.generatedAt).toLocaleString()} · preview limited to 200 rows, CSV up to 5000
        </p>
        {!report.rows.length ? (
          <EmptyState title="Nothing in range" hint="Widen the date filters." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {report.columns.map((c) => (
                    <th key={c.key} scope="col" className="th">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    {report.columns.map((c) => (
                      <td key={c.key} className="td">
                        {c.type === "money" ? (
                          <Money cents={Number(row[c.key] ?? 0)} code={String(row.currency ?? "EUR")} />
                        ) : typeof row[c.key] === "string" && /^(yes|no)$/.test(row[c.key] as string) ? (
                          <Badge tone={row[c.key] === "yes" ? "green" : "slate"}>{row[c.key]}</Badge>
                        ) : (
                          <span className="tabular-nums">{row[c.key] === null || row[c.key] === undefined ? "—" : String(row[c.key])}</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
