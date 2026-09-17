import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { getDb, agencies, agencyMemberships, users } from "@/db";
import { requireStaff } from "@/lib/authorization";
import { can } from "@/lib/rbac";
import { assertAgencyAccess } from "@/lib/tenancy";
import { setAgencyStatusAction, assignMemberAction, removeMemberAction } from "@/app/admin/actions";
import { Flash } from "@/app/admin/flash";
import { Badge, PageHeader, DangerButton, GhostButton } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default async function AgencyDetailPage(props: { params: { id: string }; searchParams: { flash?: string } }) {
  const user = await requireStaff();
  const mayManage = can(user.role, "agencies.users.manage");
  if (!mayManage) redirect("/admin");
  await assertAgencyAccess(user, props.params.id);

  const db = await getDb();
  const [agency] = await db.select().from(agencies).where(eq(agencies.id, props.params.id)).limit(1);
  if (!agency) notFound();

  const members = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      isPrimary: agencyMemberships.isPrimary,
      lastLogin: users.lastLoginAt,
    })
    .from(agencyMemberships)
    .innerJoin(users, eq(users.id, agencyMemberships.userId))
    .where(eq(agencyMemberships.agencyId, agency.id))
    .orderBy(asc(users.name));

  return (
    <div>
      <Flash searchParams={props.searchParams} />
      <PageHeader
        title={agency.name}
        subtitle={`Agency ${agency.code}${agency.city ? ` · ${agency.city}` : ""}${agency.email ? ` · ${agency.email}` : ""}`}
        action={
          <Link href="/admin/agencies" className="btn-ghost">
            ← Back to agencies
          </Link>
        }
      />

      <div className="mb-8 flex flex-wrap items-center gap-3">
        <Badge tone={agency.status === "ACTIVE" ? "green" : agency.status === "SUSPENDED" ? "red" : "slate"}>
          {agency.status.toLowerCase()}
        </Badge>
        {can(user.role, "agencies.write") ? (
          <>
            {agency.status !== "ACTIVE" && (
              <form action={setAgencyStatusAction} className="inline">
                <input type="hidden" name="__id" value={agency.id} />
                <input type="hidden" name="status" value="ACTIVE" />
                <GhostButton>Reactivate</GhostButton>
              </form>
            )}
            {agency.status !== "SUSPENDED" && (
              <form action={setAgencyStatusAction} className="inline">
                <input type="hidden" name="__id" value={agency.id} />
                <input type="hidden" name="status" value="SUSPENDED" />
                <DangerButton>Suspend agency</DangerButton>
              </form>
            )}
          </>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-600">
            Members ({members.length})
          </h2>
          {members.length === 0 ? (
            <p className="text-sm text-slate-400">No users assigned yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {members.map((m) => (
                <li key={m.userId} className="flex items-center gap-3 py-2 text-sm">
                  <span className="font-medium">{m.name}</span>
                  <span className="text-slate-500">{m.email}</span>
                  <Badge tone="navy">{m.role.replace(/_/g, " ").toLowerCase()}</Badge>
                  {m.isPrimary ? <Badge tone="amber">primary</Badge> : null}
                  <span className="ml-auto text-xs text-slate-400">
                    {m.lastLogin ? `last login ${new Date(m.lastLogin).toLocaleDateString()}` : "never signed in"}
                  </span>
                  {can(user.role, "agencies.write") ? (
                    <form action={removeMemberAction} className="inline">
                      <input type="hidden" name="agencyId" value={agency.id} />
                      <input type="hidden" name="userId" value={m.userId} />
                      <DangerButton>remove</DangerButton>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {can(user.role, "agencies.write") ? (
            <form action={assignMemberAction} className="mt-5 flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 p-4">
              <input type="hidden" name="agencyId" value={agency.id} />
              <div className="min-w-64 flex-1">
                <label className="label">Existing user email</label>
                <input name="email" className="input" placeholder="name@agency.example" required />
              </div>
              <button className="btn-brand" type="submit">
                Assign to agency
              </button>
            </form>
          ) : null}
        </div>

        <div className="card p-5">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-600">Profile</h2>
          <dl className="space-y-2 text-sm">
            {(
              [
                ["Legal name", agency.legalName],
                ["Phone", agency.phone],
                ["Address", agency.address],
                ["Contact", agency.contactPerson],
                ["Billing", agency.billingInfo],
                ["Notes", agency.notes],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="grid grid-cols-3 gap-2 border-b border-slate-100 pb-1.5">
                <dt className="col-span-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{k}</dt>
                <dd className="col-span-2 whitespace-pre-wrap text-slate-700">{v ? String(v) : "—"}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
