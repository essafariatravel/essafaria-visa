import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { getDb, legalPages } from "@/db";
import { requireStaff } from "@/lib/authorization";
import { can } from "@/lib/rbac";
import { saveLegalPageAction, publishLegalPageAction } from "@/app/admin/actions";
import { Flash } from "@/app/admin/flash";
import { PageHeader, Badge } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default async function LegalPagesPage(props: { searchParams: { edit?: string; flash?: string } }) {
  const user = await requireStaff();
  const mayWrite = can(user.role, "content.write");
  const db = await getDb();
  const rows = await db.select().from(legalPages).orderBy(asc(legalPages.title));
  const editing = props.searchParams.edit && props.searchParams.edit !== "new"
    ? await db.select().from(legalPages).where(eq(legalPages.id, props.searchParams.edit)).limit(1).then((r) => r[0] ?? null)
    : null;
  const blocksText = editing
    ? editing.body
        .map((b) => (b.type === "h2" ? `## ${b.text}` : b.type === "li" ? `- ${b.text}` : b.text))
        .join("\n")
    : "";

  return (
    <div>
      <Flash searchParams={props.searchParams} />
      <PageHeader
        title="Legal & Content Pages"
        subtitle="Structured content blocks — lines starting with “## ” become headings, “- ” become list items, everything else paragraphs. No raw HTML."
        action={
          mayWrite ? (
            <Link href="/admin/legal?edit=new" className="btn-brand">
              + New page
            </Link>
          ) : undefined
        }
      />

      {mayWrite && (props.searchParams.edit === "new" || editing) ? (
        <div className="card mb-8 p-5">
          <h2 className="mb-4 text-lg font-semibold">{editing ? `Edit “${editing.title}”` : "New page"}</h2>
          <form action={saveLegalPageAction}>
            {editing ? <input type="hidden" name="__id" value={editing.id} /> : null}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="label">Slug</label>
                <input name="slug" className="input" required defaultValue={editing?.slug ?? ""} placeholder="refund-policy" />
                <p className="mt-1 text-[11px] text-slate-400">Public URL: /legal/&lt;slug&gt;</p>
              </div>
              <div>
                <label className="label">Title</label>
                <input name="title" className="input" required defaultValue={editing?.title ?? ""} />
              </div>
              <div className="md:col-span-2">
                <label className="label">Content blocks</label>
                <textarea name="blocks" rows={14} className="input font-mono text-xs" required defaultValue={blocksText} />
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              <button type="submit" className="btn-brand">
                Save page
              </button>
              <Link href="/admin/legal" className="btn-ghost">
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
              <th className="th">Title</th>
              <th className="th">Slug</th>
              <th className="th">State</th>
              <th className="th">Published</th>
              <th className="th text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50/60">
                <td className="td font-medium">{p.title}</td>
                <td className="td">
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{p.slug}</code>
                </td>
                <td className="td">
                  <Badge tone={p.publishState === "PUBLISHED" ? "green" : "amber"}>{p.publishState.toLowerCase()}</Badge>
                </td>
                <td className="td text-xs text-slate-400">{p.publishedAt ? new Date(p.publishedAt).toLocaleDateString() : "—"}</td>
                <td className="td text-right">
                  {mayWrite ? (
                    <div className="flex justify-end gap-1.5">
                      <Link href={`/admin/legal?edit=${p.id}`} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">
                        Edit
                      </Link>
                      <form action={publishLegalPageAction} className="inline">
                        <input type="hidden" name="__id" value={p.id} />
                        <input type="hidden" name="__action" value={p.publishState === "PUBLISHED" ? "unpublish" : "publish"} />
                        <button type="submit" className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">
                          {p.publishState === "PUBLISHED" ? "Unpublish" : "Publish"}
                        </button>
                      </form>
                      {p.publishState === "PUBLISHED" ? (
                        <Link href={`/legal/${p.slug}`} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">
                          View
                        </Link>
                      ) : null}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
