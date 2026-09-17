import Link from "next/link";
import { Badge, EmptyState, PageHeader } from "@/components/admin/ui";
import { Panel, Pagination } from "@/components/ops/ui";
import { listNotificationsForUser, unreadCounts } from "@/lib/notifications";
import { getSessionUser } from "@/lib/session";
import { requirePermissionForPage } from "@/lib/authorization";
import { markAllReadAction, markOneReadAction } from "@/app/agency/actions";

export const dynamic = "force-dynamic";

/** Portal inbox. Read-state is per user, never per agency, so one colleague
 *  marking a notice read does not hide it from the rest of the agency. */
export default async function AgencyInboxPage({ searchParams }: { searchParams: { unread?: string; page?: string } }) {
  await requirePermissionForPage("notifications.read");
  const user = await getSessionUser();
  if (!user) return null;
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);
  const { rows, total } = await listNotificationsForUser(
    { id: user.id, agencyIds: user.agencyIds },
    { unreadOnly: searchParams.unread === "1", limit: 20, offset: (page - 1) * 20 },
  );
  const counts = await unreadCounts(user.id);

  return (
    <div className="pb-16">
      <PageHeader
        title="Inbox"
        subtitle={`${counts.total} unread, ${counts.actionRequired} needing action from you.`}
        action={
          <div className="flex items-center gap-2">
            <Link href={`/agency/inbox${searchParams.unread === "1" ? "" : "?unread=1"}`} className="rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100">
              {searchParams.unread === "1" ? "Show all" : "Unread only"}
            </Link>
            <form action={markAllReadAction}>
              <button type="submit" className="btn-brand !px-3 !py-2 text-xs">
                Mark all read
              </button>
            </form>
          </div>
        }
      />
      <Panel tight>
        {!rows.length ? (
          <EmptyState title="Nothing here" hint="Status changes, document decisions and billing events land in this inbox." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((n) => (
              <li key={n.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.readAt ? "bg-slate-200" : "bg-[var(--color-brand-primary)]"}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                    {n.title}
                    {n.severity === "ACTION_REQUIRED" ? <Badge tone="amber">action needed</Badge> : null}
                    {n.severity === "WARNING" ? <Badge tone="red">warning</Badge> : null}
                    {n.severity === "SUCCESS" ? <Badge tone="green">done</Badge> : null}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-600">{n.body}</p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                    <span>{new Date(n.createdAt).toLocaleString()}</span>
                    {n.link ? (
                      <Link href={n.link} className="font-semibold text-[var(--color-brand-primary)] hover:underline">
                        {n.reference ? `Open ${n.reference}` : "Open"}
                      </Link>
                    ) : null}
                    {!n.readAt ? (
                      <form action={markOneReadAction} className="inline">
                        <input type="hidden" name="id" value={n.id} />
                        <input type="hidden" name="__back" value="/agency/inbox" />
                        <button type="submit" className="font-semibold text-slate-500 hover:text-slate-800">
                          mark read
                        </button>
                      </form>
                    ) : null}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Pagination
          page={page}
          pageSize={20}
          total={total}
          hrefFor={(p) => `/agency/inbox${searchParams.unread === "1" ? "?unread=1&page=" : "?page="}${p}`}
        />
      </Panel>
    </div>
  );
}
