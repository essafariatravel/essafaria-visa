import Link from "next/link";
import { getBranding, getNavItems, getSetting } from "@/lib/config-service";
import { SiteMark } from "@/components/site/mark";

export const dynamic = "force-dynamic";

interface ContactLike {
  "contact.email"?: string;
  "contact.phone"?: string;
  "contact.address"?: string;
  "contact.city"?: string;
  "contact.businessHours"?: string;
  "social.facebook"?: string | null;
  "social.instagram"?: string | null;
  "social.linkedin"?: string | null;
  "company.name"?: string;
}

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const [branding, headerNav, footerNav, contact] = await Promise.all([
    getBranding().catch(() => null),
    getNavItems("HEADER").catch(() => []),
    getNavItems("FOOTER").catch(() => []),
    (async () => {
      const db: ContactLike = {};
      for (const key of [
        "contact.email",
        "contact.phone",
        "contact.address",
        "contact.city",
        "contact.businessHours",
        "social.facebook",
        "social.instagram",
        "social.linkedin",
        "company.name",
      ] as const) {
        (db as Record<string, unknown>)[key] = await getSetting<string>(key, "");
      }
      return db;
    })().catch(() => ({}) as ContactLike),
  ]);

  const activeHeader = headerNav.filter((n) => n.isActive);
  const activeFooter = footerNav.filter((n) => n.isActive);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-4 md:px-6">
          <SiteMark branding={branding} />
          <nav className="hidden items-center gap-6 md:flex">
            {activeHeader.map((n) => (
              <Link key={n.id} href={n.href} className="text-sm font-medium text-slate-600 transition-colors hover:text-[var(--color-brand-primary)]">
                {n.label}
              </Link>
            ))}
          </nav>
          <Link href="/login" className="btn-brand !px-4 !py-2 text-sm">
            Agency Portal
          </Link>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="mt-16 text-slate-300" style={{ background: "var(--color-brand-secondary)" }}>
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 md:grid-cols-3 md:px-6">
          <div>
            <SiteMark branding={branding} light />
            <p className="mt-3 max-w-xs text-sm opacity-70">{branding?.tagline ?? ""}</p>
            <div className="mt-4 flex gap-3 text-xs">
              {(
                [
                  ["facebook", contact["social.facebook"]],
                  ["instagram", contact["social.instagram"]],
                  ["linkedin", contact["social.linkedin"]],
                ] as const
              )
                .filter(([, url]) => !!url)
                .map(([name, url]) => (
                  <a key={name} href={url as string} target="_blank" rel="noopener noreferrer nofollow" className="rounded-full border border-white/25 px-3 py-1 uppercase tracking-wide hover:bg-white/10">
                    {name}
                  </a>
                ))}
            </div>
          </div>
          <div>
            <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-slate-400">Company</p>
            <ul className="space-y-1.5 text-sm">
              {activeFooter.map((n) => (
                <li key={n.id}>
                  <Link href={n.href} className="opacity-80 hover:opacity-100 hover:underline">
                    {n.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-slate-400">Contact</p>
            <ul className="space-y-1.5 text-sm opacity-80">
              {contact["contact.address"] ? <li>{contact["contact.address"]}</li> : null}
              {contact["contact.city"] ? <li>{contact["contact.city"]}</li> : null}
              {contact["contact.phone"] ? (
                <li>
                  <a href={`tel:${contact["contact.phone"]}`}>{contact["contact.phone"]}</a>
                </li>
              ) : null}
              {contact["contact.email"] ? (
                <li>
                  <a href={`mailto:${contact["contact.email"]}`} className="underline decoration-white/30">
                    {contact["contact.email"]}
                  </a>
                </li>
              ) : null}
              {contact["contact.businessHours"] ? <li className="text-xs opacity-75">{contact["contact.businessHours"]}</li> : null}
            </ul>
          </div>
        </div>
        <div className="border-t border-white/10 py-4 text-center text-xs text-slate-400">
          © {new Date().getFullYear()} {contact["company.name"] ?? branding?.companyName ?? "ESSAFARIA TRAVEL"} — all rights reserved.
        </div>
      </footer>
    </div>
  );
}
