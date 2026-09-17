import { Badge, EmptyState, PageHeader } from "@/components/admin/ui";
import { Field, Form, Notice, Panel } from "@/components/ops/ui";
import { listTeam } from "@/lib/agency-team";
import { opActorForPage } from "@/lib/page-auth";
import { addTeamMemberAction, removeTeamMemberAction, setMemberRoleAction, setPrimaryContactAction } from "@/app/agency/actions";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Partner-managed access list. Roles stay inside AGENCY_ADMIN / AGENCY_USER:
 * escalation to a staff role is impossible from here by construction (the
 * service refuses it, and the form only offers these two).
 */
export default async function AgencyTeamPage({ searchParams }: { searchParams: { flash?: string } }) {
  const actor = await opActorForPage("agencies.users.manage");
  const { agencyName, members } = await listTeam(actor);
  const me = await getSessionUser();
  const flash = searchParams.flash ? decodeURIComponent(searchParams.flash).replace(/^(ok|err):/, "") : null;
  const admins = members.filter((m) => m.role === "AGENCY_ADMIN" && m.isActive).length;

  return (
    <div className="pb-16">
      <PageHeader title="Team" subtitle={`People who can sign in to the ${agencyName} portal. Removing someone keeps the history of the files they opened.`} />
      {flash ? (
        <div className="mb-4">
          <Notice kind={searchParams.flash?.startsWith("err") ? "error" : "info"}>{flash}</Notice>
        </div>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title={`Members (${members.length})`}>
            {!members.length ? (
              <EmptyState title="No members" hint="Add your first colleague below." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {members.map((m) => (
                  <li key={m.userId} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                        {m.name}
                        {m.userId === me?.id ? <Badge tone="navy">you</Badge> : null}
                        {m.isPrimary ? <Badge tone="green">primary</Badge> : null}
                        {m.isActive ? null : <Badge tone="slate">deactivated</Badge>}
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                          {m.role.replace(/_/g, " ").toLowerCase()}
                        </span>
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        {m.email} · {m.applicationsCreated} file{m.applicationsCreated === 1 ? "" : "s"} opened ·{" "}
                        {m.lastLoginAt ? `last seen ${new Date(m.lastLoginAt).toLocaleDateString()}` : "never signed in"}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <form action={setMemberRoleAction} className="flex items-center gap-1">
                        <input type="hidden" name="userId" value={m.userId} />
                        <input type="hidden" name="__back" value="/agency/team" />
                        <select name="role" defaultValue={m.role} className="input !w-auto !py-1 text-[11px]" aria-label={`Role for ${m.name}`}>
                          <option value="AGENCY_ADMIN">Admin</option>
                          <option value="AGENCY_USER">User</option>
                        </select>
                        <button type="submit" className="rounded-md border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100">
                          Set
                        </button>
                      </form>
                      {!m.isPrimary ? (
                        <form action={setPrimaryContactAction}>
                          <input type="hidden" name="userId" value={m.userId} />
                          <input type="hidden" name="__back" value="/agency/team" />
                          <button type="submit" className="rounded-md border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100">
                            Make primary
                          </button>
                        </form>
                      ) : null}
                      {m.userId !== me?.id ? (
                        <form action={removeTeamMemberAction}>
                          <input type="hidden" name="userId" value={m.userId} />
                          <input type="hidden" name="__back" value="/agency/team" />
                          <button type="submit" className="rounded-md border border-red-200 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50">
                            Remove
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {admins <= 1 ? (
              <div className="mt-4">
                <Notice kind="warn">Only one administrator is active — add a second person so the agency can never be locked out.</Notice>
              </div>
            ) : null}
          </Panel>
        </div>
        <div>
          <Panel title="Add a colleague" subtitle="If the email already has an ESSAFARIA account, it is linked instead of duplicated.">
            <Form action={addTeamMemberAction} submitLabel="Add member" back="/agency/team">
              <Field name="email" type="email" label="Email" required />
              <Field name="name" label="Display name" hint="optional — defaults to the email local part" />
              <Field
                as="select"
                name="role"
                label="Role"
                required
                defaultValue="AGENCY_USER"
                options={[
                  { value: "AGENCY_USER", label: "User — files, documents, wallet view" },
                  { value: "AGENCY_ADMIN", label: "Admin — plus team management and submissions" },
                ]}
              />
              <Field name="password" type="password" label="Temporary password" hint="leave empty to generate one, shown once after creation" />
              <Field as="checkbox" name="isPrimary" label="Primary contact" defaultValue={false} hint="Receives agency-wide notices first" />
            </Form>
          </Panel>
          <Panel title="What a partner admin cannot do">
            <ul className="list-disc space-y-1.5 pl-4 text-xs text-slate-600">
              <li>promote a colleague to an ESSAFARIA staff role</li>
              <li>reset or read another member&apos;s password</li>
              <li>link an account that already belongs to a different agency</li>
              <li>remove the last remaining administrator — or their own access</li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
