import { getBranding, getPublishedHomepageSections } from "@/lib/config-service";
import { RenderSection } from "@/components/site/sections";
import { DEFAULT_BRANDING } from "@/lib/config-service";

export const dynamic = "force-dynamic";

/**
 * Public homepage — fully CMS-driven. When no sections are published, a
 * minimal fallback hero (branding + tagline) renders instead of a blank
 * page: missing configuration must degrade, never crash (§32), and the
 * condition is logged.
 */
export default async function HomePage() {
  const [branding, sections] = await Promise.all([
    getBranding().catch(() => ({ ...DEFAULT_BRANDING, logoUrl: null, faviconUrl: null })),
    getPublishedHomepageSections().catch((err) => {
      console.warn("[homepage] could not load sections, using fallback:", err);
      return [] as Awaited<ReturnType<typeof getPublishedHomepageSections>>;
    }),
  ]);

  if (sections.length === 0) {
    console.warn("[homepage] no published sections — configure the Homepage Builder in admin");
    return (
      <section
        className="px-4 py-28 text-center text-white"
        style={{ background: `linear-gradient(135deg, ${branding.secondaryColor}, ${branding.primaryColor})` }}
      >
        <h1 className="text-4xl font-black tracking-tight">{branding.brandName}</h1>
        <p className="mx-auto mt-3 max-w-xl text-white/80">
          {branding.tagline ?? "B2B visa processing platform. Publish your homepage content from the admin control panel."}
        </p>
        <a href="/login" className="mt-8 inline-block bg-white px-6 py-2.5 text-sm font-bold shadow" style={{ color: branding.secondaryColor, borderRadius: 8 }}>
          Agency portal sign in
        </a>
      </section>
    );
  }

  return (
    <>
      {sections.map((s) => (
        <RenderSection key={s.id} section={s} branding={branding} />
      ))}
    </>
  );
}
