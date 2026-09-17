import Link from "next/link";
import type { HomepageSectionView } from "@/lib/config-service";
import { getVisaCatalog, getActiveCountries, formatMoney, type VisaCatalogRow } from "@/lib/config-service";
import { and, eq } from "drizzle-orm";
import { getDb, visaFees } from "@/db";
import type { ResolvedBranding } from "@/lib/config-service";

/* ============================================================
 * Section renderer — every block on the public homepage comes
 * from homepage_sections + related catalog tables. Adding a
 * section type here enables a CMS block type; removing rows in
 * admin removes them from the site. No business copy is
 * hardcoded in JSX.
 * ============================================================ */

type SectionItem = { title: string; description?: string };

function itemsOf(section: HomepageSectionView): SectionItem[] {
  const raw = (section.config as { items?: unknown })?.items;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({ title: String(x.title ?? "").slice(0, 120), description: String(x.description ?? "").slice(0, 500) }))
    .slice(0, 12);
}

function SectionHeading({ eyebrow, title, subtitle }: { eyebrow?: string; title: string | null; subtitle: string | null }) {
  return (
    <div className="mx-auto mb-10 max-w-2xl text-center">
      {eyebrow ? (
        <p className="mb-2 text-xs font-bold uppercase tracking-[0.25em] text-[var(--color-brand-primary)]">{eyebrow}</p>
      ) : null}
      {title ? <h2 className="text-3xl font-bold tracking-tight md:text-4xl" style={{ color: "var(--color-brand-secondary)" }}>{title}</h2> : null}
      {subtitle ? <p className="mt-3 text-slate-500">{subtitle}</p> : null}
    </div>
  );
}

async function DestinationsBlock() {
  const [catalog, countries] = await Promise.all([getVisaCatalog().catch(() => []), getActiveCountries().catch(() => [])]);
  const byCountry = new Map<string, VisaCatalogRow[]>();
  for (const v of catalog) {
    const key = v.countryCode.toUpperCase();
    if (!byCountry.has(key)) byCountry.set(key, []);
    byCountry.get(key)!.push(v);
  }
  const countriesWithVisas = countries.filter((c) => byCountry.has(c.code.toUpperCase())).slice(0, 12);
  const db = await getDb();
  const featuredFee = new Map<string, { cents: number; currency: string }>();
  for (const c of countriesWithVisas) {
    const types = byCountry.get(c.code.toUpperCase()) ?? [];
    for (const t of types) {
      const rows = await db
        .select({ amountCents: visaFees.amountCents, currencyCode: visaFees.currencyCode })
        .from(visaFees)
        .where(and(eq(visaFees.visaTypeId, t.id), eq(visaFees.feeType, "SERVICE_FEE"), eq(visaFees.isActive, true)))
        .limit(1);
      const row = rows[0];
      if (row && (!featuredFee.has(c.code) || row.amountCents < featuredFee.get(c.code)!.cents)) {
        featuredFee.set(c.code, { cents: row.amountCents, currency: row.currencyCode });
      }
    }
  }

  if (countriesWithVisas.length === 0) {
    return <p className="text-center text-sm text-slate-400">Destinations will appear here once visa types are configured.</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {countriesWithVisas.map((c) => {
        const types = byCountry.get(c.code.toUpperCase()) ?? [];
        const fee = featuredFee.get(c.code);
        return (
          <div key={c.code} className="card p-4 transition-shadow hover:shadow-md">
            <p className="text-2xl font-black" style={{ color: "var(--color-brand-secondary)" }}>
              {c.code}
            </p>
            <p className="mt-1 text-sm font-semibold">{c.name}</p>
            <p className="mt-1 text-xs text-slate-500">{types.length} visa {types.length === 1 ? "route" : "routes"}</p>
            {fee ? (
              <p className="mt-2 text-xs font-semibold" style={{ color: "var(--color-brand-primary)" }}>
                from {formatMoney(fee.cents, fee.currency)} service
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export async function RenderSection({ section, branding }: { section: HomepageSectionView; branding: ResolvedBranding | null }) {
  switch (section.sectionType) {
    case "hero": {
      const overlay = Math.min(Math.max(section.overlayOpacity ?? 45, 0), 100) / 100;
      return (
        <section className="relative overflow-hidden">
          <div
            className="relative px-4 py-24 text-center text-white md:py-32"
            style={{
              background: section.imageUrl
                ? `linear-gradient(rgba(19,49,92,${overlay}), rgba(19,49,92,${overlay})), url(${section.imageUrl}) center/cover no-repeat`
                : `linear-gradient(135deg, var(--color-brand-secondary) 0%, var(--color-brand-primary) 100%)`,
            }}
          >
            <div className="mx-auto max-w-3xl">
              {section.subtitle ? (
                <p className="mb-3 text-xs font-bold uppercase tracking-[0.3em] text-white/80">{section.subtitle}</p>
              ) : null}
              <h1 className="text-4xl font-black leading-tight tracking-tight md:text-5xl">{section.title}</h1>
              {section.body ? <p className="mx-auto mt-4 max-w-2xl text-white/85">{section.body}</p> : null}
              {section.ctaLabel && section.ctaHref ? (
                <div className="mt-8">
                  <Link
                    href={section.ctaHref}
                    className="inline-block px-7 py-3 text-sm font-bold text-slate-900 shadow-lg transition-transform hover:scale-[1.02]"
                    style={{ background: "var(--color-brand-accent)", borderRadius: branding?.buttonStyle === "pill" ? 999 : branding?.buttonStyle === "square" ? 0 : 10 }}
                  >
                    {section.ctaLabel}
                  </Link>
                </div>
              ) : null}
            </div>
          </div>
        </section>
      );
    }
    case "services": {
      const items = itemsOf(section);
      return (
        <section className="mx-auto max-w-6xl px-4 py-16 md:px-6">
          <SectionHeading title={section.title} subtitle={section.subtitle} />
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {items.map((it, i) => (
              <div key={i} className="card p-5">
                <div className="mb-3 grid h-9 w-9 place-items-center rounded-lg text-sm font-black text-white" style={{ background: "var(--color-brand-primary)" }}>
                  {String(i + 1)}
                </div>
                <h3 className="font-bold">{it.title}</h3>
                {it.description ? <p className="mt-1.5 text-sm text-slate-500">{it.description}</p> : null}
              </div>
            ))}
          </div>
        </section>
      );
    }
    case "destinations":
      return (
        <section className="bg-white/60 px-4 py-16">
          <div className="mx-auto max-w-6xl">
            <SectionHeading title={section.title} subtitle={section.subtitle} />
            <DestinationsBlock />
          </div>
        </section>
      );
    case "process": {
      const items = itemsOf(section);
      return (
        <section className="mx-auto max-w-6xl px-4 py-16 md:px-6">
          <SectionHeading title={section.title} subtitle={section.subtitle} />
          <ol className="grid gap-6 md:grid-cols-5">
            {items.map((it, i) => (
              <li key={i} className="relative">
                <div className="mb-2 grid h-10 w-10 place-items-center rounded-full text-lg font-black text-white" style={{ background: "var(--color-brand-secondary)" }}>
                  {i + 1}
                </div>
                <h3 className="font-bold">{it.title}</h3>
                {it.description ? <p className="mt-1 text-xs text-slate-500">{it.description}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      );
    }
    case "why": {
      const items = itemsOf(section);
      return (
        <section className="px-4 py-16" style={{ background: "var(--color-brand-secondary)" }}>
          <div className="mx-auto max-w-6xl">
            <div className="mx-auto mb-10 max-w-2xl text-center">
              {section.title ? <h2 className="text-3xl font-bold text-white md:text-4xl">{section.title}</h2> : null}
              {section.subtitle ? <p className="mt-3 text-white/70">{section.subtitle}</p> : null}
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {items.map((it, i) => (
                <div key={i} className="rounded-xl border border-white/10 bg-white/5 p-5">
                  <h3 className="font-bold text-white">{it.title}</h3>
                  {it.description ? <p className="mt-1.5 text-sm text-white/70">{it.description}</p> : null}
                </div>
              ))}
            </div>
          </div>
        </section>
      );
    }
    case "cta":
      return (
        <section className="px-4 py-16">
          <div
            className="mx-auto max-w-4xl rounded-2xl px-8 py-12 text-center text-white shadow-xl"
            style={{ background: "linear-gradient(120deg, var(--color-brand-primary), var(--color-brand-secondary))" }}
          >
            <h2 className="text-2xl font-bold md:text-3xl">{section.title}</h2>
            {section.body ? <p className="mx-auto mt-3 max-w-xl text-white/85">{section.body}</p> : null}
            {section.ctaLabel && section.ctaHref ? (
              <Link href={section.ctaHref} className="mt-6 inline-block bg-white px-6 py-2.5 text-sm font-bold shadow" style={{ color: "var(--color-brand-secondary)", borderRadius: branding?.buttonStyle === "pill" ? 999 : 8 }}>
                {section.ctaLabel}
              </Link>
            ) : null}
          </div>
        </section>
      );
    default:
      // Unknown section types from a future CMS release still render gracefully.
      return (
        <section className="mx-auto max-w-3xl px-4 py-10 text-center">
          {section.title ? <h2 className="text-2xl font-bold">{section.title}</h2> : null}
          {section.body ? <p className="mt-2 text-slate-600">{section.body}</p> : null}
        </section>
      );
  }
}
