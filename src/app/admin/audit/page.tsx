import { and, desc, eq, ilike } from "drizzle-orm";
import { getDb, auditLogs } from "@/db";
import { requireStaff } from "@/lib/authorization";
import { can } from "@/lib/rbac";
import { PageHeader, Badge } from "@/components/admin/ui";
import { Flash } from "@/app/admin/flash";

export const dynamic = "force-dynamic";

export default async function AuditPage(props: {
  searchParams: { entity?: string; actor?: string; flash?: string };
}) {
  const user = await requireStaff();
  const mayRead = can(user.role, "audit_logs.read");
  if (!mayRead) {
    return (
      <div>
        <PageHeader title="Audit Log" />
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">Your role cannot read the audit log.</p>
      </div>
    );
  }
  const db = await getDb();
  const conds = [];
  if (props.searchParams.entity) conds.push(eq(auditLogs.entityType, props.searchParams.entity));
  if (props.searchParams.actor) conds.push(ilike(auditLogs.actorEmail, `%${props.searchParams.actor}%`));
  const rows = await db
    .select()
    .from(auditLogs)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(200);

  return (
    <div>
      <Flash searchParams={props.searchParams} />
      <PageHeader
        title="Audit Log"
        subtitle="Who changed what, when — before/after diffs for configuration changes. Newest 200 entries."
      />

      <form className="card mb-5 flex flex-wrap items-end gap-3 p-4">
        <div>
          <label className="label">Entity type</label>
          <input name="entity" className="input" defaultValue={props.searchParams.entity ?? ""} placeholder="visa_type" />
        </div>
        <div>
          <label className="label">Actor email</label>
          <input name="actor" className="input" defaultValue={props.searchParams.actor ?? ""} placeholder="admin@essafaria.local" />
        </div>
        <button className="btn-brand" type="submit">
          Filter
        </button>
        {(props.searchParams.entity || props.searchParams.actor) && (
          <a href="/admin/audit" className="btn-ghost">
            Clear
          </a>
        )}
      </form>

      <div className="space-y-2">
        {(rows as unknown[]).length === 0 ? (
          <p className="text-sm text-slate-400">No audit entries.</p>
        ) : null}
        {rows.map((r) => (
          <div key={r.id} className="card px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={r.action === "DELETE" || r.action === "UNPUBLISH" ? "red" : r.action === "CREATE" ? "green" : "navy"}>
                {r.action}
              </Badge>
              <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{r.entityType}</code>
              <span className="text-xs text-slate-400">{r.entityId}</span>
              <span className="text-xs text-slate-500">
                by <b>{r.actorEmail ?? "system"}</b>
              </span>
              <span className="ml-auto text-xs text-slate-400">{new Date(r.createdAt).toLocaleString()}</span>
            </div>
            {r.changes ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-semibold text-slate-500">changes</summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-50 p-2 text-[11px] leading-4">
                  {JSON.stringify(r.changes, null, 2)}
                </pre>
              </details>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
