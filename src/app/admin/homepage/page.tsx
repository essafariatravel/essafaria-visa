import { asc, eq } from "drizzle-orm";
import { getDb, homepageSections, media } from "@/db";
import { requireStaff } from "@/lib/authorization";
import { can } from "@/lib/rbac";
import { saveSectionAction, sectionStateAction, moveSectionAction } from "@/app/admin/actions";
import { Flash } from "@/app/admin/flash";
import { PageHeader, Badge, DangerButton, GhostButton } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

const SECTION_TYPES = [
  ["hero", "Hero — first screen"],
  ["services", "Services grid"],
  ["destinations", "Destinations (reads visa catalog by country codes)"],
  ["process", "Process steps"],
  ["why", "Why us / features"],
  ["cta", "Call to action band"],
] as const;

export default async function HomepageAdminPage(props: { searchParams: { edit?: string; flash?: string } }) {
  const user = await requireStaff();
  const mayWrite = can(user.role, "content.write");
  const db = await getDb();
  const rows = await db.select().from(homepageSections).orderBy(asc(homepageSections.displayOrder));
  const images = await db.select({ id: media.id, filename: media.filename }).from(media).orderBy(asc(media.createdAt));
  const editId = props.searchParams.edit;
  const editing = editId && editId !== "new" ? rows.find((r) => r.id === editId) ?? null : null;
  const itemsJson = editing ? JSON.stringify((editing.config as any)?.items ?? [], null, 2) : "[]";

  return (
    <div>
      <Flash searchParams={props.searchParams} />
      <PageHeader
        title="Homepage Builder"
        subtitle="Sections are ordered, activated and published from here. The public page renders only PUBLISHED sections, in this order. Content is structured data — never raw HTML."
        action={
          mayWrite ? (
            <a href="/admin/homepage?edit=new" className="btn-brand">
              + Add section
            </a>
          ) : undefined
        }
      />

      {mayWrite && (editId === "new" || editing) ? (
        <div className="card mb-8 p-5">
          <h2 className="mb-4 text-lg font-semibold">{editing ? "Edit section" : "New section"}</h2>
          <form action={saveSectionAction}>
            <input type="hidden" name="__id" value={editing?.id ?? ""} />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="label">Section type</label>
                <select name="sectionType" className="input" defaultValue={editing?.sectionType ?? "hero"}>
                  {SECTION_TYPES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Display order</label>
                <input name="displayOrder" type="number" className="input" defaultValue={editing?.displayOrder ?? rows.length * 10 + 10} />
              </div>
              <div>
                <label className="label">Title</label>
                <input name="title" className="input" defaultValue={editing?.title ?? ""} />
              </div>
              <div>
                <label className="label">Subtitle</label>
                <input name="subtitle" className="input" defaultValue={editing?.subtitle ?? ""} />
              </div>
              <div className="md:col-span-2">
                <label className="label">Body text</label>
                <textarea name="body" rows={3} className="input" defaultValue={editing?.body ?? ""} />
              </div>
              <div>
                <label className="label">Button label</label>
                <input name="ctaLabel" className="input" defaultValue={editing?.ctaLabel ?? ""} />
              </div>
              <div>
                <label className="label">Button link</label>
                <input name="ctaHref" className="input" defaultValue={editing?.ctaHref ?? ""} placeholder="/contact" />
              </div>
              <div>
                <label className="label">Background image (media library)</label>
                <select name="imageMediaId" className="input" defaultValue={editing?.imageMediaId ?? ""}>
                  <option value="">— none —</option>
                  {images.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.filename}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Overlay darkness (0–100)</label>
                <input name="overlayOpacity" type="number" min={0} max={100} className="input" defaultValue={editing?.overlayOpacity ?? 40} />
              </div>
              <div className="md:col-span-2">
                <label className="label">Items (JSON list of {"{title, description}"})</label>
                <textarea name="items" rows={8} className="input font-mono text-xs" defaultValue={itemsJson} />
                <p className="mt-1 text-[11px] text-slate-400">
                  Used by services / process / why sections. The destinations section renders automatically from the active
                  visa catalog (countries with active visa types) — no items needed there.
                </p>
              </div>
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" name="isActive" defaultChecked={editing ? editing.isActive : true} className="h-4 w-4 accent-[var(--color-brand-primary)]" />
                Section enabled
              </label>
            </div>
            <div className="mt-5">
              <button type="submit" className="btn-brand">
                Save section
              </button>
              <a href="/admin/homepage" className="btn-ghost ml-2">
                Cancel
              </a>
            </div>
          </form>
        </div>
      ) : null}

      <div className="space-y-3">
        {rows.map((s, i) => (
          <div key={s.id} className="card flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="w-8 text-center text-lg font-bold text-slate-300">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">
                {s.title || s.sectionType}{" "}
                <code className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase text-slate-500">{s.sectionType}</code>
              </p>
              <p className="truncate text-xs text-slate-400">{s.subtitle ?? s.body ?? "—"}</p>
            </div>
            <Badge tone={s.publishState === "PUBLISHED" ? "green" : s.publishState === "ARCHIVED" ? "red" : "amber"}>
              {s.publishState.toLowerCase()}
            </Badge>
            <Badge tone={s.isActive ? "slate" : "red"}>{s.isActive ? "shown" : "hidden"}</Badge>
            {mayWrite ? (
              <div className="flex items-center gap-1.5">
                <form action={moveSectionAction} className="inline">
                  <input type="hidden" name="__id" value={s.id} />
                  <input type="hidden" name="__dir" value="up" />
                  <GhostButton>↑</GhostButton>
                </form>
                <form action={moveSectionAction} className="inline">
                  <input type="hidden" name="__id" value={s.id} />
                  <input type="hidden" name="__dir" value="down" />
                  <GhostButton>↓</GhostButton>
                </form>
                <a href={`/admin/homepage?edit=${s.id}`} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">
                  Edit
                </a>
                <form action={sectionStateAction} className="inline">
                  <input type="hidden" name="__id" value={s.id} />
                  <input type="hidden" name="__action" value={s.publishState === "PUBLISHED" ? "unpublish" : "publish"} />
                  <GhostButton>{s.publishState === "PUBLISHED" ? "Unpublish" : "Publish"}</GhostButton>
                </form>
                <form action={sectionStateAction} className="inline">
                  <input type="hidden" name="__id" value={s.id} />
                  <input type="hidden" name="__action" value="delete" />
                  <DangerButton>Delete</DangerButton>
                </form>
              </div>
            ) : null}
          </div>
        ))}
        {rows.length === 0 ? <p className="text-sm text-slate-400">No sections yet — the public homepage falls back to branding + defaults.</p> : null}
      </div>
    </div>
  );
}
