import { eq } from "drizzle-orm";
import { getDb, brandSettings, media } from "@/db";
import { requireStaff } from "@/lib/authorization";
import { can } from "@/lib/rbac";
import { getBranding } from "@/lib/config-service";
import { saveBrandingAction, uploadMediaAction } from "@/app/admin/actions";
import { Flash } from "@/app/admin/flash";
import { PageHeader, Badge } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

const COLOR_FIELDS = [
  ["primaryColor", "Primary (buttons, links)"],
  ["secondaryColor", "Secondary (headers, footers)"],
  ["accentColor", "Accent (highlights, badges)"],
  ["backgroundColor", "Page background"],
  ["textColor", "Body text"],
] as const;

export default async function BrandingPage(props: { searchParams: { flash?: string } }) {
  const user = await requireStaff();
  const mayWrite = can(user.role, "branding.write");
  const db = await getDb();
  const branding = await getBranding();
  const [row] = await db.select().from(brandSettings).limit(1);
  const images = await db
    .select({ id: media.id, filename: media.filename, kind: media.kind, createdAt: media.createdAt })
    .from(media)
    .orderBy(media.createdAt);

  return (
    <div>
      <Flash searchParams={props.searchParams} />
      <PageHeader
        title="Branding"
        subtitle="Identity flows from here to the public site, the agency portal and this console via CSS tokens — no component hardcodes a logo or colour."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          {mayWrite ? (
            <form action={saveBrandingAction} className="space-y-5">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="label">Brand name</label>
                  <input name="brandName" className="input" required defaultValue={row?.brandName ?? branding.brandName} />
                </div>
                <div>
                  <label className="label">Company (legal) name</label>
                  <input name="companyName" className="input" required defaultValue={row?.companyName ?? branding.companyName} />
                </div>
                <div className="md:col-span-2">
                  <label className="label">Tagline</label>
                  <input name="tagline" className="input" defaultValue={row?.tagline ?? branding.tagline ?? ""} />
                </div>
                {COLOR_FIELDS.map(([name, label]) => (
                  <div key={name}>
                    <label className="label">{label}</label>
                    <div className="flex items-center gap-2">
                      <input type="color" name={`${name}__picker`} defaultValue={String(branding[name])} className="h-9 w-12 cursor-pointer rounded border border-slate-300" />
                      <input name={name} className="input font-mono text-xs" defaultValue={String(branding[name])} required pattern="^#[0-9a-fA-F]{6}$" />
                    </div>
                  </div>
                ))}
                <div>
                  <label className="label">Button style</label>
                  <select name="buttonStyle" className="input" defaultValue={row?.buttonStyle ?? "rounded"}>
                    <option value="rounded">Rounded</option>
                    <option value="pill">Pill</option>
                    <option value="square">Square</option>
                  </select>
                </div>
                <div className="md:col-span-2 grid gap-4 md:grid-cols-3">
                  {(
                    [
                      ["logoMediaId", "Header logo"],
                      ["secondaryLogoMediaId", "Footer logo"],
                      ["faviconMediaId", "Favicon"],
                    ] as const
                  ).map(([name, label]) => (
                    <div key={name}>
                      <label className="label">{label}</label>
                      <select name={name} className="input" defaultValue={String((row?.[name] as string | null) ?? "")}>
                        <option value="">— text mark fallback —</option>
                        {images.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.filename} ({m.kind.toLowerCase()})
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
              <button type="submit" className="btn-brand">
                Save branding
              </button>
              <span className="ml-3 text-xs text-slate-500">Applies to every surface immediately after save.</span>
            </form>
          ) : (
            <p className="text-sm text-slate-500">Read-only for your role.</p>
          )}
        </div>

        <div className="space-y-6">
          <div className="card p-5">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-600">Live preview</h2>
            <div className="rounded-lg border p-5" style={{ background: branding.backgroundColor, color: branding.textColor }}>
              <p className="text-lg font-bold" style={{ color: branding.secondaryColor }}>
                {branding.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={branding.logoUrl} alt={branding.brandName} className="h-8 w-auto" />
                ) : (
                  branding.brandName
                )}
              </p>
              <p className="mt-1 text-xs opacity-70">{branding.tagline}</p>
              <div className="mt-4 flex gap-2">
                <span
                  className="px-4 py-2 text-xs font-semibold text-white"
                  style={{
                    background: branding.primaryColor,
                    borderRadius: branding.buttonStyle === "pill" ? 999 : branding.buttonStyle === "square" ? 0 : 8,
                  }}
                >
                  Primary action
                </span>
                <span className="px-4 py-2 text-xs font-semibold" style={{ color: branding.accentColor }}>
                  Accent link
                </span>
              </div>
            </div>
          </div>

          {mayWrite ? (
            <div className="card p-5">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-600">Upload image</h2>
              <form action={uploadMediaAction} className="space-y-3">
                <input type="hidden" name="__back" value="/admin/branding" />
                <div>
                  <label className="label">Kind</label>
                  <select name="kind" className="input">
                    {["LOGO", "FAVICON", "HERO", "CONTENT", "OTHER"].map((k) => (
                      <option key={k} value={k}>
                        {k.toLowerCase()}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">File (PNG/JPEG/WebP, max 2 MB)</label>
                  <input type="file" name="file" accept="image/png,image/jpeg,image/webp" required className="block w-full text-xs" />
                </div>
                <button type="submit" className="btn-brand">
                  Upload to library
                </button>
              </form>
              <p className="mt-3 text-[11px] leading-4 text-slate-400">
                Stored through the media storage provider abstraction — swap local disk for S3/Cloudinary later without touching admin screens.
                Binaries never go in the database.
              </p>
            </div>
          ) : null}

          <div className="card p-5">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-600">Current tokens</h2>
            <ul className="space-y-1 text-xs">
              {COLOR_FIELDS.map(([name, label]) => (
                <li key={name} className="flex items-center gap-2">
                  <span className="inline-block h-3.5 w-6 rounded border border-slate-200" style={{ background: String(branding[name]) }} />
                  <code>{`--color-brand-${name.replace("Color", "")}`}</code>
                  <Badge>{String(branding[name])}</Badge>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
