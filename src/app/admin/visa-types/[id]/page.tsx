import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { getDb, visaTypes, countries, documentTypes, visaRequirements } from "@/db";
import { requireStaff } from "@/lib/authorization";
import { can } from "@/lib/rbac";
import { listEntities, getEntityById } from "@/lib/crud";
import { saveConfigEntityAction, deleteConfigAction, moveAction } from "@/app/admin/actions";
import { Flash } from "@/app/admin/flash";
import { PageHeader, Badge, DangerButton, GhostButton, EmptyState } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default async function VisaTypeRequirementsPage(props: {
  params: { id: string };
  searchParams: { flash?: string };
}) {
  const user = await requireStaff();
  const mayWrite = can(user.role, "visa_requirements.write");
  const db = await getDb();
  const [visa] = await db
    .select({ id: visaTypes.id, code: visaTypes.code, name: visaTypes.name, country: countries.name })
    .from(visaTypes)
    .innerJoin(countries, eq(countries.id, visaTypes.countryId))
    .where(eq(visaTypes.id, props.params.id))
    .limit(1);
  if (!visa) notFound();

  const reqs = (await listEntities("visa-requirements", { filters: { visaTypeId: visa.id } })) as Array<{
    id: string;
    documentTypeId: string;
    isRequired: boolean;
    instructions: string | null;
    validityDays: number | null;
    displayOrder: number;
  }>;
  const docs = await db.select().from(documentTypes).where(eq(documentTypes.isActive, true)).orderBy(asc(documentTypes.name));
  const docById = new Map(docs.map((d) => [d.id, d]));
  const typeRow = await getEntityById("visa-types", visa.id);

  return (
    <div>
      <Flash searchParams={props.searchParams} />
      <PageHeader
        title={`Requirements — ${visa.name}`}
        subtitle={`Checklist applicants must satisfy for ${visa.code} (${visa.country}). This list drives agency portals and upload validation once applications go live.`}
        action={
          <Link href="/admin/visa-types" className="btn-ghost">
            ← All visa types
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap gap-3 text-sm text-slate-500">
        <span className="rounded-lg bg-white px-3 py-1.5 ring-1 ring-slate-200">
          Processing: <b className="text-slate-800">{String(typeRow?.processingTimeDays ?? "—")} business days</b>
        </span>
        <span className="rounded-lg bg-white px-3 py-1.5 ring-1 ring-slate-200">
          Country: <b className="text-slate-800">{visa.country}</b>
        </span>
        <Link href={`/admin/visa-types?edit=${visa.id}`} className="rounded-lg bg-white px-3 py-1.5 ring-1 ring-slate-200 hover:bg-slate-50">
          Edit visa type settings →
        </Link>
      </div>

      {mayWrite ? (
        <form action={saveConfigEntityAction} className="card mb-6 grid grid-cols-1 items-end gap-3 p-4 md:grid-cols-5">
          <input type="hidden" name="__entity" value="visa-requirements" />
          <input type="hidden" name="__back" value={`/admin/visa-types/${visa.id}`} />
          <input type="hidden" name="visaTypeId" value={visa.id} />
          <div>
            <label className="label">Document type</label>
            <select name="documentTypeId" className="input" required>
              <option value="">select…</option>
              {docs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Instructions</label>
            <input name="instructions" className="input" placeholder="optional guidance for the agency" />
          </div>
          <div>
            <label className="label">Min validity (days)</label>
            <input name="validityDays" type="number" className="input" />
          </div>
          <label className="inline-flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="isRequired" defaultChecked className="h-4 w-4 accent-[var(--color-brand-primary)]" />
            Required
          </label>
          <button type="submit" className="btn-brand">
            Add requirement
          </button>
        </form>
      ) : null}

      {reqs.length === 0 ? (
        <EmptyState title="No requirements configured" hint="Without requirements, agency users won’t know what to collect. Add the checklist above." />
      ) : (
        <div className="space-y-2">
          {reqs.map((r, i) => {
            const doc = docById.get(r.documentTypeId);
            return (
              <div key={r.id} className="card flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="w-6 text-center text-sm font-bold text-slate-300">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {doc?.name ?? "Unknown document"}{" "}
                    <code className="ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-500">{doc?.code ?? r.documentTypeId}</code>
                  </p>
                  {r.instructions ? <p className="mt-0.5 text-xs text-slate-500">{r.instructions}</p> : null}
                </div>
                <div className="flex items-center gap-2 text-xs">
                  {doc?.allowedExtensions?.length ? (
                    <Badge>{(doc.allowedExtensions as string[]).join(", ")}</Badge>
                  ) : null}
                  {r.validityDays ? <Badge tone="amber">valid {r.validityDays}d+</Badge> : null}
                  {r.isRequired ? <Badge tone="red">required</Badge> : <Badge>optional</Badge>}
                </div>
                {mayWrite ? (
                  <div className="flex items-center gap-1.5">
                    <form action={moveAction} className="inline">
                      <input type="hidden" name="__entity" value="visa-requirements" />
                      <input type="hidden" name="__id" value={r.id} />
                      <input type="hidden" name="__back" value={`/admin/visa-types/${visa.id}`} />
                      <input type="hidden" name="__dir" value="up" />
                      <input type="hidden" name="__scopeCol" value="visaTypeId" />
                      <input type="hidden" name="__scopeVal" value={visa.id} />
                      <GhostButton>↑</GhostButton>
                    </form>
                    <form action={deleteConfigAction} className="inline">
                      <input type="hidden" name="__entity" value="visa-requirements" />
                      <input type="hidden" name="__id" value={r.id} />
                      <input type="hidden" name="__back" value={`/admin/visa-types/${visa.id}`} />
                      <DangerButton>Remove</DangerButton>
                    </form>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
