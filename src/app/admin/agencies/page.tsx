import Link from "next/link";
import { requireStaff } from "@/lib/authorization";
import { can } from "@/lib/rbac";
import { listEntities, getEntityById } from "@/lib/crud";
import { getDb, countries } from "@/db";
import { asc, sql } from "drizzle-orm";
import { saveConfigEntityAction } from "@/app/admin/actions";
import { Flash } from "@/app/admin/flash";
import { PageHeader, Badge } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

const FIELDS = [
  { name: "code", label: "Agency code", hint: "unique, e.g. ALPHA-TRV" },
  { name: "name", label: "Trading name" },
  { name: "legalName", label: "Legal name" },
  { name: "email", label: "Email" },
  { name: "phone", label: "Phone" },
  { name: "city", label: "City" },
  { name: "address", label: "Address" },
  { name: "contactPerson", label: "Contact person" },
];

export default async function AgenciesPage(props: { searchParams: { edit?: string; flash?: string } }) {
  const user = await requireStaff();
  const mayWrite = can(user.role, "agencies.write");
  const rows = await listEntities("agencies");
  const editId = props.searchParams.edit;
  const editing = editId && editId !== "new" ? await getEntityById("agencies", editId) : null;
  const db = await getDb();
  const countryOpts = await db
    .select({ id: countries.id, name: countries.name })
    .from(countries)
    .orderBy(asc(countries.name));

  // member counts
  const memberCounts = new Map<string, number>();
  {
    const res = (await db.execute(sql`SELECT agency_id, COUNT(*)::int AS n FROM agency_memberships GROUP BY agency_id`)) as unknown;
    const rs = ((res as { rows?: Array<{ agency_id: string; n: number }> }).rows ?? (Array.isArray(res) ? (res as Array<{ agency_id: string; n: number }>) : []));
    for (const r of rs) memberCounts.set(r.agency_id, r.n);
  }

  return (
    <div>
      <Flash searchParams={props.searchParams} />
      <PageHeader
        title="Agencies"
        subtitle="B2B partner accounts. Every agency record is a tenant; its users see only their own data."
        action={
          mayWrite ? (
            <Link href="/admin/agencies?edit=new" className="btn-brand">
              + New agency
            </Link>
          ) : undefined
        }
      />

      {mayWrite && (editId === "new" || editing) ? (
        <div className="mb-8 card p-5">
          <h2 className="mb-4 text-lg font-semibold">{editing ? "Edit agency" : "New agency"}</h2>
          <form action={saveConfigEntityAction}>
            <input type="hidden" name="__entity" value="agencies" />
            <input type="hidden" name="__back" value="/admin/agencies" />
            {editing ? <input type="hidden" name="__id" value={String(editing.id)} /> : null}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {FIELDS.map((f) => (
                <div key={f.name}>
                  <label className="label">{f.label}</label>
                  <input
                    className="input"
                    name={f.name}
                    defaultValue={editing ? String(editing[f.name] ?? "") : ""}
                    placeholder={"code" === f.name ? "ALPHA-TRV" : f.hint}
                  />
                </div>
              ))}
              <div>
                <label className="label">Country</label>
                <select className="input" name="countryId" defaultValue={editing ? String(editing.countryId ?? "") : ""}>
                  <option value="">— none —</option>
                  {countryOpts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Status</label>
                <select className="input" name="status" defaultValue={editing ? String(editing.status ?? "ACTIVE") : "ACTIVE"}>
                  {["ACTIVE", "SUSPENDED", "INACTIVE"].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="label">Billing info</label>
                <textarea className="input" name="billingInfo" rows={2} defaultValue={editing ? String(editing.billingInfo ?? "") : ""} />
              </div>
              <div className="md:col-span-2">
                <label className="label">Internal notes</label>
                <textarea className="input" name="notes" rows={2} defaultValue={editing ? String(editing.notes ?? "") : ""} />
              </div>
            </div>
            <div className="mt-5 flex gap-2">
              <button type="submit" className="btn-brand">
                {editing ? "Save agency" : "Create agency"}
              </button>
              <Link href="/admin/agencies" className="btn-ghost">
                Cancel
              </Link>
            </div>
          </form>
        </div>
      ) : null}

      <div className="card overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">Code</th>
              <th className="th">Name</th>
              <th className="th">City</th>
              <th className="th">Status</th>
              <th className="th">Users</th>
              <th className="th text-right">Manage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((a) => (
              <tr key={String(a.id)} className="hover:bg-slate-50/60">
                <td className="td">
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{String(a.code)}</code>
                </td>
                <td className="td font-medium">{String(a.name)}</td>
                <td className="td text-slate-500">{String(a.city ?? "—")}</td>
                <td className="td">
                  {a.status === "ACTIVE" ? <Badge tone="green">active</Badge> : a.status === "SUSPENDED" ? <Badge tone="red">suspended</Badge> : <Badge>inactive</Badge>}
                </td>
                <td className="td tabular-nums text-slate-600">{memberCounts.get(String(a.id)) ?? 0}</td>
                <td className="td text-right">
                  <div className="flex justify-end gap-2">
                    <Link href={`/admin/agencies/${a.id}`} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">
                      Users
                    </Link>
                    {mayWrite ? (
                      <Link href={`/admin/agencies?edit=${a.id}`} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">
                        Edit
                      </Link>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="td py-8 text-center text-slate-400">
                  No agencies yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
