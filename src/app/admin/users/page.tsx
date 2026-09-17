import { asc, eq } from "drizzle-orm";
import { getDb, users, agencies, agencyMemberships } from "@/db";
import { requireStaff } from "@/lib/authorization";
import { can } from "@/lib/rbac";
import { saveUserAction } from "@/app/admin/actions";
import { Flash } from "@/app/admin/flash";
import { PageHeader, Badge } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

const ROLES = ["SUPER_ADMIN", "ADMIN", "VISA_AGENT", "ACCOUNTING", "AGENCY_ADMIN", "AGENCY_USER"] as const;

export default async function UsersPage(props: { searchParams: { edit?: string; flash?: string } }) {
  const viewer = await requireStaff();
  const mayWrite = can(viewer.role, "users.write");
  const db = await getDb();
  const rows = await db.select().from(users).orderBy(asc(users.role), asc(users.name));
  const memberRows = await db
    .select({ userId: agencyMemberships.userId, agencyName: agencies.name })
    .from(agencyMemberships)
    .innerJoin(agencies, eq(agencies.id, agencyMemberships.agencyId));
  const agencyByUser = new Map(memberRows.map((m) => [m.userId, m.agencyName]));
  const editing = props.searchParams.edit
    ? rows.find((r) => r.id === props.searchParams.edit) ?? null
    : null;

  if (!can(viewer.role, "users.read")) {
    return (
      <div>
        <PageHeader title="Users" />
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">Your role cannot view users.</p>
      </div>
    );
  }

  return (
    <div>
      <Flash searchParams={props.searchParams} />
      <PageHeader
        title="Users"
        subtitle="Platform staff and agency accounts. Agency users are tied to their agency via membership — the boundary is enforced on every query."
        action={
          mayWrite ? (
            <a href="/admin/users?edit=new" className="btn-brand">
              + New user
            </a>
          ) : undefined
        }
      />

      {mayWrite && (props.searchParams.edit === "new" || editing) ? (
        <div className="card mb-8 p-5">
          <h2 className="mb-4 text-lg font-semibold">{editing ? `Edit — ${editing.name}` : "New user"}</h2>
          <form action={saveUserAction}>
            <input type="hidden" name="__back" value="/admin/users" />
            {editing ? <input type="hidden" name="__id" value={editing.id} /> : null}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
              <div>
                <label className="label">Full name</label>
                <input name="name" className="input" required defaultValue={editing?.name ?? ""} />
              </div>
              <div>
                <label className="label">Email</label>
                <input name="email" type="email" className="input" required defaultValue={editing?.email ?? ""} readOnly={!!editing} />
              </div>
              <div>
                <label className="label">Role</label>
                <select name="role" className="input" defaultValue={editing?.role ?? "AGENCY_USER"}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r.replace(/_/g, " ").toLowerCase()}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">{editing ? "New password (optional)" : "Password"}</label>
                <input name="password" type="password" className="input" minLength={editing ? undefined : 10} required={!editing} />
              </div>
            </div>
            <label className="mt-3 inline-flex items-center gap-2 text-sm">
              <input type="checkbox" name="isActive" defaultChecked={editing ? editing.isActive : true} className="h-4 w-4 accent-[var(--color-brand-primary)]" />
              Account active
            </label>
            <div className="mt-4">
              <button type="submit" className="btn-brand">
                {editing ? "Save user" : "Create user"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <div className="card overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">Name</th>
              <th className="th">Email</th>
              <th className="th">Role</th>
              <th className="th">Agency</th>
              <th className="th">Status</th>
              <th className="th">Last login</th>
              {mayWrite ? <th className="th text-right">Actions</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((u) => (
              <tr key={u.id} className="hover:bg-slate-50/60">
                <td className="td font-medium">{u.name}</td>
                <td className="td text-slate-500">{u.email}</td>
                <td className="td">
                  <Badge tone={u.role === "SUPER_ADMIN" || u.role === "ADMIN" ? "navy" : u.role.startsWith("AGENCY") ? "slate" : "amber"}>
                    {u.role.replace(/_/g, " ").toLowerCase()}
                  </Badge>
                </td>
                <td className="td text-slate-500">{agencyByUser.get(u.id) ?? "—"}</td>
                <td className="td">{u.isActive ? <Badge tone="green">active</Badge> : <Badge tone="red">disabled</Badge>}</td>
                <td className="td text-xs text-slate-400">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never"}</td>
                {mayWrite ? (
                  <td className="td text-right">
                    <a href={`/admin/users?edit=${u.id}`} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">
                      Edit
                    </a>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
