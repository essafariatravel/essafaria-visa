import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { getDb, countries, visaCategories, documentTypes, currencies, visaTypes } from "@/db";
import { requireStaff } from "@/lib/authorization";
import { can } from "@/lib/rbac";
import { ENTITY_UI, type FieldDef } from "@/app/admin/entity-ui";
import { listEntities, getEntityById, type Entities } from "@/lib/crud";
import { saveConfigEntityAction, toggleActiveAction, moveAction, deleteConfigAction } from "@/app/admin/actions";
import { Flash } from "@/app/admin/flash";
import { PageHeader, EmptyState, Badge, GhostButton, DangerButton } from "@/components/admin/ui";
import { TEMPLATE_VARIABLES, entityPermissionsFor } from "@/app/admin/entity-meta";

export const dynamic = "force-dynamic";

const ORDERABLE = new Set<Entities>([
  "countries",
  "visa-categories",
  "visa-types",
  "document-types",
  "statuses",
  "priorities",
  "navigation",
]);

async function loadOptions(forFields: FieldDef[]) {
  const db = await getDb();
  const out: Record<string, Array<{ value: string; label: string }>> = {};
  for (const f of forFields) {
    if (!f.optionsFrom || out[f.optionsFrom]) continue;
    if (f.optionsFrom === "countries") {
      out.countries = (await db.select().from(countries).where(eq(countries.isActive, true)).orderBy(asc(countries.name))).map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }));
    } else if (f.optionsFrom === "visaCategories") {
      out.visaCategories = (await db.select().from(visaCategories).where(eq(visaCategories.isActive, true)).orderBy(asc(visaCategories.name))).map((c) => ({ value: c.id, label: c.name }));
    } else if (f.optionsFrom === "documentTypes") {
      out.documentTypes = (await db.select().from(documentTypes).where(eq(documentTypes.isActive, true)).orderBy(asc(documentTypes.name))).map((c) => ({ value: c.id, label: c.name }));
    } else if (f.optionsFrom === "currencies") {
      out.currencies = (await db.select().from(currencies).where(eq(currencies.isActive, true)).orderBy(asc(currencies.code))).map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }));
    } else if (f.optionsFrom === "visaTypes") {
      out.visaTypes = (await db.select().from(visaTypes).where(eq(visaTypes.isActive, true)).orderBy(asc(visaTypes.name))).map((c) => ({ value: c.id, label: c.name }));
    }
  }
  return out;
}

function FieldInput({ field, value, options }: { field: FieldDef; value: unknown; options: Record<string, Array<{ value: string; label: string }>> }) {
  const v = value === null || value === undefined ? "" : String(value);
  const common = "input";
  switch (field.type) {
    case "textarea":
      return (
        <textarea
          name={field.name}
          rows={5}
          className={`${common} font-mono text-xs`}
          defaultValue={v}
          placeholder={field.hint}
        />
      );
    case "number":
      return <input className={common} type="number" name={field.name} defaultValue={v} />;
    case "checkbox":
      return (
        <label className="inline-flex items-center gap-2 py-1.5 text-sm">
          <input type="checkbox" name={field.name} defaultChecked={v === "" ? true : v === "true"} className="h-4 w-4 accent-[var(--color-brand-primary)]" />
          <span className="text-slate-500">{field.hint ?? "Yes"}</span>
        </label>
      );
    case "color":
      return (
        <div className="flex items-center gap-2">
          <input type="color" name={`${field.name}__picker`} defaultValue={v || "#334155"} className="h-9 w-12 cursor-pointer rounded border border-slate-300 bg-white" />
          <input className={common} name={field.name} defaultValue={v} placeholder="#0E7A6D" />
        </div>
      );
    case "date":
      return <input className={common} type="date" name={field.name} defaultValue={v} />;
    case "select": {
      const opts = field.options ?? options[field.optionsFrom ?? ""] ?? [];
      return (
        <select className={common} name={field.name} defaultValue={v}>
          <option value="">— none —</option>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    default:
      return <input className={common} name={field.name} defaultValue={v} placeholder={field.hint} />;
  }
}

function EntityForm({
  entity,
  row,
  fields,
  options,
}: {
  entity: string;
  row: Record<string, unknown> | null;
  fields: FieldDef[];
  options: Record<string, Array<{ value: string; label: string }>>;
}) {
  return (
    <form action={saveConfigEntityAction} className="card p-5">
      <input type="hidden" name="__entity" value={entity} />
      <input type="hidden" name="__back" value={`/admin/${entity}${row ? `?edit=${row.id}` : ""}`} />
      {row ? <input type="hidden" name="__id" value={String(row.id)} /> : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {fields.map((f) => (
          <div key={f.name} className={f.full ? "md:col-span-2" : ""}>
            <label className="label" htmlFor={`${f.name}-${row?.id ?? "new"}`}>
              {f.label}
              {f.required ? <span className="text-red-500"> *</span> : null}
            </label>
            <FieldInput field={f} value={row ? row[f.name] : undefined} options={options} />
          </div>
        ))}
      </div>
      <div className="mt-5 flex gap-2">
        <button type="submit" className="btn-brand">
          {row ? "Save changes" : "Create"}
        </button>
        <Link href={`/admin/${entity}`} className="btn-ghost">
          Cancel
        </Link>
      </div>
    </form>
  );
}

function Cell({ def, row }: { def: { key: string; render?: string }; row: Record<string, unknown> }) {
  const value = row[def.key];
  switch (def.render) {
    case "bool":
      return value ? <Badge tone="green">yes</Badge> : <Badge>no</Badge>;
    case "color":
      return typeof value === "string" && value ? (
        <span className="inline-block h-5 w-8 rounded border border-slate-300" style={{ background: value }} />
      ) : null;
    case "code":
      return <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{String(value ?? "")}</code>;
    case "cents": {
      const cents = Number(value ?? 0);
      return <span>{(cents / 100).toFixed(2)} {String(row.currencyCode ?? "")}</span>;
    }
    case "long": {
      const s = typeof value === "string" ? value : Array.isArray(value) ? value.join(", ") : String(value ?? "");
      return <span className="line-clamp-2 max-w-md text-slate-600">{s}</span>;
    }
    default:
      return <span>{value === null || value === undefined ? <span className="text-slate-300">—</span> : String(value)}</span>;
  }
}

export default async function EntityAdminPage(props: {
  params: { entity: string };
  searchParams: { edit?: string; flash?: string };
}) {
  const entity = props.params.entity as Entities;
  const ui = ENTITY_UI[entity];
  if (!ui) notFound();
  const user = await requireStaff();
  const perms = entityPermissionsFor(entity);
  const mayRead = can(user.role, perms.read);
  const mayWrite = can(user.role, perms.write);
  if (!mayRead) redirect("/admin?denied=" + entity);

  const editId = props.searchParams.edit;
  const rows = await listEntities(entity, {});
  const editRow = editId ? await getEntityById(entity, editId) : null;
  const options = await loadOptions(ui.fields);

  return (
    <div>
      <Flash searchParams={props.searchParams} />
      <PageHeader
        title={ui.title}
        subtitle={ui.subtitle}
        action={
          mayWrite ? (
            <Link href={`/admin/${entity}?edit=new`} className="btn-brand">
              + Add {ui.title.replace(/s$/, "")}
            </Link>
          ) : undefined
        }
      />
      {!mayWrite ? (
        <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Read-only for your role.
        </p>
      ) : null}

      {editRow !== undefined && (editId === "new" || editRow) ? (
        <div className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">{editId === "new" ? "New record" : "Edit record"}</h2>
          {mayWrite ? (
            <EntityForm entity={entity} row={editRow} fields={ui.fields} options={options} />
          ) : (
            <p className="text-sm text-red-600">You cannot edit records of this type.</p>
          )}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState title={`No ${ui.title.toLowerCase()} yet`} hint="Create the first one above." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                {ui.columns.map((c) => (
                  <th key={c.key} className="th">
                    {c.label}
                  </th>
                ))}
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={String(row.id)} className="hover:bg-slate-50/60">
                  {ui.columns.map((c) => (
                    <td key={c.key} className="td">
                      <Cell def={c} row={row} />
                    </td>
                  ))}
                  <td className="td text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {entity === "visa-types" ? (
                        <Link href={`/admin/visa-types/${row.id}`} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">
                          Requirements
                        </Link>
                      ) : null}
                      {mayWrite ? (
                        <>
                          <Link href={`/admin/${entity}?edit=${row.id}`} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">
                            Edit
                          </Link>
                          {ORDERABLE.has(entity) ? (
                            <form action={moveAction} className="inline">
                              <input type="hidden" name="__entity" value={entity} />
                              <input type="hidden" name="__id" value={String(row.id)} />
                              <input type="hidden" name="__back" value={`/admin/${entity}`} />
                              <input type="hidden" name="__dir" value="up" />
                              <GhostButton>↑</GhostButton>
                            </form>
                          ) : null}
                          {"isActive" in row ? (
                            <form action={toggleActiveAction} className="inline">
                              <input type="hidden" name="__entity" value={entity} />
                              <input type="hidden" name="__id" value={String(row.id)} />
                              <input type="hidden" name="__back" value={`/admin/${entity}`} />
                              <input type="hidden" name="__active" value={row.isActive ? "false" : "true"} />
                              <GhostButton>{row.isActive ? "Deactivate" : "Activate"}</GhostButton>
                            </form>
                          ) : null}
                          {entity === "fees" || entity === "visa-requirements" ? (
                            <form action={deleteConfigAction} className="inline">
                              <input type="hidden" name="__entity" value={entity} />
                              <input type="hidden" name="__id" value={String(row.id)} />
                              <input type="hidden" name="__back" value={`/admin/${entity}`} />
                              <DangerButton>Delete</DangerButton>
                            </form>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {entity === "templates" ? (
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm">
          <p className="font-semibold text-slate-700">Available template variables</p>
          <p className="mt-1 text-slate-500">
            {TEMPLATE_VARIABLES.map((v) => (
              <code key={v} className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs">
                {`{{${v}}}`}
              </code>
            ))}
          </p>
        </div>
      ) : null}
    </div>
  );
}
