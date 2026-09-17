import Link from "next/link";
import { getSessionUser } from "@/lib/session";
import { getBranding } from "@/lib/config-service";
import { unreadCounts } from "@/lib/notifications";
import { SiteMark } from "@/components/site/mark";
import { LogoutForm } from "@/app/admin/logout-form";
import { can } from "@/lib/rbac";

export const dynamic = "force-dynamic";

/**
 * B2B portal chrome. No agency identifier appears in any href: every route here
 * resolves the tenant from the session, so a partner cannot reach another
 * partner's data by editing a URL.
 */
export default async function AgencyLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  const branding = await getBranding().catch(() => null);
  const unread = user ? await unreadCounts(user.id).catch(() => ({ total: 0, actionRequired: 0 })) : { total: 0, actionRequired: 0 };
  const nav = [
    { href: "/agency", label: "Dashboard" },
    { href: "/agency/applications", label: "Applications" },
    { href: "/agency/wallet", label: "Wallet & invoices" },
    { href: "/agency/inbox", label: unread.total ? `Inbox (${unread.total})` : "Inbox" },
    ...(user && can(user.role, "agencies.users.manage") ? [{ href: "/agency/team", label: "Team" }] : []),
  ];

  return (
    <div className="min-h-screen" style={{ background: "var(--color-brand-background)" }}>
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-4">
            <SiteMark branding={branding} />
            <span className="hidden text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400 sm:inline">
              Partner portal
            </span>
          </div>
          <nav className="flex items-center gap-1 overflow-x-auto">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900">
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-xs text-slate-500 md:inline">{user?.name}</span>
            <LogoutForm />
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-8">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-sm">
          Skip to content
        </a>
        {children}
      </main>
    </div>
  );
}
